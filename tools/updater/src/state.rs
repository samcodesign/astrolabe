//! On-disk configuration and pin state for a vendored PoB copy.
//!
//! Everything the updater owns lives under `<root>/.pob-updater/`, on the same
//! volume as the vendored tree so that staging -> live moves are cheap renames:
//!
//! ```text
//! <root>/
//!   manifest.xml            <- vendored manifest (the local side of the diff)
//!   src/ runtime/ ...       <- vendored payload
//!   .pob-updater/
//!     config.toml           <- repo, ref, selection, concurrency
//!     state.json            <- pin + last check/update bookkeeping
//!     cache/                <- ETag-keyed response cache
//!     txn/<id>/             <- in-flight transaction (staging, backup, journal)
//! ```

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const META_DIR: &str = ".pob-updater";
pub const DEFAULT_REPO: &str = "PathOfBuildingCommunity/PathOfBuilding";
/// The branch `manifest.xml` actually describes.
///
/// Not `dev`. The manifest is a release artefact: its SHA1s are the CRLF-hashed
/// bytes of the files on `master`, and it is refreshed when a version ships, not
/// on every commit. Point this at `dev` and the binary assets still verify —
/// they rarely change — while every `.lua` file that has moved since the last
/// release fails its hash. That reads exactly like a line-ending bug and is not
/// one: 135 of 402 files, all Lua.
///
/// PoB itself never hits this because it substitutes `{branch}` from the
/// `branch` attribute of the *installed* manifest (`UpdateCheck.lua:110,135`),
/// which a release build stamps. The copy in the repository is a template and
/// carries no branch at all, so a fresh vendoring has to supply one.
pub const DEFAULT_BRANCH: &str = "master";
pub const DEFAULT_PLATFORM: &str = "win32";

pub fn default_user_agent() -> String {
    format!(
        "poe-planner-pob-updater/{} (+https://github.com/PathOfBuildingCommunity/PathOfBuilding; vendoring PoB game data)",
        env!("CARGO_PKG_VERSION")
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// `owner/name` on GitHub.
    pub repo: String,
    /// Branch to follow when not pinned.
    pub branch: String,
    /// Platform used for `<Source platform>` / `<File platform>` resolution.
    pub platform: String,
    /// Manifest parts to vendor.
    pub parts: Vec<String>,
    /// Tree versions to vendor; `None` (absent) means all of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree_versions: Option<Vec<String>>,
    /// Repo-relative paths to fetch that the manifest does not list.
    ///
    /// The manifest describes a *release*, and a release is the desktop client.
    /// `src/HeadlessWrapper.lua` is not in it — zero entries — because it exists
    /// only to let CI drive the engine without a UI, which is exactly what we do
    /// too. Without it the vendored copy has no entry point and the sidecar
    /// cannot boot at all.
    ///
    /// Fetched from the same ref as everything else so it stays in lockstep with
    /// the sources it wraps. There is no manifest hash to check these against;
    /// the hash of what arrived is recorded so a later run can tell it changed.
    #[serde(default = "default_extra_files")]
    pub extra_files: Vec<String>,
    pub concurrency: usize,
    pub user_agent: String,
    /// Attempts per file before giving up (upstream uses 5).
    pub max_attempts: u32,
}

/// What the engine needs to boot, and nothing else.
///
/// `program` is the Lua sources, `tree` the passive tree data, and `runtime` the
/// pure-Lua libraries `bootstrap.lua` puts on `package.path` — dkjson, base64,
/// sha1. `default` is only LICENSE/changelog/help, and is left out: it is not
/// loaded by anything.
///
/// `tree` is still scoped by `tree_versions`, because all of it is 554 MB across
/// 100+ historical versions.
pub fn default_parts() -> Vec<String> {
    vec!["program".into(), "tree".into(), "runtime".into()]
}

pub fn default_extra_files() -> Vec<String> {
    vec!["src/HeadlessWrapper.lua".into()]
}

impl Default for Config {
    fn default() -> Self {
        Config {
            repo: DEFAULT_REPO.into(),
            branch: DEFAULT_BRANCH.into(),
            platform: DEFAULT_PLATFORM.into(),
            parts: default_parts(),
            tree_versions: None,
            extra_files: default_extra_files(),
            concurrency: 8,
            user_agent: default_user_agent(),
            max_attempts: 5,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// Commit SHA we are pinned to. `None` = follow `config.branch`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_commit: Option<String>,
    /// Commit SHA the vendored tree was last fetched from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_commit: Option<String>,
    /// `<Version number>` of the vendored manifest at last update.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_update: Option<u64>,
    /// `config.extra_files` path -> SHA1 of what was installed.
    ///
    /// These have no manifest entry to diff against, so this is the only record
    /// that they are present and which revision of them we hold.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra_file_sha1: BTreeMap<String, String>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn format_ts(secs: Option<u64>) -> String {
    match secs {
        None => "never".to_string(),
        Some(s) => {
            let t = UNIX_EPOCH + std::time::Duration::from_secs(s);
            humantime::format_rfc3339_seconds(t).to_string()
        }
    }
}

/// A vendored copy of PoB plus the updater's own metadata.
pub struct Workspace {
    pub root: PathBuf,
    pub config: Config,
    pub state: State,
}

impl Workspace {
    pub fn meta_dir(&self) -> PathBuf {
        self.root.join(META_DIR)
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.meta_dir().join("cache")
    }
    pub fn txn_dir(&self) -> PathBuf {
        self.meta_dir().join("txn")
    }
    pub fn config_path(&self) -> PathBuf {
        self.meta_dir().join("config.toml")
    }
    pub fn state_path(&self) -> PathBuf {
        self.meta_dir().join("state.json")
    }
    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.xml")
    }

    pub fn exists(root: &Path) -> bool {
        root.join(META_DIR).join("config.toml").is_file()
    }

    /// Load an existing workspace. Fails if it was never initialised.
    pub fn open(root: &Path) -> Result<Workspace> {
        let root = absolutize(root);
        let cfg_path = root.join(META_DIR).join("config.toml");
        let cfg_text = std::fs::read_to_string(&cfg_path).with_context(|| {
            format!(
                "no vendored PoB workspace at {}\n  (run `pob-updater init --root {}` first)",
                root.display(),
                root.display()
            )
        })?;
        let config: Config = toml::from_str(&cfg_text)
            .with_context(|| format!("could not parse {}", cfg_path.display()))?;

        let state_path = root.join(META_DIR).join("state.json");
        let state = match std::fs::read_to_string(&state_path) {
            Ok(t) => serde_json::from_str(&t)
                .with_context(|| format!("could not parse {}", state_path.display()))?,
            Err(_) => State::default(),
        };
        Ok(Workspace { root, config, state })
    }

    /// Create a workspace, or load it if one is already there.
    pub fn init(root: &Path, config: Config) -> Result<Workspace> {
        let root = absolutize(root);
        std::fs::create_dir_all(root.join(META_DIR).join("cache"))
            .with_context(|| format!("could not create {}", root.join(META_DIR).display()))?;
        std::fs::create_dir_all(root.join(META_DIR).join("txn"))?;
        let ws = Workspace {
            root,
            config,
            state: State::default(),
        };
        if !ws.config_path().exists() {
            ws.save_config()?;
        }
        if !ws.state_path().exists() {
            ws.save_state()?;
        }
        Ok(ws)
    }

    pub fn save_config(&self) -> Result<()> {
        std::fs::create_dir_all(self.meta_dir())?;
        let text = toml::to_string_pretty(&self.config)?;
        write_atomic(&self.config_path(), text.as_bytes())
    }

    pub fn save_state(&self) -> Result<()> {
        std::fs::create_dir_all(self.meta_dir())?;
        let text = serde_json::to_string_pretty(&self.state)?;
        write_atomic(&self.state_path(), text.as_bytes())
    }

    /// The git ref every URL resolves against: the pin if set, else the branch.
    pub fn git_ref(&self) -> String {
        self.state
            .pinned_commit
            .clone()
            .unwrap_or_else(|| self.config.branch.clone())
    }

    pub fn is_pinned(&self) -> bool {
        self.state.pinned_commit.is_some()
    }

    /// Vendored manifest, if one has been written yet.
    pub fn local_manifest(&self) -> Result<Option<crate::manifest::Manifest>> {
        let p = self.manifest_path();
        if !p.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&p)
            .with_context(|| format!("could not read {}", p.display()))?;
        Ok(Some(crate::manifest::Manifest::parse(&text).with_context(
            || format!("could not parse local manifest {}", p.display()),
        )?))
    }
}

fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|c| c.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    }
}

/// Write via a temp file + rename so a crash never leaves a truncated file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp{}",
        std::process::id() as u64 ^ now_secs().rotate_left(7)
    ));
    std::fs::write(&tmp, bytes).with_context(|| format!("could not write {}", tmp.display()))?;
    // Windows will not rename onto an existing file.
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("could not move {} into place", tmp.display()))?;
    Ok(())
}
