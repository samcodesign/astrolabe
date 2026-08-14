//! Fetching and reporting the vendored Path of Building data.
//!
//! The engine cannot run without PoB's game data, and that data cannot ship in
//! the installer: the checkout is 1.9 GB and goes stale the moment GGG changes
//! the tree. Instead the app fetches it on first run and tracks upstream from
//! there, which is also what makes league-day updates arrive on their own — the
//! PoB maintainers do the extraction and we follow their manifest.
//!
//! The work itself lives in the `pob-updater` binary, driven here as a
//! subprocess. It is a sidecar for the same reasons `engine-host` is: the heavy
//! dependencies stay out of the app, and the thing doing the work is separately
//! testable and separately runnable.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::treedata;

/// Emitted for every line the updater writes. The payload is its own event
/// object, passed through unchanged — the shell does not reinterpret progress.
pub const PROGRESS_EVENT: &str = "pob-data://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    /// True when the engine has something to load.
    pub ready: bool,
    /// The resolved root, if any.
    pub root: Option<String>,
    /// Where the managed copy goes, whether or not it exists yet.
    pub managed_root: Option<String>,
    /// True when the resolved root *is* the managed copy, i.e. ours to update.
    pub managed: bool,
    /// False when `POB_PATH` or a dev checkout is in use — updating those would
    /// modify a directory the user controls, which is not ours to do.
    pub updatable: bool,
    /// Manifest version last applied, from the updater's own state.
    pub version: Option<String>,
    /// Upstream commit last applied.
    pub commit: Option<String>,
    /// True when the updater binary was found; without it, no first run.
    pub updater_available: bool,
}

/// What an upstream check found.
///
/// `None` from [`check`] means there is nothing to check against — no managed
/// copy, or no updater — which is different from "checked and up to date".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub files: u64,
    pub deletes: u64,
    /// Download size where GitHub reported it; 0 when unknown.
    pub bytes: u64,
    pub local_version: Option<String>,
    pub remote_version: Option<String>,
    /// The tree versions this copy is vendoring, so an update pulls the same
    /// set rather than silently narrowing it to whatever the default is today.
    pub tree_versions: Vec<String>,
}

/// The tree versions upstream offers, newest first.
///
/// Asked of the updater rather than hardcoded: a literal like `"3_29"` is wrong
/// the day the next league ships, and a fresh install would then vendor a tree
/// nobody is playing.
///
/// No workspace needed, which is the point — this runs before the first install
/// has created one.
pub fn tree_versions(app: &AppHandle) -> Result<Vec<String>, String> {
    let exe = resolve_updater_exe(app)
        .ok_or_else(|| "could not find the pob-updater binary".to_string())?;
    let out = Command::new(&exe)
        .arg("versions")
        .arg("--json")
        .output()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    if !out.status.success() {
        return Err(format!(
            "could not list the available tree versions: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("could not read the updater's report: {e}"))?;
    Ok(v.get("tree_versions")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// Ask upstream whether the vendored copy is behind.
///
/// `pob-updater check` trusts the local manifest instead of re-hashing 619
/// files, so this is a manifest fetch and a diff — cheap enough to run in the
/// background once the app is usable.
pub fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let (Some(exe), Some(root)) = (resolve_updater_exe(app), treedata::managed_root(app)) else {
        return Ok(None);
    };
    if !root.join(".pob-updater").join("config.toml").is_file() {
        // Never installed here, so there is no selection to diff against.
        return Ok(None);
    }

    let out = Command::new(&exe)
        .arg("check")
        .arg("--root")
        .arg(&root)
        .arg("--json")
        .output()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    if !out.status.success() {
        return Err(format!(
            "checking for game data updates failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("could not read the updater's report: {e}"))?;
    let num = |k: &str| v.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
    let text = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };

    let files = num("updates");
    let deletes = num("deletes");
    Ok(Some(UpdateInfo {
        available: files > 0 || deletes > 0,
        files,
        deletes,
        bytes: num("bytes"),
        local_version: text("local_version"),
        remote_version: text("remote_version"),
        tree_versions: v
            .get("tree_versions")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    }))
}

/// Where the updater keeps its metadata, mirroring `state::Workspace`.
fn read_applied(root: &std::path::Path) -> (Option<String>, Option<String>) {
    let path = root.join(".pob-updater").join("state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return (None, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (None, None);
    };
    (
        v.get("applied_version")
            .and_then(|s| s.as_str())
            .map(str::to_string),
        v.get("applied_commit")
            .and_then(|s| s.as_str())
            .map(str::to_string),
    )
}

/// The updater binary, searched the same way as the engine sidecar.
pub fn resolve_updater_exe(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "pob-updater.exe"
    } else {
        "pob-updater"
    };

    let mut tried: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        tried.push(dir.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            tried.push(dir.join(name));
        }
    }
    // Repo layout: <root>/src-tauri → <root>/tools/updater/target/<profile>/
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        for profile in ["release", "debug"] {
            tried.push(
                root.join("tools")
                    .join("updater")
                    .join("target")
                    .join(profile)
                    .join(name),
            );
        }
    }
    tried.into_iter().find(|p| p.is_file())
}

pub fn status(app: &AppHandle) -> DataStatus {
    let resolved = treedata::resolve_pob_root(app);
    let managed = treedata::managed_root(app);
    let is_managed = match (&resolved, &managed) {
        (Some(r), Some(m)) => r == m,
        _ => false,
    };
    // Read state from wherever the workspace actually is, so a dev checkout
    // that happens to have been vendored still reports its version.
    let (version, commit) = resolved
        .as_deref()
        .map(read_applied)
        .unwrap_or((None, None));

    DataStatus {
        ready: resolved.as_deref().is_some_and(treedata::is_usable),
        root: resolved.as_ref().map(|p| p.display().to_string()),
        managed_root: managed.as_ref().map(|p| p.display().to_string()),
        managed: is_managed,
        // Nothing is resolved yet, or the resolved copy is the managed one.
        // A `POB_PATH` or dev checkout is the user's, and we do not write to it.
        updatable: resolved.is_none() || is_managed,
        version,
        commit,
        updater_available: resolve_updater_exe(app).is_some(),
    }
}

/// Create the managed workspace and pull the data, streaming progress.
///
/// Blocking, and meant to be called off the UI thread — Tauri runs commands on
/// a worker, and the caller follows [`PROGRESS_EVENT`] rather than the return
/// value for anything but the final outcome.
pub fn install(app: &AppHandle, tree_versions: Vec<String>) -> Result<DataStatus, String> {
    let exe = resolve_updater_exe(app)
        .ok_or_else(|| "could not find the pob-updater binary".to_string())?;
    let root = treedata::managed_root(app)
        .ok_or_else(|| "could not determine the application data directory".to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;

    // `init` is idempotent — it loads an existing workspace rather than
    // clobbering it — so this is also the resume path for an interrupted first
    // run, which is exactly when it matters.
    let mut init = Command::new(&exe);
    init.arg("init").arg("--root").arg(&root);
    if !tree_versions.is_empty() {
        init.arg("--tree").arg(tree_versions.join(","));
    }
    let out = init
        .output()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    if !out.status.success() {
        return Err(format!(
            "preparing the data directory failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let mut child = Command::new(&exe)
        .arg("update")
        .arg("--root")
        .arg(&root)
        .arg("--progress-json")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let _ = app.emit(PROGRESS_EVENT, value);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("the updater did not exit cleanly: {e}"))?;
    if !status.success() {
        let mut detail = String::new();
        if let Some(mut err) = child.stderr.take() {
            use std::io::Read;
            let _ = err.read_to_string(&mut detail);
        }
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            "the data download failed".to_string()
        } else {
            detail.lines().last().unwrap_or(detail).to_string()
        });
    }

    Ok(status_after_install(app))
}

/// Re-resolve and publish the new root.
///
/// The directory did not exist when the app started, so the value cached in
/// `PobRoot` and in the supervisor is stale by construction. Both have to be
/// told, and they have to be told the *same* thing — the asset route serves art
/// from one and the engine loads sheets from the other, and a disagreement
/// shows up as missing sprites with nothing logged.
fn status_after_install(app: &AppHandle) -> DataStatus {
    let resolved = treedata::resolve_pob_root(app);
    if let Some(root) = app.try_state::<treedata::PobRoot>() {
        root.set(resolved.clone());
    }
    if let Some(sup) = app.try_state::<std::sync::Arc<crate::supervisor::Supervisor>>() {
        sup.set_pob_root(resolved);
    }
    status(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_state_is_read_from_the_updater_workspace() {
        let dir = std::env::temp_dir().join(format!("pobdata-test-{}", std::process::id()));
        let meta = dir.join(".pob-updater");
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("state.json"),
            r#"{"applied_version":"2.67.2","applied_commit":"abc123"}"#,
        )
        .unwrap();

        let (version, commit) = read_applied(&dir);
        assert_eq!(version.as_deref(), Some("2.67.2"));
        assert_eq!(commit.as_deref(), Some("abc123"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_directory_with_no_workspace_reports_nothing_rather_than_failing() {
        let (version, commit) = read_applied(std::path::Path::new("Z:/definitely/not/here"));
        assert!(version.is_none());
        assert!(commit.is_none());
    }
}
