//! Diffing a local manifest against a remote one to produce an update plan.
//!
//! Mirrors the logic in `UpdateCheck.lua`:
//!   * a remote file whose SHA1 differs from the local manifest is an update;
//!   * a remote file the local manifest knows about but which is missing on
//!     disk is an update ("it will be re-downloaded");
//!   * a remote file present on disk whose contents fail the SHA1 check
//!     (including the CRLF fallbacks) is an update ("integrity check failed");
//!   * a local file absent from the remote manifest is a delete.
//!
//! Everything is scoped by [`Selection`], so a `program`-only run never proposes
//! deleting the 554 MB of tree data we deliberately did not vendor.

use crate::hash;
use crate::manifest::{FileEntry, Manifest};
use crate::selector::Selection;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Not in the local manifest at all.
    New,
    /// Present locally with a different SHA1.
    ShaChanged,
    /// Manifest says we have it; the file is not on disk.
    MissingLocally,
    /// On disk but its contents do not hash to the expected value.
    Corrupt,
}

impl Reason {
    pub fn label(self) -> &'static str {
        match self {
            Reason::New => "new",
            Reason::ShaChanged => "changed",
            Reason::MissingLocally => "missing",
            Reason::Corrupt => "corrupt",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Change {
    pub entry: FileEntry,
    pub reason: Reason,
    /// Repo-relative path, e.g. `src/Data/Uniques/axe.lua`. Used for the
    /// download URL and for looking up sizes from the git tree API.
    pub repo_path: String,
    /// Absolute destination inside the vendored root.
    pub dest: PathBuf,
    /// Byte size, if we were able to resolve it.
    pub size: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Removal {
    pub entry: FileEntry,
    pub dest: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub updates: Vec<Change>,
    pub deletes: Vec<Removal>,
    /// Selected files that are already correct.
    pub unchanged: usize,
    /// Files we re-hashed from disk (0 unless `verify_local`).
    pub verified: usize,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.updates.is_empty() && self.deletes.is_empty()
    }

    pub fn known_bytes(&self) -> u64 {
        self.updates.iter().filter_map(|c| c.size).sum()
    }

    pub fn unknown_size_count(&self) -> usize {
        self.updates.iter().filter(|c| c.size.is_none()).count()
    }

    pub fn counts_by_reason(&self) -> BTreeMap<&'static str, usize> {
        let mut m = BTreeMap::new();
        for c in &self.updates {
            *m.entry(c.reason.label()).or_insert(0) += 1;
        }
        m
    }
}

/// Absolute on-disk location of a manifest entry inside `root`.
pub fn dest_path(root: &Path, manifest: &Manifest, entry: &FileEntry, platform: &str) -> PathBuf {
    let sub = manifest.part_subdir(&entry.part, platform);
    let mut p = root.to_path_buf();
    if !sub.is_empty() {
        p.push(sub);
    }
    for seg in entry.rel_path().split('/') {
        p.push(seg);
    }
    p
}

/// Repo-relative path, i.e. what follows `{branch}/` in the download URL.
pub fn repo_path(manifest: &Manifest, entry: &FileEntry, platform: &str) -> String {
    let sub = manifest.part_subdir(&entry.part, platform);
    if sub.is_empty() {
        entry.rel_path()
    } else {
        format!("{sub}/{}", entry.rel_path())
    }
}

pub struct PlanInput<'a> {
    pub local: &'a Manifest,
    pub remote: &'a Manifest,
    pub selection: &'a Selection,
    pub root: &'a Path,
    /// Re-hash local files rather than trusting the local manifest. Slower, but
    /// it is the only way to notice a vendored file that was corrupted or
    /// hand-edited. `UpdateCheck.lua` always does this.
    pub verify_local: bool,
    /// Repo-relative path -> byte size, from the git tree API when available.
    pub sizes: &'a BTreeMap<String, u64>,
}

pub fn compute(input: &PlanInput<'_>) -> Plan {
    let PlanInput {
        local,
        remote,
        selection,
        root,
        verify_local,
        sizes,
    } = *input;

    let platform = selection.platform.as_str();
    let local_by_name = local.by_name();
    let mut plan = Plan::default();

    for entry in &remote.files {
        if !selection.includes(entry) {
            continue;
        }
        let dest = dest_path(root, remote, entry, platform);
        let repo_path = repo_path(remote, entry, platform);
        let size = sizes.get(&repo_path).copied();

        // `UpdateCheck.lua` also matches on the space-sanitised name, since an
        // older local manifest may have stored the decoded form.
        let sanitized = entry.rel_path();
        let local_entry = local_by_name
            .get(entry.name.as_str())
            .or_else(|| local_by_name.get(sanitized.as_str()));

        let reason = match local_entry {
            None => Some(Reason::New),
            Some(l) if l.sha1 != entry.sha1 => Some(Reason::ShaChanged),
            Some(_) => {
                // Manifests agree. Confirm the bytes on disk agree too.
                match std::fs::read(&dest) {
                    Err(_) => Some(Reason::MissingLocally),
                    Ok(bytes) => {
                        if verify_local {
                            plan.verified += 1;
                            if hash::verify(&entry.sha1, &bytes).is_match() {
                                None
                            } else {
                                Some(Reason::Corrupt)
                            }
                        } else {
                            None
                        }
                    }
                }
            }
        };

        match reason {
            None => plan.unchanged += 1,
            Some(reason) => plan.updates.push(Change {
                entry: entry.clone(),
                reason,
                repo_path,
                dest,
                size,
            }),
        }
    }

    let remote_by_name = remote.by_name();
    for entry in &local.files {
        if !selection.includes(entry) {
            continue;
        }
        let unsanitized = entry.name.replace(' ', "{space}");
        if remote_by_name.contains_key(entry.name.as_str())
            || remote_by_name.contains_key(unsanitized.as_str())
        {
            continue;
        }
        plan.deletes.push(Removal {
            dest: dest_path(root, local, entry, platform),
            entry: entry.clone(),
        });
    }

    plan.updates.sort_by(|a, b| a.repo_path.cmp(&b.repo_path));
    plan.deletes.sort_by(|a, b| a.entry.name.cmp(&b.entry.name));
    plan
}

/// The manifest to write after a successful update.
///
/// Because we vendor selectively, the new local manifest is
/// `(remote entries inside the selection)` plus `(existing local entries outside
/// it)`. Dropping the latter would make a `program`-only update look like it had
/// deleted every tree file we still have on disk.
pub fn merged_manifest(local: &Manifest, remote: &Manifest, selection: &Selection) -> Manifest {
    let mut files: Vec<FileEntry> = remote
        .files
        .iter()
        .filter(|f| selection.includes(f))
        .cloned()
        .collect();
    files.extend(
        local
            .files
            .iter()
            .filter(|f| !selection.includes(f))
            .cloned(),
    );
    files.sort_by(|a, b| (&a.part, &a.name).cmp(&(&b.part, &b.name)));
    files.dedup_by(|a, b| a.name == b.name && a.part == b.part);

    Manifest {
        version: remote.version.clone(),
        platform: local.platform.clone().or_else(|| remote.platform.clone()),
        branch: local.branch.clone().or_else(|| remote.branch.clone()),
        sources: remote.sources.clone(),
        files,
    }
}
