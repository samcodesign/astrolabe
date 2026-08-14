//! SHA1 diffing, scoped by part and tree version.
//!
//! Both manifests are derived from the real 2.67.2 manifest. The "remote" one
//! has deliberate drift baked in:
//!   changed  changelog.txt, Data/Bases/fishing.lua,
//!            TreeData/3_26/tree.lua, TreeData/3_27/tree.lua
//!   added    Data/Bases/newweapon.lua, TreeData/3_29/{tree,sprites}.lua
//!   removed  Data/EnchantmentFlask.lua, TreeData/3_25/tree.lua
//!
//! No network access; the on-disk cases use a throwaway temp directory.

use pob_updater::manifest::{FileEntry, Manifest};
use pob_updater::plan::{self, Plan, PlanInput, Reason};
use pob_updater::selector::Selection;
use std::collections::BTreeMap;
use std::path::Path;

fn local() -> Manifest {
    Manifest::parse(include_str!("fixtures/manifest_local.xml")).unwrap()
}
fn remote() -> Manifest {
    Manifest::parse(include_str!("fixtures/manifest_remote.xml")).unwrap()
}

fn sel(parts: &[&str], tree: Option<&[&str]>) -> Selection {
    Selection::new(
        parts.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        tree.map(|t| t.iter().map(|s| s.to_string()).collect()),
        "win32",
    )
}

/// Materialise a placeholder for every file the local manifest claims, so the
/// existence check passes and only manifest-vs-manifest drift shows up.
fn populated_root(m: &Manifest) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for f in &m.files {
        let p = plan::dest_path(dir.path(), m, f, "win32");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"").unwrap();
    }
    dir
}

/// Diff local against remote with every local file present on disk.
fn diff_manifests_only(selection: &Selection) -> Plan {
    let (l, r) = (local(), remote());
    let dir = populated_root(&l);
    let sizes = BTreeMap::new();
    plan::compute(&PlanInput {
        local: &l,
        remote: &r,
        selection,
        root: dir.path(),
        verify_local: false,
        sizes: &sizes,
    })
}

fn names(plan: &Plan) -> Vec<String> {
    plan.updates.iter().map(|c| c.entry.name.clone()).collect()
}
fn deleted(plan: &Plan) -> Vec<String> {
    plan.deletes.iter().map(|d| d.entry.name.clone()).collect()
}

#[test]
fn identical_manifests_produce_no_work() {
    let l = local();
    let sizes = BTreeMap::new();
    let plan = plan::compute(&PlanInput {
        local: &l,
        remote: &l,
        selection: &sel(&["default", "program", "tree", "runtime"], None),
        // Files are absent from disk, but with verify_local off and the local
        // manifest agreeing, only the existence check runs...
        root: Path::new("Z:/definitely/not/here"),
        verify_local: false,
        sizes: &sizes,
    });
    // ...and a manifest entry with no file behind it is still an update, exactly
    // as UpdateCheck.lua warns ("doesn't exist, it will be re-downloaded").
    assert!(plan.deletes.is_empty());
    assert!(plan.updates.iter().all(|c| c.reason == Reason::MissingLocally));
    // Against what the selection admits, not the raw manifest: `runtime` carries
    // the desktop client's own binaries, which we never vendor.
    let selection = sel(&["default", "program", "tree", "runtime"], None);
    let wanted = l.files.iter().filter(|f| selection.includes(f)).count();
    assert_eq!(plan.updates.len(), wanted);
    assert!(wanted > 0);
}

#[test]
fn program_scope_sees_only_program_drift() {
    let plan = diff_manifests_only(&sel(&["program"], None));
    let mut got = names(&plan);
    got.sort();
    assert_eq!(got, vec!["Data/Bases/fishing.lua", "Data/Bases/newweapon.lua"]);
    assert_eq!(deleted(&plan), vec!["Data/EnchantmentFlask.lua"]);

    // Crucially: nothing from `tree` and nothing from `default`.
    assert!(plan.updates.iter().all(|c| c.entry.part == "program"));
    assert!(plan.deletes.iter().all(|d| d.entry.part == "program"));
}

#[test]
fn narrow_scope_never_proposes_deleting_unvendored_parts() {
    // The regression this guards: a program-only run must not read "the remote
    // manifest has no tree files in my selection" as "delete 554 MB of tree".
    let plan = diff_manifests_only(&sel(&["program"], None));
    assert!(
        !deleted(&plan).iter().any(|n| n.starts_with("TreeData/")),
        "program-only diff proposed deleting tree files: {:?}",
        deleted(&plan)
    );
}

#[test]
fn reasons_distinguish_new_from_changed() {
    let plan = diff_manifests_only(&sel(&["program"], None));
    let by_name: BTreeMap<_, _> = plan
        .updates
        .iter()
        .map(|c| (c.entry.name.as_str(), c.reason))
        .collect();
    assert_eq!(by_name["Data/Bases/fishing.lua"], Reason::ShaChanged);
    assert_eq!(by_name["Data/Bases/newweapon.lua"], Reason::New);
    assert_eq!(plan.counts_by_reason().get("changed"), Some(&1));
    assert_eq!(plan.counts_by_reason().get("new"), Some(&1));
}

#[test]
fn tree_scope_restricted_to_one_version() {
    let plan = diff_manifests_only(&sel(&["tree"], Some(&["3_26"])));
    assert_eq!(names(&plan), vec!["TreeData/3_26/tree.lua"]);
    // 3_27 changed and 3_29 is new, but neither is selected.
    assert!(!names(&plan).iter().any(|n| n.contains("3_27")));
    assert!(!names(&plan).iter().any(|n| n.contains("3_29")));
    // 3_25/tree.lua vanished upstream but is outside the selection.
    assert!(deleted(&plan).is_empty());
}

#[test]
fn selecting_a_new_tree_version_fetches_just_that_version() {
    // The "fetch a single tree version on demand" path: 3_29 exists only
    // upstream, and asking for it pulls its two files and nothing else.
    let plan = diff_manifests_only(&sel(&["tree"], Some(&["3_29"])));
    let mut got = names(&plan);
    got.sort();
    assert_eq!(
        got,
        vec!["TreeData/3_29/sprites.lua", "TreeData/3_29/tree.lua"]
    );
    assert!(plan.updates.iter().all(|c| c.reason == Reason::New));
}

#[test]
fn unversioned_tree_assets_always_come_along() {
    // TreeData/*.png are shared by every tree version, so a version-scoped
    // selection must still include them.
    let s = sel(&["tree"], Some(&["3_26"]));
    let shared = FileEntry {
        name: "TreeData/SepiaOil.png".into(),
        part: "tree".into(),
        sha1: "0".repeat(40),
        platform: None,
        runtime: None,
    };
    assert!(s.includes(&shared));

    let other_version = FileEntry {
        name: "TreeData/3_20/tree.lua".into(),
        ..shared.clone()
    };
    assert!(!s.includes(&other_version));
}

#[test]
fn tree_without_a_version_filter_takes_everything() {
    let plan = diff_manifests_only(&sel(&["tree"], None));
    let mut got = names(&plan);
    got.sort();
    assert_eq!(
        got,
        vec![
            "TreeData/3_26/tree.lua",
            "TreeData/3_27/tree.lua",
            "TreeData/3_29/sprites.lua",
            "TreeData/3_29/tree.lua",
        ]
    );
    assert_eq!(deleted(&plan), vec!["TreeData/3_25/tree.lua"]);
}

#[test]
fn platform_scoped_entries_are_filtered_out() {
    // UpdateCheck.lua drops remote entries whose platform is not the local one.
    //
    // Carried on a `lua/` name so this exercises platform filtering alone: a
    // `runtime` entry outside `lua/` is dropped for a different reason, and
    // testing through one would pass no matter what the platform check did.
    let e = FileEntry {
        name: "lua/lcurl.lua".into(),
        part: "runtime".into(),
        sha1: "0".repeat(40),
        platform: Some("linux".into()),
        runtime: None,
    };
    assert!(!sel(&["runtime"], None).includes(&e));
    assert!(
        sel(&["runtime"], None).includes(&FileEntry {
            platform: Some("win32".into()),
            ..e.clone()
        })
    );
    assert!(sel(&["runtime"], None).includes(&FileEntry { platform: None, ..e }));
}

#[test]
fn paths_and_urls_follow_the_part_layout() {
    let r = remote();
    let root = Path::new("C:/vendor/pob");
    let find = |name: &str| r.files.iter().find(|f| f.name == name).unwrap().clone();

    let tree = find("TreeData/3_26/tree.lua");
    assert_eq!(plan::repo_path(&r, &tree, "win32"), "src/TreeData/3_26/tree.lua");
    assert_eq!(
        plan::dest_path(root, &r, &tree, "win32"),
        Path::new("C:/vendor/pob/src/TreeData/3_26/tree.lua")
    );

    let changelog = find("changelog.txt");
    assert_eq!(plan::repo_path(&r, &changelog, "win32"), "changelog.txt");
    assert_eq!(
        plan::dest_path(root, &r, &changelog, "win32"),
        Path::new("C:/vendor/pob/changelog.txt")
    );

    let exe = find("Path{space}of{space}Building.exe");
    assert_eq!(
        plan::repo_path(&r, &exe, "win32"),
        "runtime/Path of Building.exe"
    );
    assert_eq!(
        plan::dest_path(root, &r, &exe, "win32"),
        Path::new("C:/vendor/pob/runtime/Path of Building.exe")
    );
}

#[test]
fn byte_totals_come_from_the_size_map() {
    let (l, r) = (local(), remote());
    let dir = populated_root(&l);
    let mut sizes = BTreeMap::new();
    sizes.insert("src/Data/Bases/fishing.lua".to_string(), 431u64);
    // newweapon.lua deliberately absent: sizes are best-effort.
    let plan = plan::compute(&PlanInput {
        local: &l,
        remote: &r,
        selection: &sel(&["program"], None),
        root: dir.path(),
        verify_local: false,
        sizes: &sizes,
    });
    assert_eq!(plan.known_bytes(), 431);
    assert_eq!(plan.unknown_size_count(), 1);
}

// ---------------------------------------------------------------------------
// On-disk behaviour
// ---------------------------------------------------------------------------

const FISHING_LF: &[u8] = include_bytes!("fixtures/fishing_lf.lua");

/// Lay out `src/Data/Bases/fishing.lua` inside a temp root with given contents.
fn root_with_fishing(contents: Option<&[u8]>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    if let Some(bytes) = contents {
        let p = dir.path().join("src/Data/Bases");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("fishing.lua"), bytes).unwrap();
    }
    dir
}

/// Diff a manifest against itself so only on-disk state can produce work.
fn self_diff(root: &Path, verify_local: bool) -> Plan {
    let l = local();
    let sizes = BTreeMap::new();
    plan::compute(&PlanInput {
        local: &l,
        remote: &l,
        selection: &sel(&["program"], None),
        root,
        verify_local,
        sizes: &sizes,
    })
}

#[test]
fn lf_file_on_disk_is_not_reported_as_corrupt() {
    // The whole point of the CRLF fallback: a file we downloaded (LF) whose
    // manifest hash is of the CRLF form must read as unchanged, not corrupt.
    let dir = root_with_fishing(Some(FISHING_LF));
    let plan = self_diff(dir.path(), true);
    assert!(
        !plan
            .updates
            .iter()
            .any(|c| c.entry.name == "Data/Bases/fishing.lua"),
        "LF file was flagged: {:?}",
        plan.updates
            .iter()
            .map(|c| (&c.entry.name, c.reason))
            .collect::<Vec<_>>()
    );
    assert!(plan.verified >= 1);
}

#[test]
fn tampered_file_is_reported_as_corrupt_when_verifying() {
    let dir = root_with_fishing(Some(b"-- not the real file\n"));
    let plan = self_diff(dir.path(), true);
    let entry = plan
        .updates
        .iter()
        .find(|c| c.entry.name == "Data/Bases/fishing.lua")
        .expect("tampered file should be scheduled for replacement");
    assert_eq!(entry.reason, Reason::Corrupt);
}

#[test]
fn tampered_file_is_missed_without_verification() {
    // Documents the tradeoff of the fast path: without --verify we trust the
    // manifest and only notice files that are absent entirely.
    let dir = root_with_fishing(Some(b"-- not the real file\n"));
    let plan = self_diff(dir.path(), false);
    assert!(
        !plan
            .updates
            .iter()
            .any(|c| c.entry.name == "Data/Bases/fishing.lua")
    );
    assert_eq!(plan.verified, 0);
}

#[test]
fn absent_file_is_detected_even_without_verification() {
    let dir = root_with_fishing(None);
    let plan = self_diff(dir.path(), false);
    let entry = plan
        .updates
        .iter()
        .find(|c| c.entry.name == "Data/Bases/fishing.lua")
        .expect("missing file should be scheduled");
    assert_eq!(entry.reason, Reason::MissingLocally);
}

// ---------------------------------------------------------------------------
// Manifest merging
// ---------------------------------------------------------------------------

#[test]
fn merged_manifest_preserves_entries_outside_the_selection() {
    let (l, r) = (local(), remote());
    let merged = plan::merged_manifest(&l, &r, &sel(&["program"], None));

    assert_eq!(merged.version, r.version, "version comes from upstream");

    let by_name = merged.by_name();
    // Updated inside the selection...
    assert_eq!(
        by_name["Data/Bases/fishing.lua"].sha1,
        r.by_name()["Data/Bases/fishing.lua"].sha1
    );
    assert!(by_name.contains_key("Data/Bases/newweapon.lua"));
    assert!(!by_name.contains_key("Data/EnchantmentFlask.lua"));

    // ...and untouched outside it: the tree entries we still have on disk stay,
    // at their old hashes, and 3_29 is not claimed.
    assert_eq!(
        by_name["TreeData/3_26/tree.lua"].sha1,
        l.by_name()["TreeData/3_26/tree.lua"].sha1
    );
    assert!(by_name.contains_key("TreeData/3_25/tree.lua"));
    assert!(!by_name.contains_key("TreeData/3_29/tree.lua"));
}

#[test]
fn merged_manifest_round_trips_and_has_no_duplicates() {
    let (l, r) = (local(), remote());
    let merged = plan::merged_manifest(&l, &r, &sel(&["default", "program"], None));
    let xml = merged.to_xml();
    let reparsed = Manifest::parse(&xml).unwrap();
    assert_eq!(reparsed.files.len(), merged.files.len());

    let mut seen = std::collections::BTreeSet::new();
    for f in &reparsed.files {
        assert!(seen.insert((f.part.clone(), f.name.clone())), "dup {}", f.name);
    }
    // The {space} escape must survive a round trip, or the runtime exe would be
    // re-downloaded forever.
    assert!(xml.contains("Path{space}of{space}Building.exe"));
}

#[test]
fn available_tree_versions_are_discovered_from_the_manifest() {
    let versions = Selection::available_tree_versions(&remote().files);
    assert!(versions.contains("3_25"));
    assert!(versions.contains("3_26"));
    assert!(versions.contains("3_29"));
    // Shared, unversioned assets must not masquerade as a version.
    assert!(!versions.iter().any(|v| v.ends_with(".png")));
}
