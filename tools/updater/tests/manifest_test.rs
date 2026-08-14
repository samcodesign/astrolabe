//! Manifest parsing, round-tripping and path/URL derivation.
//!
//! Fixtures under `tests/fixtures/` are verbatim slices of the real
//! `manifest.xml` shipped by PathOfBuildingCommunity/PathOfBuilding at commit
//! 32d4c87bf7888bf82c01d9e544f3bbb30f01f267 (manifest version 2.67.2). No test
//! in this file touches the network.

use pob_updater::manifest::{Manifest, encode_url_path};

fn local() -> Manifest {
    Manifest::parse(include_str!("fixtures/manifest_local.xml")).expect("fixture parses")
}

fn remote() -> Manifest {
    Manifest::parse(include_str!("fixtures/manifest_remote.xml")).expect("fixture parses")
}

#[test]
fn parses_version_sources_and_files() {
    let m = local();
    assert_eq!(m.version, "2.67.2");
    assert_eq!(m.platform.as_deref(), Some("win32"));
    assert_eq!(m.branch.as_deref(), Some("dev"));
    assert_eq!(m.sources.len(), 4);
    assert_eq!(m.files.len(), 41);

    // The four upstream parts, with `runtime` being the only platform-scoped one.
    let runtime = m
        .sources
        .iter()
        .find(|s| s.part == "runtime")
        .expect("runtime source");
    assert_eq!(runtime.platform.as_deref(), Some("win32"));
    assert!(runtime.url.ends_with("/{branch}/runtime/"));

    for part in ["default", "runtime", "program", "tree"] {
        assert!(
            m.source_for(part, "win32").is_some(),
            "missing source for `{part}`"
        );
    }
}

#[test]
fn program_and_tree_share_the_src_source() {
    // Upstream points both parts at `.../src/`; only the file names distinguish
    // them (`TreeData/...` vs everything else).
    let m = local();
    assert_eq!(
        m.source_for("program", "win32").unwrap().url,
        m.source_for("tree", "win32").unwrap().url
    );
}

#[test]
fn part_subdir_is_derived_from_the_source_url() {
    let m = local();
    assert_eq!(m.part_subdir("default", "win32"), "");
    assert_eq!(m.part_subdir("program", "win32"), "src");
    assert_eq!(m.part_subdir("tree", "win32"), "src");
    assert_eq!(m.part_subdir("runtime", "win32"), "runtime");
}

#[test]
fn source_lookup_prefers_the_matching_platform() {
    let m = local();
    // `runtime` has only a win32 entry; asking for another platform must not
    // silently hand back the win32 one.
    assert!(m.source_for("runtime", "linux").is_none());
    // `program` has no platform attribute, so it applies everywhere.
    assert!(m.source_for("program", "linux").is_some());
}

#[test]
fn decodes_the_space_escape() {
    let m = local();
    let exe = m
        .files
        .iter()
        .find(|f| f.name.contains("{space}"))
        .expect("fixture keeps the {space} entry");
    assert_eq!(exe.name, "Path{space}of{space}Building.exe");
    assert_eq!(exe.rel_path(), "Path of Building.exe");
    assert_eq!(exe.part, "runtime");
    assert_eq!(exe.runtime.as_deref(), Some("win32"));
    assert_eq!(
        encode_url_path(&exe.rel_path()),
        "Path%20of%20Building%2Eexe".replace("%2E", ".")
    );
}

#[test]
fn url_encoding_keeps_path_separators() {
    // UpdateCheck.lua runs curl_easy_escape over the whole path, which would
    // turn `/` into `%2F`; we encode per segment instead.
    assert_eq!(
        encode_url_path("src/TreeData/3_26/tree.lua"),
        "src/TreeData/3_26/tree.lua"
    );
    assert!(!encode_url_path("src/Data/a b.lua").contains("%2F"));
}

#[test]
fn sha1_values_are_lowercase_hex_of_the_right_length() {
    for f in local().files {
        assert_eq!(f.sha1.len(), 40, "{} has a short sha1", f.name);
        assert!(
            f.sha1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "{} sha1 is not lowercase hex",
            f.name
        );
    }
}

#[test]
fn round_trips_through_serialisation() {
    let m = local();
    let reparsed = Manifest::parse(&m.to_xml()).expect("our own output parses");
    assert_eq!(reparsed, m);
}

#[test]
fn remote_fixture_carries_the_expected_drift() {
    let (l, r) = (local(), remote());
    assert_eq!(r.version, "2.68.0");
    assert_eq!(r.files.len(), l.files.len() + 3 - 2);
}

#[test]
fn rejects_garbage() {
    assert!(Manifest::parse("not xml at all <<<").is_err());
    assert!(Manifest::parse("<Other><Version number=\"1\"/></Other>").is_err());
    // Root present but no files: an empty manifest would diff as "delete
    // everything", so it must be refused outright.
    assert!(
        Manifest::parse(
            "<PoBVersion><Version number=\"1.0.0\"/>\
             <Source part=\"default\" url=\"http://x/{branch}/\"/></PoBVersion>"
        )
        .is_err()
    );
}
