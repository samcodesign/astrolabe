//! Transactional application of an update.
//!
//! The guarantee: a network failure, a hash mismatch, or a hard kill must never
//! leave a half-updated tree. Two phases achieve that.
//!
//! **Staging** — every changed file is downloaded into
//! `.pob-updater/txn/<id>/staging/<sha1>.blob` and SHA1-verified there. All the
//! risk (network, disk full, bad bytes) lives in this phase, and the live tree
//! has not been touched at all. Aborting is `remove_dir_all`.
//!
//! Blobs are content-addressed, which buys two things: a crashed run can resume
//! and reuse anything already verified, and files that share a SHA1 (upstream
//! has real cases, e.g. `raider.jpeg` and `warden.jpeg`) are downloaded once.
//!
//! **Commit** — local renames only. For each op the current file is moved to
//! `backup/` first, then the staged blob is moved into place, and the completed
//! op is appended to `commit.log` (fsynced). If we die mid-commit, the next run
//! replays that log in reverse, restores the backups, and the tree is exactly as
//! it was. The new `manifest.xml` is deliberately the *last* op, so an
//! unrecoverable interruption still leaves a manifest describing the old state
//! rather than one promising files we do not have.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Phase {
    Staging,
    Committing,
    Done,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpKind {
    Install,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub kind: OpKind,
    pub dest: PathBuf,
    /// Staged blob file name (`<sha1>.blob`) for `Install`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub id: String,
    pub phase: Phase,
    pub ops: Vec<Op>,
}

pub struct Txn {
    pub dir: PathBuf,
    journal: Journal,
    /// Set once `commit` starts, so `Drop` does not wipe a committed txn.
    finished: bool,
}

impl Txn {
    pub fn staging(&self) -> PathBuf {
        self.dir.join("staging")
    }
    pub fn backup(&self) -> PathBuf {
        self.dir.join("backup")
    }
    fn journal_path(&self) -> PathBuf {
        self.dir.join("journal.json")
    }
    fn log_path(&self) -> PathBuf {
        self.dir.join("commit.log")
    }

    /// Start a transaction, reusing a previous interrupted staging directory if
    /// one is present so a resumed run does not re-download verified blobs.
    pub fn begin(txn_root: &Path) -> Result<Txn> {
        fs::create_dir_all(txn_root)?;
        if let Some(existing) = find_resumable(txn_root)? {
            let journal = read_journal(&existing)?;
            fs::create_dir_all(existing.join("staging"))?;
            fs::create_dir_all(existing.join("backup"))?;
            return Ok(Txn {
                dir: existing,
                journal: Journal {
                    ops: Vec::new(),
                    ..journal
                },
                finished: false,
            });
        }
        let id = format!(
            "{}-{}",
            crate::state::now_secs(),
            std::process::id()
        );
        let dir = txn_root.join(&id);
        fs::create_dir_all(dir.join("staging"))?;
        fs::create_dir_all(dir.join("backup"))?;
        let txn = Txn {
            journal: Journal {
                id,
                phase: Phase::Staging,
                ops: Vec::new(),
            },
            dir,
            finished: false,
        };
        txn.write_journal()?;
        Ok(txn)
    }

    fn write_journal(&self) -> Result<()> {
        let text = serde_json::to_string_pretty(&self.journal)?;
        crate::state::write_atomic(&self.journal_path(), text.as_bytes())
    }

    pub fn blob_path(&self, sha1: &str) -> PathBuf {
        self.staging().join(format!("{sha1}.blob"))
    }

    /// True if a blob for this SHA1 is already staged *and* still verifies.
    pub fn blob_ready(&self, sha1: &str) -> bool {
        let p = self.blob_path(sha1);
        match fs::read(&p) {
            Ok(bytes) => {
                if crate::hash::verify(sha1, &bytes).is_match() {
                    true
                } else {
                    let _ = fs::remove_file(&p);
                    false
                }
            }
            Err(_) => false,
        }
    }

    /// Write bytes to staging, refusing anything that fails the SHA1 check.
    pub fn stage(&self, sha1: &str, bytes: &[u8]) -> Result<crate::hash::HashMatch> {
        let m = crate::hash::verify(sha1, bytes);
        if !m.is_match() {
            bail!(
                "hash mismatch: expected {sha1}, got {}",
                crate::hash::sha1_hex(bytes)
            );
        }
        fs::create_dir_all(self.staging())?;
        fs::write(self.blob_path(sha1), bytes)
            .with_context(|| format!("could not stage blob {sha1}"))?;
        Ok(m)
    }

    pub fn push_install(&mut self, dest: PathBuf, sha1: &str) {
        self.journal.ops.push(Op {
            kind: OpKind::Install,
            dest,
            blob: Some(format!("{sha1}.blob")),
        });
    }

    pub fn push_delete(&mut self, dest: PathBuf) {
        self.journal.ops.push(Op {
            kind: OpKind::Delete,
            dest,
            blob: None,
        });
    }

    /// Apply every op. Local filesystem moves only — no network, no hashing.
    pub fn commit(mut self) -> Result<()> {
        self.journal.phase = Phase::Committing;
        self.write_journal()
            .context("could not record the commit journal")?;

        let mut log = fs::File::create(self.log_path())?;
        let backup_dir = self.backup();
        fs::create_dir_all(&backup_dir)?;

        // Distinct paths can share a SHA1 — upstream really does ship
        // `Assets/ascendants/raider.jpeg` and `warden.jpeg` byte-identical — and
        // content-addressed staging means they share one blob. Only the last
        // consumer may rename it away; earlier ones copy.
        let mut remaining: std::collections::HashMap<&str, usize> =
            std::collections::HashMap::new();
        for op in &self.journal.ops {
            if let Some(b) = &op.blob {
                *remaining.entry(b.as_str()).or_insert(0) += 1;
            }
        }

        for (idx, op) in self.journal.ops.iter().enumerate() {
            let backup_name = format!("{idx}.bak");
            let backup_path = backup_dir.join(&backup_name);
            let had_backup = if op.dest.exists() {
                if backup_path.exists() {
                    let _ = fs::remove_file(&backup_path);
                }
                fs::rename(&op.dest, &backup_path).with_context(|| {
                    format!("could not move {} aside", op.dest.display())
                })?;
                true
            } else {
                false
            };

            if op.kind == OpKind::Install {
                let blob = op
                    .blob
                    .as_ref()
                    .context("install op with no staged blob")?;
                if let Some(parent) = op.dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                let src = self.staging().join(blob);
                let left = remaining.get_mut(blob.as_str()).expect("counted above");
                *left -= 1;
                if *left == 0 {
                    fs::rename(&src, &op.dest)
                } else {
                    fs::copy(&src, &op.dest).map(|_| ())
                }
                .with_context(|| {
                    format!("could not move staged file into {}", op.dest.display())
                })?;
            }

            writeln!(log, "{idx} {}", if had_backup { "bak" } else { "new" })?;
            log.flush()?;
            log.sync_all()?;
        }
        drop(log);

        self.journal.phase = Phase::Done;
        self.write_journal()?;
        self.finished = true;
        let _ = fs::remove_dir_all(&self.dir);
        Ok(())
    }

    /// Discard the transaction; the live tree was never touched.
    pub fn abort(mut self) {
        self.finished = true;
        let _ = fs::remove_dir_all(&self.dir);
    }

    /// Keep the staging directory so the next run can resume it.
    pub fn keep_for_resume(mut self) {
        self.finished = true;
    }
}

impl Drop for Txn {
    fn drop(&mut self) {
        if !self.finished && self.journal.phase == Phase::Staging {
            // Panic or `?` bailout during staging: leave the blobs, they are
            // content-addressed and the next run will revalidate them.
        }
    }
}

fn read_journal(dir: &Path) -> Result<Journal> {
    let text = fs::read_to_string(dir.join("journal.json"))
        .with_context(|| format!("could not read journal in {}", dir.display()))?;
    serde_json::from_str(&text).with_context(|| format!("corrupt journal in {}", dir.display()))
}

fn find_resumable(txn_root: &Path) -> Result<Option<PathBuf>> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(txn_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        match read_journal(&dir) {
            Ok(j) if j.phase == Phase::Staging => candidates.push(dir),
            _ => {}
        }
    }
    candidates.sort();
    Ok(candidates.pop())
}

#[derive(Debug, Default)]
pub struct Recovery {
    pub rolled_back: usize,
    pub cleaned: usize,
    pub restored_files: usize,
}

/// Roll back any transaction that died mid-commit, and drop finished ones.
///
/// Called at the start of every command, so a crashed run self-heals on the next
/// invocation rather than silently leaving a mixed tree.
pub fn recover(txn_root: &Path) -> Result<Recovery> {
    let mut rec = Recovery::default();
    if !txn_root.is_dir() {
        return Ok(rec);
    }
    for entry in fs::read_dir(txn_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let journal = match read_journal(&dir) {
            Ok(j) => j,
            Err(_) => {
                // No readable journal means nothing was ever applied from it.
                let _ = fs::remove_dir_all(&dir);
                rec.cleaned += 1;
                continue;
            }
        };
        match journal.phase {
            // Nothing applied yet: keep it, `Txn::begin` will resume it.
            Phase::Staging => {}
            Phase::Done => {
                let _ = fs::remove_dir_all(&dir);
                rec.cleaned += 1;
            }
            Phase::Committing => {
                rec.restored_files += rollback(&dir, &journal)?;
                let _ = fs::remove_dir_all(&dir);
                rec.rolled_back += 1;
            }
        }
    }
    Ok(rec)
}

fn rollback(dir: &Path, journal: &Journal) -> Result<usize> {
    let log = fs::read_to_string(dir.join("commit.log")).unwrap_or_default();
    let mut completed: Vec<(usize, bool)> = Vec::new();
    for line in log.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(idx), Some(kind)) = (parts.next(), parts.next())
            && let Ok(idx) = idx.parse::<usize>()
        {
            completed.push((idx, kind == "bak"));
        }
    }

    let mut restored = 0;
    for (idx, had_backup) in completed.into_iter().rev() {
        let Some(op) = journal.ops.get(idx) else {
            continue;
        };
        // Undo the install (or the delete's removal) before restoring.
        if op.dest.exists() {
            let _ = fs::remove_file(&op.dest);
        }
        if had_backup {
            let backup = dir.join("backup").join(format!("{idx}.bak"));
            if backup.exists() {
                if let Some(parent) = op.dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(&backup, &op.dest).with_context(|| {
                    format!("rollback failed restoring {}", op.dest.display())
                })?;
                restored += 1;
            }
        }
    }
    Ok(restored)
}

/// Remove empty directories left behind by deletes, bottom-up, stopping at root.
pub fn prune_empty_dirs(root: &Path, mut dir: PathBuf) {
    while dir.starts_with(root) && dir != root {
        let empty = match fs::read_dir(&dir) {
            Ok(mut it) => it.next().is_none(),
            Err(_) => return,
        };
        if !empty || fs::remove_dir(&dir).is_err() {
            return;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return,
        }
    }
}
