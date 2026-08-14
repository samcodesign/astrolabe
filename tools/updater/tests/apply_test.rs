//! Transactional apply: staging, commit, resume, and crash rollback.
//!
//! The contract under test is the one the task cares about most — "network
//! failure mid-update must leave the local copy working and unchanged" — plus
//! the harder case of dying *during* the swap.

use pob_updater::apply::{self, Txn};
use pob_updater::hash::sha1_hex;
use std::fs;
use std::path::Path;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("src/a.lua"), "A v1");
        write(&dir.path().join("src/b.lua"), "B v1");
        write(&dir.path().join("manifest.xml"), "<old/>");
        Fixture { dir }
    }
    fn root(&self) -> &Path {
        self.dir.path()
    }
    fn txn_root(&self) -> std::path::PathBuf {
        self.dir.path().join(".pob-updater/txn")
    }
    fn at(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().join(rel)
    }
}

#[test]
fn commit_replaces_installs_and_removes_deletes() {
    let f = Fixture::new();
    let mut txn = Txn::begin(&f.txn_root()).unwrap();

    let a2 = "A v2";
    let sha_a = sha1_hex(a2.as_bytes());
    txn.stage(&sha_a, a2.as_bytes()).unwrap();
    txn.push_install(f.at("src/a.lua"), &sha_a);

    let c = "C new";
    let sha_c = sha1_hex(c.as_bytes());
    txn.stage(&sha_c, c.as_bytes()).unwrap();
    txn.push_install(f.at("src/new/c.lua"), &sha_c);

    txn.push_delete(f.at("src/b.lua"));

    txn.commit().unwrap();

    assert_eq!(read(&f.at("src/a.lua")), "A v2");
    assert_eq!(read(&f.at("src/new/c.lua")), "C new", "creates parent dirs");
    assert!(!f.at("src/b.lua").exists(), "delete applied");
    // A committed transaction cleans up after itself.
    assert_eq!(fs::read_dir(f.txn_root()).unwrap().count(), 0);
}

#[test]
fn staging_refuses_bytes_that_fail_the_hash() {
    let f = Fixture::new();
    let txn = Txn::begin(&f.txn_root()).unwrap();
    let err = txn.stage(&"0".repeat(40), b"whatever").unwrap_err();
    assert!(format!("{err:#}").contains("hash mismatch"));
    assert_eq!(read(&f.at("src/a.lua")), "A v1", "tree untouched");
}

#[test]
fn abort_leaves_the_tree_untouched() {
    let f = Fixture::new();
    let mut txn = Txn::begin(&f.txn_root()).unwrap();
    let sha = sha1_hex(b"A v2");
    txn.stage(&sha, b"A v2").unwrap();
    txn.push_install(f.at("src/a.lua"), &sha);
    txn.abort();

    assert_eq!(read(&f.at("src/a.lua")), "A v1");
    assert_eq!(read(&f.at("manifest.xml")), "<old/>");
    assert_eq!(fs::read_dir(f.txn_root()).unwrap().count(), 0);
}

#[test]
fn interrupted_staging_is_resumed_not_restarted() {
    // Mirrors the "download failed halfway, run update again" path: verified
    // blobs survive and are not re-fetched.
    let f = Fixture::new();
    let sha = sha1_hex(b"A v2");
    {
        let txn = Txn::begin(&f.txn_root()).unwrap();
        txn.stage(&sha, b"A v2").unwrap();
        txn.keep_for_resume();
    }
    // A recovery pass must leave a staging-phase transaction alone.
    let rec = apply::recover(&f.txn_root()).unwrap();
    assert_eq!(rec.rolled_back, 0);

    let txn = Txn::begin(&f.txn_root()).unwrap();
    assert!(txn.blob_ready(&sha), "previously staged blob should be reused");
    assert_eq!(read(&f.at("src/a.lua")), "A v1", "still not applied");
}

#[test]
fn a_corrupted_staged_blob_is_discarded_on_resume() {
    let f = Fixture::new();
    let sha = sha1_hex(b"A v2");
    let txn = Txn::begin(&f.txn_root()).unwrap();
    txn.stage(&sha, b"A v2").unwrap();
    fs::write(txn.blob_path(&sha), b"truncated").unwrap();
    assert!(!txn.blob_ready(&sha));
    assert!(!txn.blob_path(&sha).exists(), "bad blob is removed");
}

/// Hand-build the on-disk state of a process killed partway through the swap.
fn simulate_crashed_commit(f: &Fixture) -> std::path::PathBuf {
    let txn_dir = f.txn_root().join("crashed");
    fs::create_dir_all(txn_dir.join("backup")).unwrap();
    fs::create_dir_all(txn_dir.join("staging")).unwrap();

    let journal = serde_json::json!({
        "id": "crashed",
        "phase": "Committing",
        "ops": [
            { "kind": "Install", "dest": f.at("src/a.lua"), "blob": "aaa.blob" },
            { "kind": "Install", "dest": f.at("src/new/c.lua"), "blob": "ccc.blob" },
            { "kind": "Install", "dest": f.at("manifest.xml"), "blob": "mmm.blob" },
        ]
    });
    fs::write(
        txn_dir.join("journal.json"),
        serde_json::to_string_pretty(&journal).unwrap(),
    )
    .unwrap();

    // Op 0 completed: old a.lua moved to backup, new content in place.
    fs::rename(f.at("src/a.lua"), txn_dir.join("backup/0.bak")).unwrap();
    write(&f.at("src/a.lua"), "A v2");
    // Op 1 completed: c.lua is brand new, so there was nothing to back up.
    write(&f.at("src/new/c.lua"), "C new");
    // Op 2 (the manifest) never ran — this is where we "died".
    fs::write(txn_dir.join("commit.log"), "0 bak\n1 new\n").unwrap();
    txn_dir
}

#[test]
fn a_crash_mid_commit_rolls_back_to_the_previous_tree() {
    let f = Fixture::new();
    let txn_dir = simulate_crashed_commit(&f);
    assert_eq!(read(&f.at("src/a.lua")), "A v2", "precondition: partly applied");

    let rec = apply::recover(&f.txn_root()).unwrap();

    assert_eq!(rec.rolled_back, 1);
    assert_eq!(rec.restored_files, 1);
    assert_eq!(read(&f.at("src/a.lua")), "A v1", "backed-up file restored");
    assert!(
        !f.at("src/new/c.lua").exists(),
        "a file that did not exist before must be removed again"
    );
    assert_eq!(read(&f.at("manifest.xml")), "<old/>", "manifest never moved");
    assert_eq!(read(&f.at("src/b.lua")), "B v1", "untouched file untouched");
    assert!(!txn_dir.exists(), "transaction cleaned up");
}

#[test]
fn recovery_is_idempotent_and_cheap_when_there_is_nothing_to_do() {
    let f = Fixture::new();
    simulate_crashed_commit(&f);
    apply::recover(&f.txn_root()).unwrap();
    let second = apply::recover(&f.txn_root()).unwrap();
    assert_eq!(second.rolled_back, 0);
    assert_eq!(second.cleaned, 0);
    assert_eq!(read(&f.at("src/a.lua")), "A v1");
}

#[test]
fn an_unreadable_journal_is_swept_without_touching_the_tree() {
    let f = Fixture::new();
    let junk = f.txn_root().join("junk");
    fs::create_dir_all(&junk).unwrap();
    fs::write(junk.join("journal.json"), "{ not json").unwrap();

    let rec = apply::recover(&f.txn_root()).unwrap();
    assert_eq!(rec.cleaned, 1);
    assert!(!junk.exists());
    assert_eq!(read(&f.at("src/a.lua")), "A v1");
}

#[test]
fn empty_directories_are_pruned_after_deletes() {
    let f = Fixture::new();
    write(&f.at("src/old/nested/x.lua"), "x");
    fs::remove_file(f.at("src/old/nested/x.lua")).unwrap();
    apply::prune_empty_dirs(f.root(), f.at("src/old/nested"));
    assert!(!f.at("src/old").exists());
    assert!(f.root().exists(), "never prunes past the root");
    assert!(f.at("src/a.lua").exists(), "stops at non-empty dirs");
}

#[test]
fn two_paths_sharing_one_sha1_both_get_installed() {
    // Upstream ships byte-identical files (e.g. Assets/ascendants/raider.jpeg
    // and warden.jpeg). Content-addressed staging downloads such a blob once,
    // so the commit must not move it away from the first destination.
    let f = Fixture::new();
    let mut txn = Txn::begin(&f.txn_root()).unwrap();
    let sha = sha1_hex(b"shared bytes");
    txn.stage(&sha, b"shared bytes").unwrap();
    txn.push_install(f.at("src/one.jpeg"), &sha);
    txn.push_install(f.at("src/two.jpeg"), &sha);
    txn.push_install(f.at("src/three.jpeg"), &sha);
    txn.commit().unwrap();

    for p in ["src/one.jpeg", "src/two.jpeg", "src/three.jpeg"] {
        assert_eq!(read(&f.at(p)), "shared bytes", "{p} missing");
    }
}
