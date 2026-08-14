//! Exports the fixtures the frontend tracks develop against, and checks their
//! shape while it is at it.
//!
//! Run with `cargo test --release --test fixtures`. The output lands in
//! `<repo>/fixtures/` and is meant to be committed, so a frontend can be built
//! and reviewed without a working engine host.

mod common;

use common::{fixtures_dir, host};
use serde_json::{json, Value};

/// Enough points to make the fixture look like a build rather than a bare
/// class start, while staying quick to produce.
const FIXTURE_POINTS: i64 = 24;

#[test]
fn export_geometry_and_summary() {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir).expect("could not create the fixtures directory");

    let mut h = host();
    h.call("build.load", json!({ "empty": true }));

    // Spend some points so the summary fixture has a real allocation in it, and
    // so those node ids are ones the geometry fixture actually contains.
    let mut summary = h.call("build.summary", json!({}));
    while summary["pointsUsed"].as_i64().unwrap() < FIXTURE_POINTS {
        let Some(target) = next_reachable_node(&mut h) else { break };
        summary = h.call("tree.allocate", json!({ "nodes": [target] }))["summary"].clone();
    }
    assert!(
        summary["pointsUsed"].as_i64().unwrap() >= FIXTURE_POINTS,
        "the fixture build should have spent its points"
    );

    let geometry = h.call("tree.geometry", json!({}));
    check_geometry(&geometry, &summary);

    let version = geometry["version"].as_str().unwrap().to_string();
    write(&dir.join(format!("geometry-{version}.json")), &geometry);
    write(&dir.join("build-summary.json"), &summary);
}

/// Any node one point away that carries modifiers. `tree.power` already ranks
/// exactly this set, so reuse it rather than re-deriving reachability.
fn next_reachable_node(h: &mut common::Host) -> Option<Value> {
    let requested = h.call("tree.power", json!({ "metric": "offence", "maxDepth": 1 }));
    if requested["requested"].as_i64().unwrap() == 0 {
        return None;
    }
    let stream = h.drain_until("tree.power.done");
    let mut nodes: Vec<Value> = stream
        .iter()
        .filter(|m| m["method"] == json!("tree.power.progress"))
        .flat_map(|m| m["params"]["nodes"].as_array().unwrap().clone())
        .collect();
    // An empty build has no skill, so power is meaningless here; pick
    // deterministically by id so the fixture is reproducible.
    nodes.sort_by_key(|n| n["id"].as_i64().unwrap());
    nodes.first().map(|n| n["id"].clone())
}

fn check_geometry(geometry: &Value, summary: &Value) {
    for key in [
        "version", "size", "nodes", "connectors", "groups", "sprites", "sheets", "extraImages",
        "ascendancies",
    ] {
        assert!(!geometry[key].is_null(), "geometry is missing {key}");
    }
    check_ascendancies(geometry);
    let nodes = geometry["nodes"].as_array().unwrap();
    assert!(nodes.len() > 2000);

    let ids: std::collections::HashSet<i64> =
        nodes.iter().map(|n| n["id"].as_i64().unwrap()).collect();
    for allocated in summary["allocated"].as_array().unwrap() {
        assert!(
            ids.contains(&allocated.as_i64().unwrap()),
            "the summary allocates {allocated}, which the geometry does not contain"
        );
    }

    for connector in geometry["connectors"].as_array().unwrap() {
        assert!(ids.contains(&connector["from"].as_i64().unwrap()));
        assert!(ids.contains(&connector["to"].as_i64().unwrap()));
    }

    // Every sprite a node names must resolve to a sheet the payload lists, or
    // the fixture renders with holes in it.
    for node in nodes {
        for slot in ["active", "inactive"] {
            check_sprite(geometry, &node["icon"][slot], &node["id"]);
        }
        for slot in ["allocated", "path", "unallocated"] {
            check_sprite(geometry, &node["frame"][slot], &node["id"]);
        }
        check_sprite(geometry, &node["effect"], &node["id"]);
    }
    for connector in geometry["connectors"].as_array().unwrap() {
        let sheet = connector["sheet"].as_str().unwrap();
        assert!(
            !geometry["sprites"][sheet].is_null(),
            "connector art {sheet} is not in the sprite atlas"
        );
    }
}

/// A fixture that is missing a class is worse than no fixture: the frontend is
/// built against it, so whatever it omits simply does not exist as far as the UI
/// is concerned. `tree.classes` is 0-based (PassiveTree.lua:95-101), and an
/// `ipairs` walk over it drops Scion and misreports every other class's id.
fn check_ascendancies(geometry: &Value) {
    const BASE_CLASSES: [(i64, &str); 7] = [
        (0, "Scion"),
        (1, "Marauder"),
        (2, "Ranger"),
        (3, "Witch"),
        (4, "Duelist"),
        (5, "Templar"),
        (6, "Shadow"),
    ];

    let ascendancies = geometry["ascendancies"].as_array().unwrap();
    for (class_id, class_name) in BASE_CLASSES {
        let owned: Vec<&Value> = ascendancies
            .iter()
            .filter(|a| a["classId"] == json!(class_id) && a["alternate"].is_null())
            .collect();
        assert!(
            !owned.is_empty(),
            "the fixture exports no ascendancy for class {class_id} ({class_name})"
        );
        for entry in owned {
            assert_eq!(entry["className"], json!(class_name), "wrong owner: {entry}");
            assert!(!entry["id"].as_str().unwrap().is_empty());
        }
    }
    assert!(
        ascendancies
            .iter()
            .any(|a| a["id"] == json!("Ascendant") && a["classId"] == json!(0)),
        "Scion/Ascendant must be in the fixture"
    );
    // Alternate ascendancies are class-less by design; they must not gain a
    // classId from the base-class loop.
    assert!(ascendancies
        .iter()
        .filter(|a| a["alternate"] == json!(true))
        .all(|a| a["classId"].is_null()));
}

fn check_sprite(geometry: &Value, sprite: &Value, owner: &Value) {
    if sprite.is_null() {
        return;
    }
    let sheet = sprite["sheet"].as_str().unwrap_or_else(|| panic!("bad sprite on {owner}"));
    assert!(
        !geometry["sheets"][sheet].is_null(),
        "node {owner} points at sheet {sheet}, which is not listed"
    );
}

fn write(path: &std::path::Path, value: &Value) {
    let text = serde_json::to_string(value).expect("fixtures serialise");
    std::fs::write(path, &text).unwrap_or_else(|e| panic!("could not write {}: {e}", path.display()));
    println!("wrote {} ({} bytes)", path.display(), text.len());
}
