//! Contract tests for every RPC method, run against a live `serve` process.
//!
//! The interesting assertion is not "the method returned something" but "the
//! numbers moved the way the game says they should" — see
//! `allocating_a_node_raises_dps`, which is the end-to-end proof that we are
//! driving PoB's engine and not just reading its data files.
//!
//! Every test takes the shared host for its whole body: the protocol is a
//! single stream, so two tests interleaving would steal each other's
//! notifications.

mod common;

use common::{base64url_decode, base64url_encode, host, sample_build_xml, Host};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::io::{Read, Write};

/// A PoB share code, built with an independent zlib implementation. If the host
/// can read this, it can read one produced by PoB itself.
fn share_code(xml: &str) -> String {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(xml.as_bytes()).unwrap();
    base64url_encode(&encoder.finish().unwrap())
}

fn load_sample(h: &mut Host) -> Value {
    h.call("build.load", json!({ "code": share_code(&sample_build_xml()) }))
}

fn stat(stats: &Value, key: &str) -> f64 {
    stats
        .as_array()
        .expect("stats is an array")
        .iter()
        .find(|s| s["key"] == json!(key))
        .unwrap_or_else(|| panic!("no stat {key} in {stats}"))["value"]
        .as_f64()
        .unwrap_or_else(|| panic!("stat {key} is not a number"))
}

/// A `CharacterPayload` rebuilt from PoB's own captured character response, so
/// the test uses real GGG data rather than a hand-written stub. The payload
/// carries the two endpoint responses verbatim, which is what Track 3 sends:
/// `get-items` is `{ items, character }` and `get-passive-skills` is the
/// hashes plus the socketed jewels under `items`.
fn character_payload() -> Value {
    let sample = std::fs::read_to_string(
        common::pob_path().join("spec").join("System").join("SampleCharacter.json"),
    )
    .expect("PoB ships SampleCharacter.json");
    let root: Value = serde_json::from_str(&sample).unwrap();
    let character = &root["character"];

    let mut passives = character["passives"].clone();
    passives["items"] = character["jewels"].clone();

    json!({
        "source": "official-api",
        "account": "Exile#1234",
        "character": character["name"],
        "realm": "pc",
        "items": {
            "items": character["equipment"],
            "character": {
                "name": character["name"],
                "class": character["class"],
                "league": character["league"],
                "level": character["level"],
            },
        },
        "passives": passives,
    })
}

/// A SpriteRef must be a real sub-rect of a sheet the payload can resolve.
fn assert_sprite(geometry: &Value, sprite: &Value) {
    assert!(sprite.is_object(), "expected a SpriteRef, got {sprite}");
    let sheet = sprite["sheet"].as_str().expect("sprites name a sheet");
    assert!(
        !geometry["sheets"][sheet].is_null(),
        "{sheet} is not in the sheets map"
    );
    assert!(sprite["w"].as_f64().unwrap() > 0.0, "empty sprite: {sprite}");
    assert!(sprite["h"].as_f64().unwrap() > 0.0, "empty sprite: {sprite}");
    assert!(sprite["x"].as_f64().unwrap() >= 0.0);
    assert!(sprite["y"].as_f64().unwrap() >= 0.0);
}

/// Run a heatmap to completion and return every node it reported.
fn power_pass(h: &mut Host, metric: &str, max_depth: i64) -> Vec<Value> {
    h.call("tree.power", json!({ "metric": metric, "maxDepth": max_depth }));
    h.drain_until("tree.power.done")
        .iter()
        .filter(|m| m["method"] == json!("tree.power.progress"))
        .flat_map(|m| m["params"]["nodes"].as_array().unwrap().clone())
        .collect()
}

#[test]
fn host_info_reports_versions() {
    let mut h = host();
    let info = h.call("host.info", json!({}));
    assert!(!info["hostVersion"].as_str().unwrap().is_empty());
    assert!(
        info["pobVersion"].as_str().unwrap().contains('.'),
        "pobVersion should look like 2.67.2, got {}",
        info["pobVersion"]
    );
    assert_eq!(info["pobCommit"].as_str().unwrap().len(), 40, "a git sha");
    let versions = info["treeVersions"].as_array().unwrap();
    assert!(versions.contains(&json!("3_29")), "the live tree is offered");
    assert!(versions.contains(&json!("3_13")), "older trees are offered");
    assert!(info["bootMs"].as_f64().unwrap() > 0.0);
}

#[test]
fn build_load_accepts_every_source() {
    let mut h = host();
    let xml = sample_build_xml();

    let from_empty = h.call("build.load", json!({ "empty": true }));
    assert_eq!(from_empty["pointsUsed"], json!(0));
    assert_eq!(from_empty["treeVersion"], json!("3_29"), "a new build is current");

    let from_xml = h.call("build.load", json!({ "xml": xml }));
    assert_eq!(from_xml["className"], json!("Witch"));
    assert_eq!(from_xml["ascendClassName"], json!("Occultist"));
    assert_eq!(from_xml["treeVersion"], json!("3_13"));
    assert!(from_xml["pointsUsed"].as_i64().unwrap() > 100);
    assert!(from_xml["pointsTotal"].as_i64().unwrap() >= 122);

    let from_code = load_sample(&mut h);
    assert_eq!(
        from_code["allocated"], from_xml["allocated"],
        "a share code and the XML it wraps must load identically"
    );

    // A CharacterPayload: the two GGG endpoint responses, verbatim.
    let from_character = h.call("build.load", json!({ "character": character_payload() }));
    assert_eq!(from_character["className"], json!("Templar"));
    assert_eq!(from_character["ascendClassName"], json!("Hierophant"));
    assert_eq!(from_character["level"], json!(99));
    assert!(from_character["allocated"].as_array().unwrap().len() > 50);
    assert!(
        h.call("stats.get", json!({ "keys": ["Life"] }))["stats"]
            .as_array()
            .unwrap()
            .len()
            == 1,
        "the imported character calculates"
    );

    let err = h.call_err("build.load", json!({ "character": { "nothing": true } }));
    assert_eq!(err["code"], json!(-32602), "a non-character object is rejected");
    let err = h.call_err(
        "build.load",
        json!({ "character": { "source": "official-api", "items": {}, "passives": {} } }),
    );
    assert_eq!(err["code"], json!(-32602), "empty endpoint responses are rejected");

    let err = h.call_err("build.load", json!({}));
    assert_eq!(err["code"], json!(-32602), "no source is a bad request");
    let err = h.call_err("build.load", json!({ "empty": true, "xml": "<x/>" }));
    assert_eq!(err["code"], json!(-32602), "two sources is a bad request");
}

/// Every `host.busy` must be closed by a `host.idle` with the same token, or
/// the frontend is back to guessing with a timer.
#[test]
fn busy_scopes_are_always_closed() {
    let mut h = host();
    let (_, notifications) = h.call_raw("build.load", json!({ "empty": true }));
    assert_open_scopes_closed(&notifications);
    let busy = notifications
        .iter()
        .find(|m| m["method"] == json!("host.busy"))
        .expect("build.load reports itself as slow");
    assert_eq!(busy["params"]["what"], json!("loading build"));
    assert!(busy["params"]["token"].as_str().unwrap().len() > 0);

    // Loading a tree version for the first time opens its own nested scope —
    // that is the five-second wait the contract exists for.
    let (_, nested) = h.call_raw("spec.create", json!({ "treeVersion": "3_18" }));
    assert_open_scopes_closed(&nested);
    assert!(
        nested.iter().any(|m| m["method"] == json!("host.busy")
            && m["params"]["what"].as_str().unwrap().contains("passive tree")),
        "the tree load announces itself: {nested:?}"
    );

    // A method that fails must still close its scope.
    let (_, failed) = h.call_raw("build.load", json!({ "code": "rubbish" }));
    assert_open_scopes_closed(&failed);
}

fn assert_open_scopes_closed(notifications: &[Value]) {
    let mut open: Vec<&str> = Vec::new();
    for message in notifications {
        let token = message["params"]["token"].as_str();
        match (message["method"].as_str(), token) {
            (Some("host.busy"), Some(token)) => {
                if !open.contains(&token) {
                    open.push(token);
                }
            }
            (Some("host.idle"), Some(token)) => {
                assert!(open.contains(&token), "host.idle for an unopened scope {token}");
                open.retain(|t| *t != token);
            }
            _ => {}
        }
    }
    assert!(open.is_empty(), "these busy scopes were never closed: {open:?}");
}

#[test]
fn build_summary_matches_the_load_result() {
    let mut h = host();
    let loaded = load_sample(&mut h);
    let summary = h.call("build.summary", json!({}));
    assert_eq!(loaded, summary, "summary is stable between calls");
    assert!(summary["allocated"].as_array().unwrap().len() > 100);
    assert!(summary["level"].as_i64().unwrap() >= 1);
    assert_eq!(
        summary["activeSpec"],
        h.call("spec.list", json!({}))["active"],
        "the summary names the variant its numbers describe"
    );
}

/// Deflate/Inflate are stubbed out in HeadlessWrapper; this is the proof that
/// ours round-trip real PoB codes rather than merely round-tripping themselves.
#[test]
fn share_codes_round_trip_through_real_zlib() {
    let mut h = host();
    let loaded = h.call("build.load", json!({ "code": share_code(&sample_build_xml()) }));
    assert_eq!(loaded["className"], json!("Witch"), "a zlib code inflated");

    let code = h.call("build.save", json!({ "as": "code" }));
    let raw = base64url_decode(code["data"].as_str().unwrap());
    assert_eq!(raw[0], 0x78, "PoB codes carry a zlib header");

    let mut round_tripped = String::new();
    ZlibDecoder::new(&raw[..])
        .read_to_string(&mut round_tripped)
        .expect("our Deflate output must be readable by a stock zlib");

    let saved_xml = h.call("build.save", json!({ "as": "xml" }));
    assert_eq!(
        round_tripped,
        saved_xml["data"].as_str().unwrap(),
        "the code and the XML describe the same build"
    );
    assert!(round_tripped.contains("<PathOfBuilding>"));

    // And the code we emit must load back into the host unchanged.
    let reloaded = h.call("build.load", json!({ "code": code["data"] }));
    assert_eq!(reloaded["className"], json!("Witch"));
    assert_eq!(reloaded["allocated"], loaded["allocated"]);

    let err = h.call_err("build.load", json!({ "code": "not-a-real-code" }));
    assert_eq!(err["code"], json!(-32602));
    let err = h.call_err("build.save", json!({ "as": "yaml" }));
    assert_eq!(err["code"], json!(-32602));
}

/// Tree variants are a real PoB concept — several `<Spec>` elements in one
/// build — so creating, switching and saving them must go through the engine's
/// own spec list, not a diff of allocations.
#[test]
fn spec_variants_are_managed_and_saved() {
    let mut h = host();
    let loaded = load_sample(&mut h);
    let first = loaded["activeSpec"].as_str().unwrap().to_string();

    let listed = h.call("spec.list", json!({}));
    assert_eq!(listed["active"], json!(first));
    assert_eq!(listed["specs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["specs"][0]["id"], json!(first));
    assert_eq!(listed["specs"][0]["treeVersion"], json!("3_13"));

    // A copy carries the source's allocation; a fresh variant does not.
    let copy = h.call("spec.create", json!({ "title": "Copy", "copyFrom": first }))["spec"].clone();
    assert_ne!(copy["id"], json!(first), "ids are stable and distinct");
    assert_eq!(copy["allocated"], listed["specs"][0]["allocated"]);
    assert_eq!(copy["treeVersion"], json!("3_13"), "a copy keeps its version");

    let blank = h.call("spec.create", json!({ "title": "From scratch" }))["spec"].clone();
    assert_eq!(blank["treeVersion"], json!("3_29"), "a new variant is current");
    assert!(blank["pointsUsed"].as_i64().unwrap() < copy["pointsUsed"].as_i64().unwrap());

    // Switching returns the new variant's numbers, not the old one's.
    let switched = h.call("spec.activate", json!({ "id": blank["id"] }));
    assert_eq!(switched["summary"]["activeSpec"], blank["id"]);
    assert_eq!(switched["summary"]["treeVersion"], json!("3_29"));
    assert_eq!(switched["summary"]["pointsUsed"], blank["pointsUsed"]);
    assert!(switched["stats"].is_array());

    let renamed = h.call("spec.rename", json!({ "id": copy["id"], "title": "Boss tree" }));
    assert_eq!(renamed["spec"]["title"], json!("Boss tree"));

    // Everything is serialised, not just the active variant.
    let xml = h.call("build.save", json!({ "as": "xml" }))["data"].as_str().unwrap().to_string();
    assert_eq!(xml.matches("<Spec ").count(), 3, "all three variants are saved");
    assert!(xml.contains("Boss tree"), "titles survive the round trip");
    assert!(xml.contains("From scratch"));

    // And they survive a reload through a share code.
    let code = h.call("build.save", json!({ "as": "code" }))["data"].clone();
    h.call("build.load", json!({ "code": code }));
    let reloaded = h.call("spec.list", json!({}));
    let titles: Vec<&str> = reloaded["specs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].as_str().unwrap())
        .collect();
    assert!(titles.contains(&"Boss tree"), "reloaded variants: {titles:?}");
    assert_eq!(reloaded["specs"].as_array().unwrap().len(), 3);

    // Delete the active one and the build falls back to a neighbour.
    let active = reloaded["active"].clone();
    let after = h.call("spec.delete", json!({ "id": active }));
    assert_eq!(after["specs"].as_array().unwrap().len(), 2);
    assert_ne!(after["active"], active);
    h.call("spec.delete", json!({ "id": after["specs"][0]["id"] }));

    let last = h.call("spec.list", json!({}))["active"].clone();
    let err = h.call_err("spec.delete", json!({ "id": last }));
    assert_eq!(err["code"], json!(-32602), "the last variant cannot be deleted");
    let err = h.call_err("spec.activate", json!({ "id": "spec-nope" }));
    assert_eq!(err["code"], json!(-32602));
    let err = h.call_err("spec.rename", json!({ "id": "spec-nope", "title": "x" }));
    assert_eq!(err["code"], json!(-32602));
    let err = h.call_err("spec.create", json!({ "treeVersion": "9_99" }));
    assert_eq!(err["code"], json!(-32602));
}

#[test]
fn build_setters_change_the_character() {
    let mut h = host();
    h.call("build.load", json!({ "empty": true }));

    let before = h.call("stats.get", json!({ "keys": ["Life"] }));
    let levelled = h.call("build.setLevel", json!({ "level": 90 }));
    assert_eq!(levelled["summary"]["level"], json!(90));
    assert!(
        stat(&levelled["stats"], "Life") > stat(&before["stats"], "Life"),
        "levels grant life, so the engine must recompute"
    );

    assert_eq!(h.call_err("build.setLevel", json!({ "level": 0 }))["code"], json!(-32602));
    assert_eq!(h.call_err("build.setLevel", json!({ "level": 101 }))["code"], json!(-32602));

    let classed = h.call(
        "build.setClass",
        json!({ "className": "Witch", "ascendClassName": "Occultist" }),
    );
    assert_eq!(classed["summary"]["className"], json!("Witch"));
    assert_eq!(classed["summary"]["ascendClassName"], json!("Occultist"));
    assert_eq!(classed["summary"]["level"], json!(90), "the level survives");

    let cleared = h.call("build.setClass", json!({ "className": "Witch", "ascendClassName": "None" }));
    assert_eq!(cleared["summary"]["ascendClassName"], json!("None"));

    assert_eq!(
        h.call_err("build.setClass", json!({ "className": "Wizard" }))["code"],
        json!(-32602)
    );
    assert_eq!(
        h.call_err("build.setClass", json!({ "className": "Witch", "ascendClassName": "Slayer" }))
            ["code"],
        json!(-32602),
        "an ascendancy from another class is rejected"
    );
}

/// PoB's own class ids: `tree.classes` is keyed by these, `classNameMap` maps
/// names onto them, and `spec.curClassId` holds one (PassiveTree.lua:155-161).
const BASE_CLASSES: [(i64, &str); 7] = [
    (0, "Scion"),
    (1, "Marauder"),
    (2, "Ranger"),
    (3, "Witch"),
    (4, "Duelist"),
    (5, "Templar"),
    (6, "Shadow"),
];

/// Every base class must be offered, Scion included.
///
/// `tree.classes` is 0-based — PassiveTree.lua:95-101 shifts the decoded array
/// down by one so the key is the class id — so walking it with `ipairs` drops
/// Scion (key 0) outright *and* reports every other class one place off its own
/// id. This pins both halves of that, and pins the ids against the only thing
/// that matters: `build.setClass` accepting them.
#[test]
fn ascendancies_cover_every_base_class() {
    let mut h = host();
    h.call("build.load", json!({ "empty": true }));
    let geometry = h.call("tree.geometry", json!({}));
    let ascendancies = geometry["ascendancies"].as_array().unwrap();

    let base: Vec<&Value> = ascendancies.iter().filter(|a| a["alternate"].is_null()).collect();
    assert_eq!(base.len(), 21, "seven classes, three ascendancies each");

    for (class_id, class_name) in BASE_CLASSES {
        let owned: Vec<&&Value> =
            base.iter().filter(|a| a["classId"] == json!(class_id)).collect();
        assert!(
            !owned.is_empty(),
            "nothing exported for class {class_id} ({class_name}); \
             the frontend cannot offer a class it never sees"
        );
        for entry in &owned {
            assert_eq!(
                entry["className"],
                json!(class_name),
                "class {class_id} must be {class_name}, got {}",
                entry["className"]
            );
        }
    }
    assert!(
        base.iter().any(|a| a["id"] == json!("Ascendant")
            && a["classId"] == json!(0)
            && a["className"] == json!("Scion")),
        "Scion's Ascendant is the entry an ipairs walk loses first"
    );

    // Index 0 of each ascendancy list is the "None" entry PoB injects for its
    // dropdown (PassiveTree.lua:160), not an ascendancy.
    for entry in &base {
        assert_ne!(entry["name"], json!("None"), "the dropdown placeholder is not an ascendancy");
        assert!(!entry["id"].as_str().unwrap().is_empty());
    }

    // Alternate/bloodline ascendancies belong to no single class by design.
    let alternate: Vec<&Value> =
        ascendancies.iter().filter(|a| a["alternate"] == json!(true)).collect();
    assert!(!alternate.is_empty(), "the Timeless bloodlines are still exported");
    assert!(
        alternate.iter().all(|a| a["classId"].is_null() && a["className"].is_null()),
        "an alternate ascendancy must not claim a base class"
    );

    // The exported classId is only useful if it is the one the engine validates
    // against, so take each class's first entry straight from the geometry and
    // select it. An empty tree cannot conflict, but pass the choice anyway.
    for (class_id, class_name) in BASE_CLASSES {
        let entry = base.iter().find(|a| a["classId"] == json!(class_id)).unwrap();
        let applied = h.call(
            "build.setClass",
            json!({
                "className": class_name,
                "ascendClassName": entry["id"],
                "onConflict": "reset",
            }),
        );
        assert_eq!(applied["summary"]["className"], json!(class_name));
        // PoB reports the ascendancy's display name, which is not always its id
        // — Ranger's `Raider` is shown as "Warden" (PassiveSpec.lua:605).
        assert_eq!(applied["summary"]["ascendClassName"], entry["name"]);
    }
}

#[test]
fn stats_get_returns_display_stats() {
    let mut h = host();
    load_sample(&mut h);
    let all = h.call("stats.get", json!({}));
    let stats = all["stats"].as_array().unwrap();
    assert!(stats.len() > 15, "a real build shows plenty of stats");
    for row in stats {
        assert!(row["key"].is_string());
        assert!(row["label"].is_string());
        assert!(!row["value"].is_null(), "every row carries a value: {row}");
    }

    let filtered = h.call("stats.get", json!({ "keys": ["Life", "TotalDPS"] }));
    assert_eq!(filtered["stats"].as_array().unwrap().len(), 2);
    assert!(stat(&filtered["stats"], "Life") > 1000.0);
    assert!(stat(&filtered["stats"], "TotalDPS") > 0.0);
}

#[test]
fn tree_geometry_is_cartesian_and_complete() {
    let mut h = host();
    h.call("build.load", json!({ "empty": true }));
    let geometry = h.call("tree.geometry", json!({}));

    assert_eq!(geometry["version"], json!("3_29"));
    assert!(geometry["size"].as_f64().unwrap() > 1000.0);

    let nodes = geometry["nodes"].as_array().unwrap();
    assert!(nodes.len() > 2000, "the tree has thousands of nodes");
    let keystones = nodes.iter().filter(|n| n["type"] == json!("keystone")).count();
    assert!(keystones > 20, "keystones are typed, not lumped in with normals");

    let notable = nodes
        .iter()
        .find(|n| n["type"] == json!("notable") && !n["stats"].as_array().unwrap().is_empty())
        .expect("some notable has stats");
    assert!(notable["radius"].as_f64().unwrap() > 0.0);

    // Icons: two refs, because the game dims an unallocated node by drawing it
    // from a separate desaturated atlas rather than tinting it.
    let active = &notable["icon"]["active"];
    let inactive = &notable["icon"]["inactive"];
    assert_sprite(&geometry, active);
    assert_sprite(&geometry, inactive);
    assert_ne!(
        active["sheet"], inactive["sheet"],
        "the inactive icon comes from the disabled atlas"
    );
    assert!(
        inactive["sheet"].as_str().unwrap().contains("disabled"),
        "got {}",
        inactive["sheet"]
    );
    assert_eq!(active["x"], inactive["x"], "the two atlases share a layout");

    for state in ["allocated", "path", "unallocated"] {
        assert_sprite(&geometry, &notable["frame"][state]);
    }
    assert_ne!(
        notable["frame"]["allocated"], notable["frame"]["unallocated"],
        "the frame is what shows allocation state"
    );

    // Nodes whose whole appearance is the frame have no icon of their own.
    let socket = nodes.iter().find(|n| n["type"] == json!("socket")).unwrap();
    assert!(socket["icon"]["active"].is_null());
    assert_sprite(&geometry, &socket["frame"]["unallocated"]);

    // Polar coordinates resolved: nodes are spread across tree space rather
    // than sitting at their groups' origins.
    let spread = nodes.iter().map(|n| n["x"].as_f64().unwrap()).fold(f64::MIN, f64::max);
    assert!(spread > 1000.0, "coordinates are in tree space, not orbit indices");

    let connectors = geometry["connectors"].as_array().unwrap();
    assert!(connectors.len() > 5000);
    let arc = connectors
        .iter()
        .find(|c| c["sheet"].as_str().unwrap().starts_with("Orbit"))
        .expect("orbit arcs exist");
    assert_eq!(arc["verts"].as_array().unwrap().len(), 4);
    assert_eq!(arc["uvs"].as_array().unwrap().len(), 4);
    // A quad built from the headless 1x1 image stub collapses to a couple of
    // units across; a real one spans its orbit. This guards that fix.
    let width =
        (arc["verts"][0]["x"].as_f64().unwrap() - arc["verts"][2]["x"].as_f64().unwrap()).abs();
    assert!(width > 20.0, "orbit arcs must be sized from real artwork, got {width}");

    for state in ["normal", "intermediate", "active"] {
        assert!(
            connectors.iter().any(|c| c["state"] == json!(state)),
            "every art state is exported so the renderer can swap without a refetch"
        );
    }

    // Connector art is named the same way, so one lookup rule covers everything.
    assert_sprite(&geometry, &geometry["sprites"][arc["sheet"].as_str().unwrap()]);

    let groups = geometry["groups"].as_array().unwrap();
    assert!(groups.len() > 100);
    assert!(groups.iter().any(|g| !g["orbits"].as_array().unwrap().is_empty()));
    let backdrop = groups
        .iter()
        .find(|g| !g["background"].as_str().unwrap().is_empty())
        .expect("groups have backdrops");
    assert_sprite(&geometry, &geometry["sprites"][backdrop["background"].as_str().unwrap()]);

    // The class illustrations, without which the tree reads as a bare graph.
    let extra = geometry["extraImages"].as_array().unwrap();
    assert!(!extra.is_empty(), "extraImages carries the class art");
    assert!(extra.iter().all(|i| i["image"].is_string() && i["x"].is_number()));

    // Masteries carry their chooser's options; nothing else does.
    let mastery = nodes
        .iter()
        .find(|n| n["type"] == json!("mastery") && n["masteryEffects"].is_array())
        .expect("the tree has masteries");
    let effects = mastery["masteryEffects"].as_array().unwrap();
    assert!(effects.len() > 1, "a mastery offers a choice");
    for effect in effects {
        assert!(effect["id"].is_number());
        assert!(!effect["stats"].as_array().unwrap().is_empty());
        assert_eq!(effect["available"], json!(true), "nothing is taken yet");
    }
    assert!(
        notable["masteryEffects"].is_null(),
        "only masteries carry effects"
    );

    // An explicit older version loads on demand.
    let old = h.call("tree.geometry", json!({ "version": "3_13" }));
    assert_eq!(old["version"], json!("3_13"));
    assert!(old["nodes"].as_array().unwrap().len() > 1000);

    let err = h.call_err("tree.geometry", json!({ "version": "9_99" }));
    assert_eq!(err["code"], json!(-32602));
}

#[test]
fn tree_path_routes_from_the_allocated_tree() {
    let mut h = host();
    load_sample(&mut h);
    let target = power_pass(&mut h, "offence", 2)
        .into_iter()
        .find(|n| n["pathCost"] == json!(2))
        .expect("some node is two points away");

    let path = h.call("tree.path", json!({ "to": target["id"] }));
    assert_eq!(path["cost"], json!(2));
    let route = path["path"].as_array().unwrap();
    assert!(route.len() >= 2, "a two-point route names at least two nodes");
    assert_eq!(route.last().unwrap(), &target["id"], "the target ends the route");

    // An already-allocated node costs nothing to reach.
    let allocated = h.call("build.summary", json!({}))["allocated"].clone();
    let existing = allocated.as_array().unwrap()[10].clone();
    let none = h.call("tree.path", json!({ "to": existing }));
    assert_eq!(none["cost"], json!(0));
    assert!(none["path"].as_array().unwrap().is_empty());

    let err = h.call_err("tree.path", json!({ "to": 999_999_999i64 }));
    assert_eq!(err["code"], json!(-32602));
}

/// The end-to-end claim: load, read stats, allocate, read stats again, and the
/// numbers must move in the direction the engine says they will.
#[test]
fn allocating_a_node_raises_dps() {
    let mut h = host();
    let loaded = load_sample(&mut h);
    let before_allocation = loaded["allocated"].clone();
    let before_points = loaded["pointsUsed"].as_i64().unwrap();
    let before = h.call("stats.get", json!({ "keys": ["TotalDPS"] }));
    let before_dps = stat(&before["stats"], "TotalDPS");

    // Ask the engine which single point is worth the most, then spend it.
    let mut ranked = power_pass(&mut h, "offence", 1);
    ranked.sort_by(|a, b| {
        b["perPoint"].as_f64().unwrap().total_cmp(&a["perPoint"].as_f64().unwrap())
    });
    let best = ranked.first().expect("at least one reachable node").clone();
    assert!(
        best["perPoint"].as_f64().unwrap() > 0.0,
        "the best single point should be an improvement, got {best}"
    );

    let allocated = h.call("tree.allocate", json!({ "nodes": [best["id"]] }));
    assert_eq!(
        allocated["summary"]["pointsUsed"].as_i64().unwrap(),
        before_points + 1,
        "one more point is spent"
    );
    assert!(allocated["summary"]["allocated"]
        .as_array()
        .unwrap()
        .contains(&best["id"]));
    let after_dps = stat(&allocated["stats"], "TotalDPS");
    assert!(
        after_dps > before_dps,
        "allocating the highest-power node must raise DPS: {before_dps} -> {after_dps}"
    );

    // The same delta, asked for the other way round.
    let compared = h.call(
        "stats.get",
        json!({ "keys": ["TotalDPS"], "compareTo": before_allocation }),
    );
    let delta = compared["stats"].as_array().unwrap()[0]["delta"].as_f64().unwrap();
    assert!(
        (delta - (after_dps - before_dps)).abs() < 1.0,
        "compareTo delta ({delta}) should match the observed change ({})",
        after_dps - before_dps
    );

    // And undoing it puts the numbers back.
    let deallocated = h.call("tree.deallocate", json!({ "nodes": [best["id"]] }));
    assert_eq!(deallocated["summary"]["pointsUsed"].as_i64().unwrap(), before_points);
    assert!(
        (stat(&deallocated["stats"], "TotalDPS") - before_dps).abs() < 1.0,
        "deallocating restores the original DPS"
    );
    assert!(deallocated["orphaned"].as_array().unwrap().is_empty());

    let err = h.call_err("tree.allocate", json!({ "nodes": [] }));
    assert_eq!(err["code"], json!(-32602));
    let err = h.call_err("tree.allocate", json!({ "nodes": [123_456_789] }));
    assert_eq!(err["code"], json!(-32602));
}

#[test]
fn deallocating_a_junction_reports_orphans() {
    let mut h = host();
    load_sample(&mut h);
    // Walk out three points, then cut the near end: the rest is orphaned.
    let far = power_pass(&mut h, "offence", 3)
        .into_iter()
        .find(|n| n["pathCost"] == json!(3))
        .expect("some node is three points away");

    let path = h.call("tree.path", json!({ "to": far["id"] }));
    let route: Vec<Value> = path["path"].as_array().unwrap().clone();
    h.call("tree.allocate", json!({ "nodes": [far["id"]] }));

    let result = h.call("tree.deallocate", json!({ "nodes": [route[0]] }));
    let orphaned = result["orphaned"].as_array().unwrap();
    assert!(
        orphaned.contains(route.last().unwrap()),
        "cutting the near end of a spur orphans its far end: {orphaned:?}"
    );
}

/// Masteries are a different mechanic: you pick an effect, each effect can be
/// used once across the tree, and the choice has to survive a save.
#[test]
fn masteries_are_chosen_not_allocated() {
    let mut h = host();
    h.call("build.load", json!({ "empty": true }));
    let geometry = h.call("tree.geometry", json!({}));
    let mastery = geometry["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["type"] == json!("mastery") && n["masteryEffects"].is_array())
        .expect("the tree has masteries")
        .clone();
    let node = mastery["id"].clone();
    let effect = mastery["masteryEffects"][0]["id"].clone();

    // Clicking a mastery must not spend a point on nothing.
    let err = h.call_err("tree.allocate", json!({ "nodes": [node] }));
    assert_eq!(err["code"], json!(-32602));
    assert!(err["message"].as_str().unwrap().contains("setMastery"));

    let route = h.call("tree.path", json!({ "to": node }));
    let cost = route["cost"].as_i64().unwrap();

    let chosen = h.call("tree.setMastery", json!({ "node": node, "effect": effect }));
    assert_eq!(
        chosen["summary"]["masterySelections"][node.as_i64().unwrap().to_string()],
        effect,
        "the selection is reported against its node"
    );
    assert_eq!(
        chosen["summary"]["pointsUsed"].as_i64().unwrap(),
        cost,
        "choosing an effect allocates the mastery and its path"
    );

    // Availability is restated for the whole tree, because one choice can
    // remove an option from a chooser somewhere else.
    let restated = &chosen["masteryEffects"];
    assert!(restated.as_object().unwrap().len() > 100, "every mastery is restated");
    let blocked = restated
        .as_object()
        .unwrap()
        .iter()
        .filter(|(id, effects)| {
            *id != &node.as_i64().unwrap().to_string()
                && effects.as_array().unwrap().iter().any(|e| e["id"] == effect && !e["available"].as_bool().unwrap())
        })
        .count();
    assert!(blocked > 0, "the chosen effect is taken off other masteries");
    assert!(
        restated[node.as_i64().unwrap().to_string()]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == effect && e["available"].as_bool().unwrap()),
        "it stays selectable on the mastery that has it"
    );

    // A save that loses mastery choices is silently wrong.
    let xml = h.call("build.save", json!({ "as": "xml" }))["data"].as_str().unwrap().to_string();
    assert!(
        xml.contains(&format!("{{{},{}}}", node, effect)),
        "masteryEffects attribute is written: {}",
        &xml[..200.min(xml.len())]
    );
    let code = h.call("build.save", json!({ "as": "code" }))["data"].clone();
    let reloaded = h.call("build.load", json!({ "code": code }));
    assert_eq!(
        reloaded["masterySelections"][node.as_i64().unwrap().to_string()],
        effect,
        "the choice survives a share code round trip"
    );

    // Clearing it releases both the point and the effect.
    let cleared = h.call("tree.setMastery", json!({ "node": node, "effect": null }));
    assert_eq!(cleared["summary"]["masterySelections"], json!({}));
    assert_eq!(cleared["summary"]["pointsUsed"].as_i64().unwrap(), cost - 1);

    assert_eq!(
        h.call_err("tree.setMastery", json!({ "node": node, "effect": 1 }))["code"],
        json!(-32602),
        "an effect the node does not offer is rejected"
    );
    let notable = geometry["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["type"] == json!("notable"))
        .unwrap()["id"]
        .clone();
    assert_eq!(
        h.call_err("tree.setMastery", json!({ "node": notable, "effect": null }))["code"],
        json!(-32602)
    );
}

#[test]
fn tree_search_matches_names_and_stats() {
    let mut h = host();
    load_sample(&mut h);
    let by_stat = h.call("tree.search", json!({ "query": "increased chaos damage" }));
    let matches = by_stat["matches"].as_array().unwrap();
    assert!(!matches.is_empty(), "a common modifier should match nodes");

    // Quoted phrases are exact, as in PoB, so they cannot match more.
    let quoted = h.call("tree.search", json!({ "query": "\"increased chaos damage\"" }));
    assert!(quoted["matches"].as_array().unwrap().len() <= matches.len());

    let nothing = h.call("tree.search", json!({ "query": "zzzznotathing" }));
    assert!(nothing["matches"].as_array().unwrap().is_empty());
    let blank = h.call("tree.search", json!({ "query": "  " }));
    assert!(blank["matches"].as_array().unwrap().is_empty());

    let err = h.call_err("tree.search", json!({ "query": 7 }));
    assert_eq!(err["code"], json!(-32602));
}

#[test]
fn tree_power_streams_nearest_first_and_can_be_cancelled() {
    let mut h = host();
    load_sample(&mut h);
    let started = h.call("tree.power", json!({ "metric": "offence", "maxDepth": 2 }));
    let requested = started["requested"].as_i64().unwrap();
    assert!(requested > 50);

    let stream = h.drain_until("tree.power.done");
    let progress: Vec<&Value> = stream
        .iter()
        .filter(|m| m["method"] == json!("tree.power.progress"))
        .collect();
    assert!(progress.len() > 1, "results arrive in chunks, not one lump");

    let mut previous_distance = 0;
    let mut counted = 0;
    for message in &progress {
        assert_eq!(message["params"]["total"].as_i64().unwrap(), requested);
        let nodes = message["params"]["nodes"].as_array().unwrap();
        counted += nodes.len();
        let nearest = nodes.iter().map(|n| n["pathCost"].as_i64().unwrap()).min().unwrap();
        assert!(nearest >= previous_distance, "batches walk outwards by path distance");
        previous_distance = nearest;

        let ranks: Vec<f64> = nodes.iter().map(|n| n["perPoint"].as_f64().unwrap()).collect();
        assert!(
            ranks.windows(2).all(|w| w[0] >= w[1]),
            "each batch is ordered highest first"
        );
        for node in nodes {
            assert!(node["offence"].is_number() && node["defence"].is_number());
            assert!(node["pathCost"].as_i64().unwrap() >= 1);
        }
    }
    assert_eq!(counted as i64, requested, "every requested node is reported");

    let done = stream.last().unwrap();
    assert_eq!(done["params"]["total"].as_i64().unwrap(), requested);
    assert!(done["params"]["elapsedMs"].as_f64().unwrap() >= 0.0);

    // A different metric ranks a different axis.
    assert!(power_pass(&mut h, "defence", 1)
        .iter()
        .any(|n| n["defence"].as_f64().unwrap() > 0.0));

    // Cancelling a deep pass stops it early and still closes the stream.
    let deep = h.call("tree.power", json!({ "metric": "offence", "maxDepth": 6 }));
    let deep_total = deep["requested"].as_i64().unwrap();
    assert!(deep_total > 500, "the cancelled pass is a long one");
    let (cancel, notifications) = h.call_raw("tree.powerCancel", json!({}));
    assert!(cancel["error"].is_null());
    let mut closed = notifications.iter().any(|m| m["method"] == json!("tree.power.done"));
    if !closed {
        closed = h
            .drain_until("tree.power.done")
            .iter()
            .any(|m| m["method"] == json!("tree.power.done"));
    }
    assert!(closed, "cancelling still emits a done notification");
    let reported: usize = notifications
        .iter()
        .filter(|m| m["method"] == json!("tree.power.progress"))
        .map(|m| m["params"]["nodes"].as_array().unwrap().len())
        .sum();
    assert!(
        (reported as i64) < deep_total,
        "cancelling stopped the pass before it finished ({reported} of {deep_total})"
    );

    // Cancelling when nothing is running is a no-op, not an error.
    assert_eq!(h.call("tree.powerCancel", json!({})), json!({}));
    assert_eq!(h.call("tree.optimiseCancel", json!({})), json!({}));

    // A cancel naming a pass that already finished is also a no-op: the client
    // cannot know the stream ended between its two writes.
    let running = h.call("tree.power", json!({ "metric": "offence", "maxDepth": 1 }));
    assert!(running["requested"].as_i64().unwrap() > 0);
    assert_eq!(h.call("tree.powerCancel", json!({ "id": 999_999 })), json!({}));
    h.drain_until("tree.power.done");

    let err = h.call_err("tree.power", json!({ "maxDepth": 0 }));
    assert_eq!(err["code"], json!(-32602));
}

#[test]
fn tree_jewels_reports_radius_overlays() {
    let mut h = host();
    load_sample(&mut h);

    let j = h.call("tree.jewels", json!({}));
    let sockets = j["sockets"].as_array().unwrap();
    assert!(!sockets.is_empty(), "the tree has jewel sockets");

    // Every radius a jewel could have, for the hover preview. 3.16+ ships
    // Small/Medium/Large/Very Large/Massive plus the Thread of Hope annuli.
    let options = j["options"].as_array().unwrap();
    assert!(options.len() >= 5, "got {} radius options", options.len());
    assert!(
        options.iter().any(|o| o["label"] == json!("Large")),
        "the named sizes come through"
    );
    assert!(
        options.iter().any(|o| o["inner"].as_f64().unwrap() > 0.0),
        "Thread of Hope's annuli have a non-zero inner radius"
    );
    for o in options {
        assert!(o["outer"].as_f64().unwrap() > 0.0);
        // Colours are plain hex, not PoB's "^xBB6600" draw escape.
        if let Some(c) = o["colour"].as_str() {
            assert_eq!(c.len(), 6, "colour should be six hex digits, got {c}");
            assert!(c.chars().all(|ch| ch.is_ascii_hexdigit()));
        }
    }

    // A socket without a radius is reported without those fields rather than
    // omitted: cluster jewels make subgraphs and plain jewels have no radius,
    // so this is the common case and the client still needs the socket.
    for sock in sockets {
        assert!(sock["node"].as_i64().is_some());
        assert!(sock["allocated"].is_boolean());
        if sock["outer"].is_null() {
            assert!(sock["art"].is_null(), "no radius means no ring art");
        } else {
            assert!(sock["outer"].as_f64().unwrap() > 0.0);
            assert!(!sock["art"].as_str().unwrap().is_empty());
        }
    }
}

#[test]
fn tree_optimise_suggests_points_without_spending_them() {
    let mut h = host();
    let loaded = load_sample(&mut h);
    let before = loaded["pointsUsed"].as_i64().unwrap();

    // A cancel aimed at the other job kind must not touch this one.
    h.call("tree.optimise", json!({ "budget": 2, "metric": "offence" }));
    assert_eq!(h.call("tree.powerCancel", json!({})), json!({}));
    let stream = h.drain_until("tree.optimise.done");
    assert!(stream.iter().any(|m| m["method"] == json!("tree.optimise.progress")));
    let done = stream.last().unwrap();
    let best = &done["params"]["best"];
    assert!(!best["nodes"].as_array().unwrap().is_empty(), "it found something");
    assert!(best["gain"].as_f64().unwrap() > 0.0, "the suggestion is an improvement");

    let after = h.call("build.summary", json!({}));
    assert_eq!(
        after["pointsUsed"].as_i64().unwrap(),
        before,
        "optimise leaves the build untouched; the client applies the suggestion"
    );

    let err = h.call_err("tree.optimise", json!({ "budget": 0 }));
    assert_eq!(err["code"], json!(-32602));
}

/// Run an optimise pass and report (gain, nodes suggested, nodes evaluated).
fn optimise(h: &mut Host, budget: i64, beam_width: Option<i64>) -> (f64, usize, i64) {
    let mut params = json!({ "budget": budget, "metric": "offence" });
    if let Some(w) = beam_width {
        params["beamWidth"] = json!(w);
    }
    h.call("tree.optimise", params);
    let stream = h.drain_until("tree.optimise.done");
    let explored = stream
        .iter()
        .filter(|m| m["method"] == json!("tree.optimise.progress"))
        .filter_map(|m| m["params"]["explored"].as_i64())
        .max()
        .unwrap_or(0);
    let best = &stream.last().unwrap()["params"]["best"];
    (
        best["gain"].as_f64().unwrap(),
        best["nodes"].as_array().unwrap().len(),
        explored,
    )
}

#[test]
fn tree_optimise_beam_widens_the_search() {
    let mut h = host();
    let loaded = load_sample(&mut h);
    let before = loaded["pointsUsed"].as_i64().unwrap();

    let (greedy_gain, greedy_nodes, greedy_explored) = optimise(&mut h, 4, Some(1));
    let (beam_gain, beam_nodes, beam_explored) = optimise(&mut h, 4, Some(3));

    // A wider beam is only meaningful if it actually looks at more states.
    assert!(
        beam_explored > greedy_explored,
        "beam evaluated {beam_explored} states, greedy {greedy_explored}"
    );
    assert!(greedy_nodes > 0 && beam_nodes > 0, "both found a suggestion");

    // Never worse than greedy: rank 1 is always admitted past the per-parent
    // cap, so the greedy trajectory stays in the beam. A small tolerance covers
    // float noise in the combined off/def stat.
    //
    // Note it is not asserted to be *better*. Measured on this build the beam
    // returns an identical answer at 3.4x the cost (budget 8, beamWidth 4:
    // 1,248 evaluations in 19.1s against 384 in 5.7s, +0.0000%). Marginal node
    // values here are near-additive, and greedy is already optimal for that.
    // See the note above `tree.optimise` in power.lua.
    assert!(
        beam_gain >= greedy_gain - 1e-6,
        "beam {beam_gain} regressed against greedy {greedy_gain}"
    );

    // Widening the search must not leak allocations into the build either.
    let after = h.call("build.summary", json!({}));
    assert_eq!(after["pointsUsed"].as_i64().unwrap(), before);

    for bad in [0, 9] {
        let err = h.call_err("tree.optimise", json!({ "budget": 2, "beamWidth": bad }));
        assert_eq!(err["code"], json!(-32602), "beamWidth {bad} is rejected");
    }
}

#[test]
fn malformed_traffic_never_kills_the_host() {
    let mut h = host();

    let err = h.call_err("no.such.method", json!({}));
    assert_eq!(err["code"], json!(-32601));
    assert!(err["message"].as_str().unwrap().contains("no.such.method"));

    h.send_raw("{not json at all");
    assert_eq!(h.read()["error"]["code"], json!(-32700));

    h.send_raw(r#"{"jsonrpc":"2.0","id":9001}"#);
    assert_eq!(h.read()["error"]["code"], json!(-32600));

    // A blank line is ignored rather than answered, and does not desync.
    h.send_raw("");
    h.send("host.info", json!({}));
    assert!(!h.read()["result"].is_null());

    // Params of the wrong shape are rejected without reaching the engine.
    assert_eq!(h.call_err("stats.get", json!({ "keys": 5 }))["code"], json!(-32602));
    assert_eq!(
        h.call_err("tree.allocate", json!({ "nodes": ["nope"] }))["code"],
        json!(-32602)
    );

    let still_alive = h.call("host.info", json!({}));
    assert!(!still_alive["hostVersion"].is_null(), "the host survived all of that");
}

/// Serialising a build and loading it back must not change a single number.
///
/// `share_codes_round_trip_through_real_zlib` proves the *bytes* survive — that
/// our Deflate is readable by a stock zlib and the code and XML agree. This is
/// the different question the plan's verification asks: does the build still
/// *compute the same*? A config flag or a mastery selection dropped on the way
/// out changes DPS while the XML still round-trips perfectly, and nothing in a
/// byte-level test would notice.
#[test]
fn a_saved_build_reloads_to_identical_stats() {
    let mut h = host();
    load_sample(&mut h);

    let before = h.call("stats.get", json!({}))["stats"].clone();
    let rows = before.as_array().expect("stats is an array");
    assert!(rows.len() > 15, "the sample build must produce real stats");

    let code = h.call("build.save", json!({ "as": "code" }));
    let reloaded = h.call("build.load", json!({ "code": code["data"] }));
    assert_eq!(reloaded["className"], json!("Witch"));

    let after = h.call("stats.get", json!({}))["stats"].clone();

    // Compared as whole rows, keyed, so a stat that disappears entirely fails
    // just as loudly as one whose value drifts.
    let index = |v: &Value| -> std::collections::BTreeMap<String, Value> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| (r["key"].as_str().unwrap_or_default().to_string(), r.clone()))
            .collect()
    };
    let (a, b) = (index(&before), index(&after));

    let lost: Vec<&String> = a.keys().filter(|k| !b.contains_key(*k)).collect();
    assert!(lost.is_empty(), "stats vanished across a round trip: {lost:?}");
    let gained: Vec<&String> = b.keys().filter(|k| !a.contains_key(*k)).collect();
    assert!(gained.is_empty(), "stats appeared across a round trip: {gained:?}");

    for (key, row) in &a {
        assert_eq!(
            row["value"], b[key]["value"],
            "{key} changed when the build was saved and reloaded"
        );
    }
}
