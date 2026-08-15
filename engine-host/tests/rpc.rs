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

/// The stat panel reports one skill, and this is what says which.
///
/// The load-bearing assertion is that switching socket group *moves the DPS*.
/// A projection that merely lists the groups would pass a shape check while
/// leaving `build.mainSocketGroup` untouched, and the panel would keep
/// reporting the old skill under a new label.
#[test]
fn main_skill_selection_picks_which_skill_the_stats_describe() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let sel = h.call("skills.mainSelection", json!({}));
    assert_eq!(sel["empty"], json!(false), "an imported character has gems");
    let groups = sel["groups"].as_array().expect("groups is an array");
    assert!(
        groups.len() > 1,
        "the sample character needs several socket groups to switch between, got {}",
        groups.len()
    );
    for (i, g) in groups.iter().enumerate() {
        assert_eq!(g["index"], json!(i + 1), "group indices are 1-based and dense");
        assert!(
            g["label"].as_str().is_some_and(|s| !s.is_empty()),
            "every group needs a label to be pickable: {g}"
        );
        assert!(
            !g["label"].as_str().unwrap().contains('^'),
            "labels must have PoB's colour codes stripped: {g}"
        );
    }
    assert!(sel["skill"]["options"].as_array().is_some_and(|o| !o.is_empty()));

    // Walk every group and keep the stats each one reports. At least two must
    // differ, or the setter is not actually changing what is being calculated.
    //
    // The whole stat set is compared rather than one key, because which keys
    // exist is itself skill-dependent — an aura group has no damage stats at
    // all, so naming one would only test the groups that happen to have it.
    let mut seen = Vec::new();
    for g in groups {
        let index = g["index"].as_i64().unwrap();
        let res = h.call("build.setMainSkill", json!({ "group": index }));
        assert_eq!(
            res["mainSkill"]["groupIndex"],
            json!(index),
            "the setter must report back the group it selected"
        );
        seen.push(res["stats"].clone());
    }
    assert!(
        seen.windows(2).any(|w| w[0] != w[1]),
        "switching socket group changed no stat in any of the {} groups, so \
         build.mainSocketGroup is not reaching the engine",
        seen.len()
    );

    // The projection ships with the setter's own response, because changing the
    // skill changes which controls exist at all.
    let back = h.call("build.setMainSkill", json!({ "group": 1 }));
    assert_eq!(back["mainSkill"], h.call("skills.mainSelection", json!({})));

    // Indices are validated against the live lists rather than trusted.
    assert_eq!(h.call_err("build.setMainSkill", json!({ "group": 0 }))["code"], json!(-32602));
    assert_eq!(
        h.call_err("build.setMainSkill", json!({ "group": 9999 }))["code"],
        json!(-32602)
    );
    assert_eq!(h.call_err("build.setMainSkill", json!({ "skill": 9999 }))["code"], json!(-32602));

    // A build with no gems is a real state, not a failure: PoB shows a
    // placeholder rather than an error (Build.lua:1557-1564).
    h.call("build.load", json!({ "empty": true }));
    let bare = h.call("skills.mainSelection", json!({}));
    assert_eq!(bare["empty"], json!(true));
    assert_eq!(bare["groups"], json!([]));
    assert!(bare["skill"].is_null(), "nothing to choose between: {bare}");
    assert_eq!(
        h.call_err("build.setMainSkill", json!({ "group": 1 }))["code"],
        json!(-32602),
        "selecting a group in a build that has none is a bad request, not a crash"
    );
}

/// Socket groups and gems — visible at last, and editable.
///
/// The load-bearing assertion is that adding a support gem raises the DPS of
/// the skill it supports. A projection that merely listed gems would pass a
/// shape check while writing into a `gemList` nothing ever re-reads.
#[test]
fn gems_can_be_read_and_edited() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let skills = h.call("skills.list", json!({}));
    let groups = skills["groups"].as_array().expect("groups is an array");
    assert!(!groups.is_empty(), "an imported character has socket groups");
    assert!(
        groups.iter().any(|g| !g["gems"].as_array().unwrap().is_empty()),
        "every socket group came back empty, so gemList is not being read"
    );

    // A resolved gem carries what the engine worked out, not just what was typed.
    let resolved = groups
        .iter()
        .flat_map(|g| g["gems"].as_array().unwrap())
        .find(|gem| gem["name"].is_string())
        .expect("at least one gem must resolve");
    assert!(resolved["level"].as_i64().unwrap() >= 1);
    assert!(resolved["maxLevel"].as_i64().is_some());
    assert!(
        matches!(resolved["colour"].as_str(), Some("R" | "G" | "B")),
        "a resolved gem needs a socket colour: {resolved}"
    );

    let catalogue = h.call("skills.gemCatalogue", json!({}));
    let gems = catalogue["gems"].as_array().unwrap();
    assert!(gems.len() > 300, "expected the full gem list, got {}", gems.len());

    // Filtered as PoB filters it (`GemSelectControl.lua:105-135`). Offering a
    // gem PoB never shows anyone is a dead end the user cannot diagnose.
    assert!(
        gems.iter().all(|g| g["legacy"] == json!(false)),
        "legacy gems are hidden by default"
    );
    let with_legacy = h.call("skills.gemCatalogue", json!({ "showLegacy": true }));
    assert!(
        with_legacy["gems"].as_array().unwrap().len() > gems.len(),
        "showLegacy must actually widen the list"
    );
    assert!(
        gems.iter().any(|g| g["exceptional"] == json!(true)),
        "the catalogue must mark exceptional/awakened gems so they can be filtered"
    );
    assert!(
        gems.windows(2).all(|w| w[0]["name"].as_str() <= w[1]["name"].as_str()),
        "the catalogue must be sorted; `data.gems` iteration order is not stable"
    );
    let find = |name: &str| {
        gems.iter()
            .find(|g| g["name"] == json!(name))
            .unwrap_or_else(|| panic!("{name} missing from the catalogue"))
    };
    assert_eq!(find("Fireball")["support"], json!(false));
    // Note the name: `data.gems` stores most support gems *without* the
    // " Support" suffix the game shows ("Added Lightning Damage", not "Added
    // Lightning Damage Support"). Only ones that collide with an active skill
    // keep it, e.g. "Barrage Support". `support` is the reliable signal, not
    // the name — and this is PoB's own picker behaviour, so it is what to match.
    let added_damage = find("Added Lightning Damage");
    assert_eq!(added_damage["support"], json!(true));

    // Build a group from nothing: an active skill, then a support for it.
    let created = h.call("skills.addGroup", json!({ "label": "test group" }));
    let gi = created["addedGroup"].as_i64().unwrap();
    let fireball = find("Fireball")["id"].clone();

    let with_skill = h.call("skills.setGem", json!({ "group": gi, "gem": 1, "gemId": fireball }));
    let group = &with_skill["skills"]["groups"][(gi - 1) as usize];
    assert_eq!(group["label"], json!("test group"));
    assert_eq!(group["gems"][0]["name"], json!("Fireball"));
    assert!(
        group["gems"][0]["level"].as_i64().unwrap() > 1,
        "a new gem takes its natural level, not 1: {}",
        group["gems"][0]
    );

    // Point the stats at it, then support it and watch the damage move.
    h.call("build.setMainSkill", json!({ "group": gi }));
    let before = stat(&h.call("stats.get", json!({}))["stats"], "TotalDPS");
    let supported = h.call(
        "skills.setGem",
        json!({ "group": gi, "gem": 2, "gemId": added_damage["id"].clone() }),
    );
    assert_eq!(supported["skills"]["groups"][(gi - 1) as usize]["gems"][1]["support"], json!(true));
    assert!(
        stat(&supported["stats"], "TotalDPS") > before,
        "Added Lightning Damage must raise Fireball's hit DPS: {before} unchanged"
    );

    // Disabling the support puts it back.
    let disabled = h.call("skills.setGem", json!({ "group": gi, "gem": 2, "enabled": false }));
    assert_eq!(stat(&disabled["stats"], "TotalDPS"), before);

    // Level and quality reach the calculator too.
    let levelled = h.call("skills.setGem", json!({ "group": gi, "gem": 1, "level": 1 }));
    assert!(
        stat(&levelled["stats"], "TotalDPS") < before,
        "a level 1 Fireball must do less damage than a natural-level one"
    );

    // Deleting a gem renumbers the rest.
    let deleted = h.call("skills.deleteGem", json!({ "group": gi, "gem": 1 }));
    let after = &deleted["skills"]["groups"][(gi - 1) as usize];
    assert_eq!(after["gems"].as_array().unwrap().len(), 1);
    assert_eq!(after["gems"][0]["support"], json!(true), "the support is all that is left");

    // Deleting a group below the main-skill pointer must not silently repoint
    // the stat panel at a different skill.
    h.call("build.setMainSkill", json!({ "group": gi }));
    let removed = h.call("skills.deleteGroup", json!({ "group": 1 }));
    assert_eq!(
        removed["skills"]["groups"].as_array().unwrap().len(),
        groups.len(),
        "one added, one removed"
    );
    assert_eq!(
        removed["mainSkill"]["groupIndex"].as_i64().unwrap(),
        gi - 1,
        "the main-skill pointer must follow its group when an earlier one goes"
    );

    // Bad input is rejected rather than corrupting the list.
    assert_eq!(h.call_err("skills.setGem", json!({ "group": 9999, "gem": 1 }))["code"], json!(-32602));
    assert_eq!(
        h.call_err("skills.setGem", json!({ "group": 1, "gem": 99, "gemId": "x" }))["code"],
        json!(-32602)
    );
    assert_eq!(
        h.call_err("skills.setGem", json!({ "group": 1, "gem": 1, "gemId": "not-a-gem" }))["code"],
        json!(-32602)
    );
    assert_eq!(h.call_err("skills.deleteGem", json!({ "group": 1, "gem": 0 }))["code"], json!(-32602));
}

/// The config options, and the two that are a live correctness bug.
///
/// Bandit and pantheon can only be imported over OAuth, so a character brought
/// in any other way silently keeps whatever the build already had — worth two
/// passive points and a chunk of defences. The assertion that matters is that
/// switching bandit to Oak *changes the numbers*, because that is the proof the
/// value reached the calculator rather than just the input table.
#[test]
fn config_options_are_exposed_and_change_the_build() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let schema = h.call("config.schema", json!({}));
    let sections = schema["sections"].as_array().expect("sections is an array");
    assert!(sections.len() >= 6, "PoB groups options into 7 sections, got {}", sections.len());

    // Every option must be renderable from the schema alone: a type the client
    // knows, a label, and — for a dropdown — the values it accepts.
    let known = ["check", "count", "integer", "countAllowZero", "float", "list", "text"];
    let mut total = 0;
    for section in sections {
        assert!(section["name"].as_str().is_some_and(|s| !s.is_empty()));
        for opt in section["options"].as_array().unwrap() {
            total += 1;
            let ty = opt["type"].as_str().unwrap_or("");
            assert!(known.contains(&ty), "unrenderable option type {ty:?} in {opt}");
            assert!(opt["var"].as_str().is_some_and(|s| !s.is_empty()), "{opt}");
            assert!(opt["label"].as_str().is_some_and(|s| !s.is_empty()), "{opt}");
            assert!(
                !opt["label"].as_str().unwrap().contains('^'),
                "colour codes must be stripped: {opt}"
            );
            if ty == "list" {
                assert!(
                    opt["list"].as_array().is_some_and(|l| !l.is_empty()),
                    "a list option with no options: {opt}"
                );
            }
        }
    }
    assert!(total > 500, "expected ~1000 config options, got {total}");

    // Visibility is decided here, not in the client, and it is a real filter:
    // most options do not apply to any one build.
    let state = h.call("config.state", json!({}));
    let shown = state["shown"].as_object().expect("shown is a map");
    assert!(!shown.is_empty(), "nothing at all is applicable, which cannot be right");
    assert!(
        shown.len() < total,
        "every one of {total} options claims to apply; the predicates are not being evaluated"
    );

    // Bandit is always applicable — it is not conditional on anything.
    assert!(shown.contains_key("bandit"), "bandit must always be offered");
    assert!(shown.contains_key("pantheonMajorGod"));
    assert!(shown.contains_key("pantheonMinorGod"));

    // Kraityn is the bandit whose reward this particular character can show:
    // `MovementSpeed INC 8` (CalcSetup.lua:552-553) lands in a stat the panel
    // already reports. Oak's `Life BASE 40` would be invisible here, because
    // the sample build is Chaos Inoculation and its life is pinned to 1.
    let before = stat(&h.call("stats.get", json!({}))["stats"], "EffectiveMovementSpeedMod");
    let kraityn = h.call("config.set", json!({ "values": { "bandit": "Kraityn" } }));
    assert_eq!(kraityn["config"]["values"]["bandit"], json!("Kraityn"));
    assert!(
        stat(&kraityn["stats"], "EffectiveMovementSpeedMod") > before,
        "helping Kraityn grants 8% increased movement speed, so the stat must rise \
         — the value reached the input table but not the calculator"
    );

    // Killing them all instead grants a passive point, which the *other* branch
    // of the same code path adds (`ExtraPoints`, CalcSetup.lua:556-557).
    let points = h.call("build.summary", json!({}))["pointsTotal"].as_i64().unwrap();
    let killed = h.call("config.set", json!({ "values": { "bandit": "None" } }));
    assert_eq!(killed["config"]["values"]["bandit"], json!("None"));
    assert_eq!(
        killed["summary"]["pointsTotal"].as_i64().unwrap(),
        points + 1,
        "killing all the bandits is worth a passive point"
    );

    let major = h.call("config.set", json!({ "values": { "pantheonMajorGod": "TheBrineKing" } }));
    assert_eq!(major["config"]["values"]["pantheonMajorGod"], json!("TheBrineKing"));

    // Several at once, so importing quest choices costs one recalculation.
    let both = h.call(
        "config.set",
        json!({ "values": { "bandit": "Alira", "pantheonMinorGod": "Yugul" } }),
    );
    assert_eq!(both["config"]["values"]["bandit"], json!("Alira"));
    assert_eq!(both["config"]["values"]["pantheonMinorGod"], json!("Yugul"));

    // Clearing is distinct from setting the default: it means "never touched".
    let cleared = h.call("config.set", json!({ "clear": ["bandit"] }));
    assert!(
        cleared["config"]["values"]["bandit"].is_null(),
        "a cleared option must be absent, not defaulted"
    );

    // Values are validated against the declared list rather than trusted.
    assert_eq!(
        h.call_err("config.set", json!({ "values": { "bandit": "Bob" } }))["code"],
        json!(-32602)
    );
    assert_eq!(
        h.call_err("config.set", json!({ "values": { "nonsenseVar": 1 } }))["code"],
        json!(-32602)
    );
    assert_eq!(
        h.call_err("config.set", json!({ "values": { "bandit": 7 } }))["code"],
        json!(-32602),
        "a number is not one of bandit's options"
    );
    assert_eq!(h.call_err("config.set", json!({}))["code"], json!(-32602));
}

/// Custom modifiers: arbitrary mod text, and — the part PoB does not do — a
/// per-line account of what did and did not take.
///
/// `BuildModList` drops unparseable lines in silence (`ConfigTab.lua:1106-1129`)
/// and the only feedback in PoB is the colour of the text. The report here is
/// ours, so it needs pinning: a typo, a partially-understood mod and a
/// recognised-but-unsupported mod are three different answers.
#[test]
fn custom_modifiers_apply_and_report_bad_lines() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let start = h.call("config.customMods", json!({}));
    assert_eq!(
        start["blocks"].as_array().unwrap().len(),
        1,
        "a build always keeps at least one block"
    );

    // A mod the engine understands must move the numbers.
    let before = stat(&h.call("stats.get", json!({}))["stats"], "Str");
    let applied = h.call(
        "config.setCustomMod",
        json!({ "index": 1, "text": "+100 to Strength" }),
    );
    assert!(
        stat(&applied["stats"], "Str") > before,
        "a parsed custom mod must reach the calculator"
    );
    let block = &applied["customMods"]["blocks"][0];
    assert_eq!(block["lines"].as_array().unwrap().len(), 1);
    assert_eq!(block["lines"][0]["ok"], json!(true));

    // Disabling it puts the numbers back, without losing the text.
    let off = h.call("config.setCustomMod", json!({ "index": 1, "enabled": false }));
    assert_eq!(stat(&off["stats"], "Str"), before);
    assert_eq!(off["customMods"]["blocks"][0]["text"], json!("+100 to Strength"));
    h.call("config.setCustomMod", json!({ "index": 1, "enabled": true }));

    // The per-line report: good lines, blank lines and a typo together.
    let mixed = h.call(
        "config.setCustomMod",
        json!({ "index": 1, "text": "+100 to Strength\n\nnot a real modifier at all\n+10 to Dexterity" }),
    );
    let lines = mixed["customMods"]["blocks"][0]["lines"].as_array().unwrap();
    assert_eq!(
        lines.len(),
        3,
        "blank lines must not be reported as errors — every paragraph break \
         would look broken: {lines:?}"
    );
    assert_eq!(lines[0]["ok"], json!(true));
    assert_eq!(lines[1]["ok"], json!(false));
    assert!(
        lines[1]["reason"].as_str().is_some(),
        "a failed line must say why: {}",
        lines[1]
    );
    assert_eq!(lines[2]["ok"], json!(true));
    // Line numbers must be the user's, counting the blank one.
    assert_eq!(lines[0]["line"], json!(1));
    assert_eq!(lines[1]["line"], json!(3));
    assert_eq!(lines[2]["line"], json!(4));

    // Validation without committing, for feedback while typing.
    let dry = h.call("config.validateMods", json!({ "text": "+5 to all Attributes\ngibberish" }));
    let dry_lines = dry["lines"].as_array().unwrap();
    assert_eq!(dry_lines.len(), 2);
    assert_eq!(dry_lines[0]["ok"], json!(true));
    assert_eq!(dry_lines[1]["ok"], json!(false));
    // It must not have changed anything.
    assert_eq!(
        h.call("config.customMods", json!({}))["blocks"][0]["text"],
        mixed["customMods"]["blocks"][0]["text"]
    );

    // Several named groups, independently toggleable.
    let added = h.call("config.addCustomMod", json!({ "title": "bossing only" }));
    assert_eq!(added["addedBlock"], json!(2));
    assert_eq!(added["customMods"]["blocks"][1]["title"], json!("bossing only"));
    assert_eq!(added["customMods"]["blocks"][1]["enabled"], json!(true));

    let deleted = h.call("config.deleteCustomMod", json!({ "index": 2 }));
    assert_eq!(deleted["customMods"]["blocks"].as_array().unwrap().len(), 1);

    // Deleting the last one re-seeds, rather than leaving nothing to type into.
    let emptied = h.call("config.deleteCustomMod", json!({ "index": 1 }));
    assert_eq!(emptied["customMods"]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(emptied["customMods"]["blocks"][0]["text"], json!(""));

    assert_eq!(
        h.call_err("config.setCustomMod", json!({ "index": 99, "text": "x" }))["code"],
        json!(-32602)
    );
    assert_eq!(h.call_err("config.validateMods", json!({}))["code"], json!(-32602));
}

/// Skill sets, and the main-skill pointer they can silently corrupt.
///
/// Switching sets repoints `socketGroupList` wholesale while
/// `build.mainSocketGroup` is an index into it. PoB does not fix that at switch
/// time — it clamps downward inside the next calculation
/// (`CalcSetup.lua:1483-1489`), destructively. This asserts we clamp at the
/// switch *and* restore the previous selection on the way back.
#[test]
fn skill_sets_switch_without_corrupting_the_main_skill() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let start = h.call("skills.list", json!({}));
    let first = start["activeSet"].as_i64().unwrap();
    let groups = start["groups"].as_array().unwrap().len();
    assert!(groups > 2, "the sample build needs several groups; got {groups}");

    // Point at a high group, then move to a set that has none.
    h.call("build.setMainSkill", json!({ "group": groups }));
    let blank = h.call("skills.newSet", json!({ "title": "bossing" }));
    let second = blank["createdSet"].as_i64().unwrap();

    let switched = h.call("skills.activateSet", json!({ "id": second }));
    assert_eq!(switched["skills"]["activeSet"].as_i64().unwrap(), second);

    // Not empty: a new set carries none of the user's groups, but the
    // recalculation re-adds the ones granted by equipped items, which belong to
    // the gear rather than the loadout.
    let fresh = switched["skills"]["groups"].as_array().unwrap();
    assert!(
        fresh.len() < groups,
        "a new set must not inherit the old set's socket groups: {} vs {groups}",
        fresh.len()
    );
    assert!(
        fresh.iter().all(|g| g["fromItem"] == json!(true)),
        "everything left in a fresh set should be item-granted: {fresh:?}"
    );
    assert!(
        switched["skills"]["mainGroup"].as_i64().unwrap() <= fresh.len().max(1) as i64,
        "the pointer must be clamped into range, not left dangling past the end"
    );

    // Back again: the selection must be the one we left, not PoB's clamp.
    let back = h.call("skills.activateSet", json!({ "id": first }));
    assert_eq!(
        back["skills"]["mainGroup"].as_i64().unwrap(),
        groups as i64,
        "returning to a set should restore the group it was on"
    );
    assert_eq!(back["mainSkill"]["groupIndex"].as_i64().unwrap(), groups as i64);

    // A copy is a deep copy: editing it must not reach the original.
    let copied = h.call("skills.newSet", json!({ "copyFrom": first }));
    let third = copied["createdSet"].as_i64().unwrap();
    h.call("skills.activateSet", json!({ "id": third }));
    let in_copy = h.call("skills.list", json!({}));
    assert_eq!(in_copy["groups"].as_array().unwrap().len(), groups);

    let before_gems = in_copy["groups"][0]["gems"].as_array().unwrap().len();
    assert!(before_gems > 0);
    h.call("skills.deleteGem", json!({ "group": 1, "gem": 1 }));
    h.call("skills.activateSet", json!({ "id": first }));
    assert_eq!(
        h.call("skills.list", json!({}))["groups"][0]["gems"]
            .as_array()
            .unwrap()
            .len(),
        before_gems,
        "deleting a gem in the copy must not touch the original — copyTable is \
         shallow per level, so the gem tables have to be cloned individually"
    );

    let renamed = h.call("skills.renameSet", json!({ "id": third, "title": "copy of mapping" }));
    assert!(renamed["skills"]["sets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["title"] == json!("copy of mapping")));

    // Deleting the active set must leave a live one selected.
    h.call("skills.activateSet", json!({ "id": third }));
    let deleted = h.call("skills.deleteSet", json!({ "id": third }));
    let sets = deleted["skills"]["sets"].as_array().unwrap();
    let active = deleted["skills"]["activeSet"].as_i64().unwrap();
    assert!(sets.iter().any(|s| s["id"].as_i64() == Some(active)));

    assert_eq!(h.call_err("skills.activateSet", json!({ "id": 9999 }))["code"], json!(-32602));
    h.call("skills.deleteSet", json!({ "id": second }));
    assert_eq!(
        h.call_err("skills.deleteSet", json!({ "id": first }))["code"],
        json!(-32602),
        "a build must keep at least one skill set"
    );
}

/// Placeholders, and the two masks that say whether an option is really live.
///
/// This pins the bug the parity audit found. Fourteen options declare a
/// `defaultPlaceholderState` — melee distance 15, projectile distance 40,
/// withered stacks 15 — and PoB *calculates with it* when the option is unset
/// (`ConfigTab.lua:1090-1092`). We were reading `varData.inactiveText`, which
/// has zero occurrences in `ConfigOptions.lua`, so the field was always empty
/// and the client rendered a default of `0` as the value. The user read
/// "Melee distance to enemy: 0" while the engine used 15.
#[test]
fn config_placeholders_and_masks_describe_what_the_engine_uses() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let schema = h.call("config.schema", json!({}));
    let mut by_var = std::collections::HashMap::new();
    for section in schema["sections"].as_array().unwrap() {
        for opt in section["options"].as_array().unwrap() {
            by_var.insert(opt["var"].as_str().unwrap().to_string(), opt.clone());
        }
    }

    // The specific options that were lying.
    for (var, expected) in [("meleeDistance", 15.0), ("projectileDistance", 40.0)] {
        let opt = by_var.get(var).unwrap_or_else(|| panic!("{var} missing"));
        assert_eq!(
            opt["placeholder"].as_f64(),
            Some(expected),
            "{var} must report the value the calculator actually uses: {opt}"
        );
        // And it must NOT be reported as a default, because an unset numeric is
        // nil in PoB, not zero — reporting 0 is what produced the false display.
        assert!(
            opt["default"].is_null(),
            "{var} has no declared default; reporting one invites rendering it as a value: {opt}"
        );
    }

    let with_placeholders = by_var
        .values()
        .filter(|o| !o["placeholder"].is_null())
        .count();
    assert!(
        with_placeholders >= 10,
        "ConfigOptions declares 14 placeholders; only {with_placeholders} came through"
    );

    // No numeric option may claim a default of 0 — that is the shape of the bug.
    for (var, opt) in &by_var {
        let ty = opt["type"].as_str().unwrap_or("");
        if matches!(ty, "count" | "integer" | "countAllowZero" | "float") {
            assert!(
                opt["default"].as_f64() != Some(0.0),
                "{var} reports a default of 0; unset numerics are nil in PoB, not zero"
            );
        }
    }

    let state = h.call("config.state", json!({}));
    assert!(state["placeholders"].is_object(), "state carries live placeholders");
    assert!(state["invalid"].is_object());
    assert!(state["modified"].is_object());

    // `modified` tracks "changed away from the default". An imported character
    // legitimately arrives with some options already set, so test the
    // transition on one we control rather than global emptiness.
    assert!(
        state["modified"]["bandit"].is_null(),
        "bandit is still on its default after import: {}",
        state["modified"]
    );
    h.call("config.set", json!({ "values": { "bandit": "Kraityn" } }));
    let after = h.call("config.state", json!({}));
    assert_eq!(after["modified"]["bandit"], json!(true), "a changed option is flagged");

    // Clearing puts it back to untouched, which is not the same as setting the
    // default value.
    let cleared = h.call("config.set", json!({ "clear": ["bandit"] }));
    assert!(cleared["config"]["modified"]["bandit"].is_null());
}

/// Config sets: several complete sets of option values, switchable.
///
/// The assertion that matters is that switching sets *changes the numbers*.
/// The values live on the set and `tab.input` is repointed at it
/// (`ConfigTab.lua:1293`), so a switch that only moved a label would leave the
/// calculator reading the old table.
#[test]
fn config_sets_hold_separate_values() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let start = h.call("config.state", json!({}));
    assert_eq!(start["sets"].as_array().unwrap().len(), 1, "a build starts with one set");
    let first = start["activeSet"].as_i64().unwrap();

    h.call("config.set", json!({ "values": { "bandit": "Kraityn" } }));
    let with_kraityn = stat(&h.call("stats.get", json!({}))["stats"], "EffectiveMovementSpeedMod");

    // A fresh set starts from the declared defaults, not from the current one.
    let created = h.call("config.newSet", json!({ "title": "bossing" }));
    let second = created["createdSet"].as_i64().unwrap();
    assert_ne!(second, first);
    h.call("config.activateSet", json!({ "id": second }));

    let fresh = h.call("config.state", json!({}));
    assert_eq!(fresh["activeSet"].as_i64().unwrap(), second);
    assert_eq!(
        fresh["values"]["bandit"],
        json!("None"),
        "a new set must not inherit the old set's bandit"
    );
    assert!(
        stat(&h.call("stats.get", json!({}))["stats"], "EffectiveMovementSpeedMod")
            < with_kraityn,
        "switching sets must reach the calculator, not just the label"
    );

    // Switching back restores the first set's values.
    h.call("config.activateSet", json!({ "id": first }));
    assert_eq!(h.call("config.state", json!({}))["values"]["bandit"], json!("Kraityn"));

    // Copying takes the source's values with it.
    let copied = h.call("config.newSet", json!({ "copyFrom": first }));
    let third = copied["createdSet"].as_i64().unwrap();
    h.call("config.activateSet", json!({ "id": third }));
    assert_eq!(h.call("config.state", json!({}))["values"]["bandit"], json!("Kraityn"));

    let renamed = h.call("config.renameSet", json!({ "id": third, "title": "copy of mapping" }));
    let titled = renamed["config"]["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"].as_i64() == Some(third))
        .unwrap();
    assert_eq!(titled["title"], json!("copy of mapping"));

    // Deleting the active set must leave a live one selected, not a dangling id.
    let deleted = h.call("config.deleteSet", json!({ "id": third }));
    let sets = deleted["config"]["sets"].as_array().unwrap();
    assert_eq!(sets.len(), 2);
    let active = deleted["config"]["activeSet"].as_i64().unwrap();
    assert!(
        sets.iter().any(|s| s["id"].as_i64() == Some(active)),
        "the active set must still exist after deleting it"
    );

    assert_eq!(h.call_err("config.activateSet", json!({ "id": 9999 }))["code"], json!(-32602));
    assert_eq!(
        h.call_err("config.renameSet", json!({ "id": first, "title": "  " }))["code"],
        json!(-32602)
    );
    // The last set cannot go.
    h.call("config.deleteSet", json!({ "id": second }));
    assert_eq!(
        h.call_err("config.deleteSet", json!({ "id": first }))["code"],
        json!(-32602),
        "a build must keep at least one config set"
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

/// Speculative comparisons: "what would this change do?", without doing it.
///
/// The load-bearing assertion is not that a delta comes back but that the
/// build is *unchanged afterwards*. `calcs.initEnv` has no gem-shaped or
/// config-shaped override key, so unlike the tree comparison these cannot ask
/// the calculator a hypothetical — they edit the live build, calculate, and
/// edit it back (`GemSelectControl.lua:59-103`). A restore that misses leaves a
/// gem the user never chose in their build, and the next save writes it out.
#[test]
fn comparisons_predict_a_change_without_making_it() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    // Fingerprint of the whole build, so a restore that misses any field fails.
    let fingerprint = |h: &mut Host| -> (Value, Value) {
        (h.call("stats.get", json!({}))["stats"].clone(), h.call("skills.list", json!({})))
    };

    // Take the fingerprint *after* one calculation, not straight off the load.
    // `initEnv` regenerates item-granted socket groups and fills in derived
    // fields on them — `matchesSocket` is nil until the first pass — so a
    // freshly loaded build and a settled one differ for reasons that have
    // nothing to do with whether a comparison put things back.
    h.call(
        "stats.compare",
        json!({ "change": { "kind": "config", "var": "bandit", "value": "Alira" } }),
    );
    let (baseline, skills_before) = fingerprint(&mut h);

    // --- config: the prediction must equal the real thing ---------------
    //
    // Kraityn grants `MovementSpeed INC 8`, which this character can show.
    let predicted = h.call(
        "stats.compare",
        json!({ "change": { "kind": "config", "var": "bandit", "value": "Kraityn" } }),
    );
    let moved = predicted["stats"]
        .as_array()
        .expect("stats is an array")
        .iter()
        .find(|r| r["key"] == json!("EffectiveMovementSpeedMod"))
        .expect("helping Kraityn must move movement speed");
    let predicted_delta = moved["delta"].as_f64().unwrap();
    assert!(predicted_delta > 0.0, "8% increased movement speed is an increase");
    assert_eq!(moved["better"], json!(true), "more movement speed is better");

    // Nothing may have happened yet.
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline, "a comparison must not change the build");
    assert_eq!(skills_now, skills_before);

    // Now actually do it, and the panel must move by exactly what was promised.
    let applied = h.call("config.set", json!({ "values": { "bandit": "Kraityn" } }));
    let real_delta = stat(&applied["stats"], "EffectiveMovementSpeedMod")
        - stat(&baseline, "EffectiveMovementSpeedMod");
    assert!(
        (real_delta - predicted_delta).abs() < 1e-6,
        "predicted {predicted_delta} but applying it moved the stat by {real_delta}"
    );
    h.call("config.set", json!({ "clear": ["bandit"] }));

    // --- gem enable: the flip, and the flip back ------------------------
    let group = skills_before["mainGroup"].as_i64().unwrap();
    let gems = skills_before["groups"][(group - 1) as usize]["gems"].as_array().unwrap();
    let gem = 1 + gems
        .iter()
        .position(|g| g["enabled"] == json!(true))
        .expect("the main group has an enabled gem") as i64;

    let off = h.call(
        "stats.compare",
        json!({ "change": { "kind": "gemEnabled", "group": group, "gem": gem } }),
    );
    assert!(
        !off["stats"].as_array().unwrap().is_empty(),
        "disabling a gem in the main group must change something"
    );
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline, "toggling a gem for a peek must be undone");
    assert_eq!(skills_now, skills_before);

    // --- gem quality ----------------------------------------------------
    h.call(
        "stats.compare",
        json!({ "change": { "kind": "gemQuality", "group": group, "gem": gem, "value": 20 } }),
    );
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline);
    assert_eq!(skills_now, skills_before, "quality must be restored exactly");

    // --- swapping in a gem the build does not have ----------------------
    let catalogue = h.call("skills.gemCatalogue", json!({}));
    let support = catalogue["gems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == json!("Added Cold Damage"))
        .expect("Added Cold Damage is in the catalogue")["id"]
        .clone();

    let swapped = h.call(
        "stats.compare",
        json!({ "change": { "kind": "gem", "group": group, "gem": gem, "gemId": support } }),
    );
    assert!(swapped["stats"].is_array());
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline, "a swapped-in gem must be swapped back out");
    assert_eq!(
        skills_now, skills_before,
        "the gem list must be byte-identical after a speculative swap"
    );

    // Appending into the empty slot past the end is how the picker asks
    // "what would adding this be worth?" — and it must leave no gem behind.
    let slot = gems.len() as i64 + 1;
    h.call(
        "stats.compare",
        json!({ "change": { "kind": "gem", "group": group, "gem": slot, "gemId": support } }),
    );
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline);
    assert_eq!(
        skills_now, skills_before,
        "a comparison against the empty slot must not add a gem to the build"
    );

    // --- bad input is rejected, and rejects cleanly ---------------------
    for bad in [
        json!({ "kind": "gem", "group": 9999, "gem": 1, "gemId": support }),
        json!({ "kind": "gem", "group": group, "gem": 1, "gemId": "Metadata/NoSuchGem" }),
        json!({ "kind": "gemEnabled", "group": group, "gem": 9999 }),
        json!({ "kind": "config", "var": "notAnOption", "value": true }),
        json!({ "kind": "nonsense" }),
    ] {
        assert_eq!(
            h.call_err("stats.compare", json!({ "change": bad.clone() }))["code"],
            json!(-32602),
            "expected a clean rejection for {bad}"
        );
    }
    let (stats_now, skills_now) = fingerprint(&mut h);
    assert_eq!(stats_now, baseline, "a rejected comparison must not touch the build");
    assert_eq!(skills_now, skills_before);
}

/// Gear: the item pool, the slots, and what may legally go where.
///
/// The last part is the reason this talks to PoB rather than reimplementing:
/// `IsItemValidForSlot` (`ItemsTab.lua:2457-2505`) knows a quiver needs a bow
/// in the other hand and that two wands pair but a wand and a sceptre do not.
/// Those rules are not derivable from the item's type alone, so the engine is
/// asked rather than second-guessed.
#[test]
fn items_expose_the_pool_the_slots_and_what_fits_where() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let state = h.call("items.list", json!({}));
    let items = state["items"].as_array().expect("items is an array");
    let slots = state["slots"].as_array().expect("slots is an array");
    assert!(items.len() >= 10, "the sample character is fully geared; got {}", items.len());
    assert!(slots.len() >= 11, "expected the base slot list; got {}", slots.len());
    assert!(state["sets"].as_array().is_some_and(|s| !s.is_empty()));

    let by_id: std::collections::HashMap<i64, &Value> =
        items.iter().map(|i| (i["id"].as_i64().unwrap(), i)).collect();

    let equipped = |name: &str| -> Option<&Value> {
        slots
            .iter()
            .find(|s| s["name"] == json!(name))
            .and_then(|s| s["itemId"].as_i64())
            .and_then(|id| by_id.get(&id).copied())
    };

    // Body armour: a real six-link, read off the socket groups rather than
    // counted — links are what decide whether a socket group fits.
    let body = equipped("Body Armour").expect("the sample has a body armour");
    let sockets = body["sockets"].as_array().expect("body armour has sockets");
    assert_eq!(sockets.len(), 6);
    let group = sockets[0]["group"].as_i64().unwrap();
    assert!(
        sockets.iter().all(|s| s["group"].as_i64() == Some(group)),
        "all six sockets are in one link group: {sockets:?}"
    );
    assert!(
        body["defences"]["energyShield"].as_f64().is_some_and(|v| v > 0.0),
        "an ES body armour must report its energy shield"
    );

    // Influence is a flag set, not a single value — an item can carry two.
    let helmet = equipped("Helmet").expect("the sample has a helmet");
    let influences = helmet["influences"].as_array().expect("Indigon is influenced");
    assert!(influences.contains(&json!("Shaper")));

    // Mod lines keep PoB's six-way split; the order matters on save.
    assert!(
        items.iter().any(|i| i["mods"]["explicit"].as_array().is_some_and(|m| !m.is_empty())),
        "no item reported an explicit modifier"
    );

    // Slot legality, delegated. A ring fits three slots and nothing else.
    let ring = equipped("Ring 1").expect("the sample has a ring");
    let legal = h.call("items.slotsFor", json!({ "item": ring["id"] }));
    let legal: Vec<&str> =
        legal["slots"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
    assert_eq!(legal, vec!["Ring 1", "Ring 2", "Ring 3"]);

    // A one-handed weapon is legal in both hands and both swap sets; a body
    // armour is legal in exactly one place.
    let weapon = equipped("Weapon 1").expect("the sample has a weapon");
    let legal = h.call("items.slotsFor", json!({ "item": weapon["id"] }));
    let legal = legal["slots"].as_array().unwrap();
    assert!(legal.contains(&json!("Weapon 1")) && legal.contains(&json!("Weapon 1 Swap")));

    let legal = h.call("items.slotsFor", json!({ "item": body["id"] }));
    assert_eq!(legal["slots"], json!(["Body Armour"]));

    assert_eq!(
        h.call_err("items.slotsFor", json!({ "item": 99999 }))["code"],
        json!(-32602),
        "an unknown item id is a bad request, not a crash"
    );
}

/// Pasting, equipping and item sets — the mutations, end to end.
///
/// Goldrim is a good probe because it is unambiguous: one legal slot, and it
/// replaces an energy-shield helmet with an evasion one, so a correct equip has
/// to be visible in the stat panel rather than just in the item list.
#[test]
fn items_can_be_pasted_equipped_and_organised_into_sets() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let before = stat(&h.call("stats.get", json!({}))["stats"], "EnergyShield");
    let start = h.call("items.list", json!({}));
    let count = start["items"].as_array().unwrap().len();

    // Item text exactly as the game puts it on the clipboard. `Item:ParseRaw`
    // is the only thing that reads this; we never parse an item ourselves.
    let raw = "Rarity: UNIQUE\nGoldrim\nLeather Cap\nItem Level: 20\nQuality: 20\n\
               Evasion: 32\nLevelReq: 1\nImplicits: 0\n+35 to Evasion Rating\n\
               10% increased Rarity of Items found\n+35% to all Elemental Resistances\n";
    let pasted = h.call("items.paste", json!({ "text": raw }));
    let items = pasted["items"]["items"].as_array().unwrap();
    assert_eq!(items.len(), count + 1, "the pasted item should join the pool");

    let goldrim = items
        .iter()
        .find(|i| i["title"] == json!("Goldrim"))
        .expect("Goldrim parsed out of the raw text");
    let id = goldrim["id"].as_i64().unwrap();
    assert_eq!(goldrim["rarity"], json!("UNIQUE"));
    assert_eq!(goldrim["baseName"], json!("Leather Cap"));

    // A helmet fits one slot, and the engine is what says so.
    assert_eq!(
        h.call("items.slotsFor", json!({ "item": id }))["slots"],
        json!(["Helmet"])
    );

    // Equipping it over an energy-shield helmet must move the numbers.
    let equipped = h.call("items.equip", json!({ "item": id, "slot": "Helmet" }));
    let after = stat(&equipped["stats"], "EnergyShield");
    assert!(
        after < before,
        "swapping an ES helmet for an evasion one must lower ES: {before} -> {after}"
    );

    // Illegal placement is a clean rejection naming the item, not a crash.
    let err = h.call_err("items.equip", json!({ "item": id, "slot": "Boots" }));
    assert_eq!(err["code"], json!(-32602));
    assert!(
        err["message"].as_str().unwrap_or_default().contains("Goldrim"),
        "the refusal should name the item: {err}"
    );

    // Clearing a slot puts the stat back.
    let cleared = h.call("items.equip", json!({ "slot": "Helmet", "item": false }));
    assert!(stat(&cleared["stats"], "EnergyShield") < before, "the helmet is off entirely now");

    // Sets: a copy takes the slot assignments and shares the items.
    let made = h.call("items.newSet", json!({ "title": "bossing", "copyFrom": start["activeSet"] }));
    let set = made["createdSet"].as_i64().unwrap();
    assert!(made["items"]["sets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["title"] == json!("bossing")));

    assert_eq!(
        h.call("items.activateSet", json!({ "id": set }))["items"]["activeSet"].as_i64(),
        Some(set)
    );
    let renamed = h.call("items.renameSet", json!({ "id": set, "title": "uber" }));
    assert!(renamed["items"]["sets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["title"] == json!("uber")));

    // Deleting the active set must leave a live one selected.
    let deleted = h.call("items.deleteSet", json!({ "id": set }));
    let active = deleted["items"]["activeSet"].as_i64().unwrap();
    assert!(deleted["items"]["sets"].as_array().unwrap().iter().any(|s| s["id"].as_i64() == Some(active)));

    assert_eq!(
        h.call_err("items.deleteSet", json!({ "id": active }))["code"],
        json!(-32602),
        "a build must keep at least one item set"
    );

    // Bad input, rejected rather than absorbed.
    assert_eq!(h.call_err("items.paste", json!({ "text": "not an item" }))["code"], json!(-32602));
    assert_eq!(h.call_err("items.equip", json!({ "item": id, "slot": "Nowhere" }))["code"], json!(-32602));
    assert_eq!(h.call_err("items.delete", json!({ "item": 99999 }))["code"], json!(-32602));

    // And a delete really removes it from the pool.
    let gone = h.call("items.delete", json!({ "item": id }));
    assert!(
        !gone["items"]["items"].as_array().unwrap().iter().any(|i| i["id"].as_i64() == Some(id)),
        "the deleted item is still in the pool"
    );
}

/// Item comparisons, which use the *clean* override channel.
///
/// Unlike gems and config, `calcs.initEnv` understands an item-shaped override
/// (`repSlotName` + `repItem`, `CalcSetup.lua:713-717`), so nothing is mutated
/// and there is no restore to get wrong. The build cannot be corrupted here.
///
/// The subtle part is flasks: they are *toggled*, not replaced
/// (`ItemDBControl.lua:247`). That is asserted by its signature — replacing an
/// equipped item with itself is a no-op and reports nothing, but toggling an
/// equipped flask turns it off and must report plenty.
#[test]
fn item_comparisons_use_the_override_channel_and_toggle_flasks() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let state = h.call("items.list", json!({}));
    let slots = state["slots"].as_array().unwrap();
    let equipped = |name: &str| -> Option<i64> {
        slots.iter().find(|s| s["name"] == json!(name))?["itemId"].as_i64()
    };
    let compare = |h: &mut Host, change: Value| -> usize {
        h.call("stats.compare", json!({ "change": change }))["stats"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0)
    };

    // Emptying a real slot moves a lot of numbers.
    let bare = compare(&mut h, json!({ "kind": "item", "slot": "Helmet" }));
    assert!(bare > 0, "taking the helmet off must change something");

    // Replacing an item with itself is a no-op — which is exactly what proves
    // the ordinary `repItem` path is being taken rather than something that
    // merely looks like it worked.
    let body = equipped("Body Armour").expect("the sample has a body armour");
    assert_eq!(
        compare(&mut h, json!({ "kind": "item", "slot": "Body Armour", "item": body })),
        0,
        "swapping an item for itself cannot change the build"
    );

    // A flask in its own slot is *not* a no-op, because flasks toggle. If this
    // reports nothing, `repItem` is being used for a flask and the comparison
    // is silently measuring nothing.
    let flask_slots = ["Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
    let mut toggled = 0;
    for name in flask_slots {
        if let Some(id) = equipped(name) {
            toggled += compare(&mut h, json!({ "kind": "item", "slot": name, "item": id }));
        }
    }
    assert!(
        toggled > 0,
        "no flask toggle changed anything — the toggleFlask path is not being taken"
    );

    // The build must be untouched throughout: this channel never mutates, so
    // this is a regression guard on that promise rather than on a restore.
    let after = h.call("items.list", json!({}));
    assert_eq!(after, state, "an item comparison must not change the build");

    for bad in [
        json!({ "kind": "item", "slot": "Nowhere", "item": body }),
        json!({ "kind": "item", "slot": "Helmet", "item": 99999 }),
        json!({ "kind": "item" }),
    ] {
        assert_eq!(
            h.call_err("stats.compare", json!({ "change": bad.clone() }))["code"],
            json!(-32602),
            "expected a clean rejection for {bad}"
        );
    }
}

/// Jewel sockets, which are slots that belong to the *tree* rather than to the
/// item set.
///
/// `ItemSlotControl.lua:61-73` stores a socketed jewel on `spec.jewels[nodeId]`,
/// not on the item set — which is why swapping tree variants swaps your jewels
/// with them. The item set does hold a `[nodeId]` entry, but it is a trade-search
/// URL, and reading that reported every socket as empty.
///
/// The second half is the destructive path the items tab can reach: a cluster
/// jewel creates passives, so removing one *unallocates* them. That is a tree
/// edit made from the gear screen, and it is asserted here rather than trusted.
#[test]
fn jewel_sockets_belong_to_the_tree_and_cluster_jewels_carry_passives() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let state = h.call("items.list", json!({}));
    let slots = state["slots"].as_array().unwrap();
    let by_id: std::collections::HashMap<i64, &Value> = state["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["id"].as_i64().unwrap(), i))
        .collect();

    let sockets: Vec<&Value> = slots.iter().filter(|s| s["nodeId"].is_number()).collect();
    assert!(
        sockets.len() > 20,
        "a real tree has dozens of jewel sockets; got {}",
        sockets.len()
    );

    let filled: Vec<&&Value> = sockets.iter().filter(|s| s["itemId"].is_number()).collect();
    assert!(
        !filled.is_empty(),
        "the sample character wears jewels — reporting none means the socket \
         assignment is being read from the item set instead of the tree spec"
    );

    // Every socketed jewel must actually be a jewel.
    for slot in &filled {
        let item = by_id[&slot["itemId"].as_i64().unwrap()];
        assert_eq!(item["type"], json!("Jewel"), "{item} is not a jewel");
    }

    let before = h.call("build.summary", json!({}))["pointsUsed"].as_i64().unwrap();

    // A cluster jewel grants passives, so taking it out spends fewer points.
    let cluster = filled
        .iter()
        .find(|s| {
            by_id[&s["itemId"].as_i64().unwrap()]["baseName"]
                .as_str()
                .is_some_and(|b| b.contains("Cluster Jewel"))
        })
        .expect("the sample character has a cluster jewel socketed");
    let slot_name = cluster["name"].as_str().unwrap().to_string();
    let jewel_id = cluster["itemId"].as_i64().unwrap();

    let removed = h.call("items.equip", json!({ "slot": slot_name, "item": false }));
    let after = removed["summary"]["pointsUsed"].as_i64().unwrap();
    assert!(
        after < before,
        "removing a cluster jewel must unallocate the passives it granted: \
         {before} -> {after}"
    );
    assert!(
        removed["items"]["slots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == json!(slot_name))
            .is_some_and(|s| s["itemId"].is_null()),
        "the socket should read as empty now"
    );

    // And putting it back restores them, so this is reversible rather than lossy.
    let restored = h.call("items.equip", json!({ "slot": slot_name, "item": jewel_id }));
    assert_eq!(
        restored["summary"]["pointsUsed"].as_i64().unwrap(),
        before,
        "re-socketing the cluster jewel must restore its passives"
    );
}

/// Abyssal sockets, which exist only while the item granting them is worn.
///
/// `ItemSlotControl.lua:98-110` activates them from the equipped item's
/// `abyssalSocketCount`, so the slot list is not fixed — it grows and shrinks
/// with your gear. A client that ignores `shown` renders six dead rows on every
/// belt in the game.
#[test]
fn abyssal_sockets_appear_with_the_item_that_grants_them() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let belt_sockets = |state: &Value| -> Vec<bool> {
        state["slots"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["name"].as_str().is_some_and(|n| n.starts_with("Belt Abyssal")))
            .map(|s| s["shown"] == json!(true))
            .collect()
    };

    let before = belt_sockets(&h.call("items.list", json!({})));
    assert!(!before.is_empty(), "the belt has abyssal socket slots defined");
    assert!(
        before.iter().all(|shown| !shown),
        "no abyssal socket should be offered while no abyssal-socketed item is worn"
    );

    // A Stygian Vise is the belt base that carries exactly one.
    let raw = "Rarity: RARE\nWoe Locket\nStygian Vise\nItem Level: 84\nImplicits: 0\n\
               Has 1 Abyssal Socket\n+80 to maximum Life\n";
    let pasted = h.call("items.paste", json!({ "text": raw }));
    let belt = pasted["items"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["title"] == json!("Woe Locket"))
        .expect("the Stygian Vise parsed");
    assert_eq!(belt["type"], json!("Belt"));

    let equipped = h.call("items.equip", json!({ "slot": "Belt", "item": belt["id"] }));
    let after = belt_sockets(&equipped["items"]);
    assert_eq!(
        after.iter().filter(|s| **s).count(),
        1,
        "one abyssal socket, because the item has one — not zero and not all six"
    );
    assert!(after[0], "it should be the first socket that opens up");
}

/// Optimise Sockets: recolour and relink an item to fit the groups in its slot.
///
/// Mirrors `SkillsTab.lua:242-283`. The assertion has to start from a *wrong*
/// item, because the sample character's gear is already correctly coloured and
/// "nothing changed" would pass whether the code works or not.
#[test]
fn optimise_sockets_recolours_an_item_to_fit_its_gems() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let colours = |h: &mut Host, slot_name: &str| -> String {
        let state = h.call("items.list", json!({}));
        let id = state["slots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == json!(slot_name))
            .and_then(|s| s["itemId"].as_i64())
            .expect("something is equipped there");
        let item = state["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"].as_i64() == Some(id))
            .unwrap();
        item["sockets"]
            .as_array()
            .map(|ss| {
                ss.iter()
                    .map(|s| s["colour"].as_str().unwrap_or("?"))
                    .collect::<String>()
            })
            .unwrap_or_default()
    };

    // What the body-armour group actually needs.
    let skills = h.call("skills.list", json!({}));
    let group = skills["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["slot"] == json!("Body Armour"))
        .expect("the sample has a body-armour group");
    let gem_count = group["gems"].as_array().unwrap().len();
    assert!(gem_count >= 4, "need a real link setup to optimise against");

    // A six-socket chest coloured entirely wrong.
    let raw = "Rarity: RARE\nWrong Colours\nAstral Plate\nItem Level: 84\nQuality: 20\n\
               Sockets: R-R-R-R-R-R\nArmour: 700\nImplicits: 0\n+50 to maximum Life\n";
    let pasted = h.call("items.paste", json!({ "text": raw }));
    let chest = pasted["items"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["title"] == json!("Wrong Colours"))
        .expect("the chest parsed");
    h.call("items.equip", json!({ "slot": "Body Armour", "item": chest["id"] }));

    let before = colours(&mut h, "Body Armour");
    assert_eq!(before, "RRRRRR", "the pasted chest should be all red to start with");

    let after_call = h.call("items.optimiseSockets", json!({ "slot": "Body Armour" }));
    assert!(after_call["skills"].is_object(), "the socket groups are re-read too");
    let after = colours(&mut h, "Body Armour");

    assert_ne!(after, before, "optimising must actually recolour the sockets");
    assert_eq!(
        after.len(),
        gem_count.min(6),
        "one socket per gem, up to the base's limit"
    );
    assert!(
        after.contains('B'),
        "the group's intelligence gems need blue sockets: got {after}"
    );

    assert_eq!(
        h.call_err("items.optimiseSockets", json!({ "slot": "Amulet" }))["code"],
        json!(-32602),
        "an amulet has no sockets to optimise"
    );
}

/// Imbued supports, which apply to an item slot without occupying a socket.
///
/// The trap is that **two fields must agree** — `imbuedSupportBySlot[slot]` and
/// `group.imbuedSupport` — or `CalcSetup.lua:1558` skips it entirely. Setting
/// one alone is a silent no-op, so this asserts the numbers move rather than
/// just that the field came back.
#[test]
fn an_imbued_support_reaches_the_calculator_and_is_filtered_to_eligible_gems() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    // The eligible set is much smaller than "every support".
    let all = h.call("skills.gemCatalogue", json!({}));
    let imbued = h.call("skills.gemCatalogue", json!({ "imbued": true }));
    let all_n = all["gems"].as_array().unwrap().len();
    let imbued_gems = imbued["gems"].as_array().unwrap();
    assert!(
        imbued_gems.len() < all_n / 2,
        "imbued gems are a narrow subset; got {} of {all_n}",
        imbued_gems.len()
    );
    assert!(
        imbued_gems.iter().all(|g| g["support"] == json!(true)),
        "only supports can be imbued"
    );
    assert!(
        imbued_gems.iter().all(|g| g["exceptional"] == json!(false)),
        "exceptional and awakened supports cannot be imbued"
    );

    let group = h.call("skills.list", json!({}))["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["slot"].is_string())
        .expect("a group assigned to a slot")
        .clone();
    let index = group["index"].as_i64().unwrap();

    let gem = imbued_gems
        .iter()
        .find(|g| g["name"] == json!("Added Cold Damage"))
        .expect("Added Cold Damage is imbue-eligible");

    let before = stat(&h.call("stats.get", json!({}))["stats"], "TotalDPS");
    let set = h.call(
        "skills.setImbuedSupport",
        json!({ "group": index, "gemId": gem["id"] }),
    );
    let after = stat(&set["stats"], "TotalDPS");

    assert_eq!(
        set["skills"]["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["index"].as_i64() == Some(index))
            .unwrap()["imbuedSupport"],
        json!("Added Cold Damage")
    );
    assert_ne!(
        after, before,
        "an imbued support must reach the calculator — equal numbers mean only \
         one of the two required fields was set"
    );

    // Clearing puts it back.
    let cleared = h.call("skills.setImbuedSupport", json!({ "group": index, "gemId": false }));
    assert_eq!(stat(&cleared["stats"], "TotalDPS"), before);

    // Only supports, and only real gems.
    let active = all["gems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["support"] == json!(false))
        .expect("some active gem exists");
    assert_eq!(
        h.call_err("skills.setImbuedSupport", json!({ "group": index, "gemId": active["id"] }))["code"],
        json!(-32602),
        "an active skill is not a support"
    );
}

/// Crafting, and the mod browser, which are one thing.
///
/// PoB's nine crafting features all reduce to: take a mod table, filter it with
/// a PoB predicate, pick one, append its lines to `explicitModLines`, reparse.
/// The tables and the predicates are PoB's — `GetModSpawnWeight` in particular,
/// which is what makes a mod legal on one item and not another.
#[test]
fn mod_pools_are_filtered_by_the_item_and_applying_one_moves_the_numbers() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let state = h.call("items.list", json!({}));
    let equipped = |name: &str| -> i64 {
        state["slots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == json!(name))
            .and_then(|s| s["itemId"].as_i64())
            .unwrap_or_else(|| panic!("nothing equipped in {name}"))
    };
    let body = equipped("Body Armour");

    // Sources are per item: a body armour gets the bench and necropolis, a
    // flask gets neither.
    let sources: Vec<String> = h.call("items.modSources", json!({ "item": body }))["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    assert!(sources.contains(&"MASTER".to_string()));
    assert!(sources.contains(&"NECROPOLIS".to_string()));
    assert!(sources.contains(&"CUSTOM".to_string()), "custom text is always available");

    let flask = equipped("Flask 1");
    let flask_sources: Vec<String> = h.call("items.modSources", json!({ "item": flask }))["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        !flask_sources.contains(&"NECROPOLIS".to_string())
            && !flask_sources.contains(&"ESSENCE".to_string()),
        "a flask takes neither necropolis mods nor essences: {flask_sources:?}"
    );

    // Every source produces a real, filtered pool.
    for source in ["MASTER", "PREFIX", "SUFFIX", "VEILED", "DELVE"] {
        let pool = h.call("items.modPool", json!({ "item": body, "source": source }));
        let mods = pool["mods"].as_array().unwrap();
        assert!(!mods.is_empty(), "{source} produced no candidates");

        // `supported` must be meaningful, not uniformly false. It reads
        // `(11-28)% increased Energy Shield` — a range `parseMod` cannot take —
        // so the range has to be resolved before asking, or nearly every mod in
        // the game reports as unsupported.
        let unsupported = mods.iter().filter(|m| m["supported"] == json!(false)).count();
        assert!(
            unsupported * 4 < mods.len(),
            "{source}: {unsupported} of {} unsupported — the range is probably not \
             being resolved before parsing",
            mods.len()
        );
    }

    // Search narrows without changing the shape.
    let found = h.call(
        "items.modPool",
        json!({ "item": body, "source": "MASTER", "search": "maximum energy shield" }),
    );
    let candidates = found["mods"].as_array().unwrap();
    assert!(!candidates.is_empty());
    assert!(
        candidates
            .iter()
            .all(|m| m["label"].as_str().unwrap().to_lowercase().contains("energy shield")),
        "search must actually filter"
    );

    // Apply one, and the stat panel has to move.
    let before = stat(&h.call("stats.get", json!({}))["stats"], "EnergyShield");
    let pick = candidates
        .iter()
        .find(|m| m["supported"] == json!(true))
        .expect("at least one supported ES craft");
    let added = h.call(
        "items.addMod",
        json!({ "item": body, "source": "MASTER", "index": pick["index"] }),
    );
    let after = stat(&added["stats"], "EnergyShield");
    assert!(after > before, "a crafted ES mod must raise ES: {before} -> {after}");

    // It lands as an explicit line carrying the crafted flag — there is no
    // separate crafting model in PoB.
    let item = added["items"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"].as_i64() == Some(body))
        .unwrap();
    let crafted: Vec<&Value> = item["mods"]["explicit"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["crafted"] == json!(true))
        .collect();
    assert!(!crafted.is_empty(), "the added mod should be flagged crafted");

    // And removing it puts the number back exactly.
    let index = crafted
        .iter()
        .find(|m| m["line"].as_str().unwrap().contains("Energy Shield"))
        .unwrap()["index"]
        .clone();
    let removed = h.call(
        "items.removeMod",
        json!({ "item": body, "list": "explicit", "index": index }),
    );
    assert_eq!(stat(&removed["stats"], "EnergyShield"), before);

    // Free text goes through the same door.
    let custom = h.call(
        "items.addMod",
        json!({ "item": body, "source": "CUSTOM", "text": "+100 to maximum Energy Shield" }),
    );
    assert!(stat(&custom["stats"], "EnergyShield") > before);

    for bad in [
        json!({ "item": body, "source": "NONSENSE" }),
        json!({ "item": 99999, "source": "MASTER" }),
    ] {
        assert_eq!(h.call_err("items.modPool", bad.clone())["code"], json!(-32602), "{bad}");
    }
    assert_eq!(
        h.call_err("items.addMod", json!({ "item": body, "source": "CUSTOM", "text": "  " }))["code"],
        json!(-32602),
        "empty custom text is not a modifier"
    );
}

/// The implicit family — corrupted, Searing Exarch, Eater of Worlds.
///
/// Same filter as the explicit sources (`mod.type` against the source id, then
/// `GetModSpawnWeight`), which is why they cost almost nothing on top. What
/// differs is where they land: `implicitModLines` rather than the explicits,
/// and corrupting additionally flags the item.
#[test]
fn implicit_sources_land_on_the_implicit_list_and_corrupting_flags_the_item() {
    let mut h = host();
    h.call("build.load", json!({ "character": character_payload() }));

    let state = h.call("items.list", json!({}));
    let body = state["slots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == json!("Body Armour"))
        .and_then(|s| s["itemId"].as_i64())
        .expect("the sample has a body armour");

    let sources: Vec<String> = h.call("items.modSources", json!({ "item": body }))["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    for wanted in ["CORRUPTED", "EXARCH", "EATER"] {
        assert!(sources.contains(&wanted.to_string()), "missing {wanted}: {sources:?}");
    }

    let counts = |h: &mut Host| -> (usize, usize) {
        let item = h.call("items.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"].as_i64() == Some(body))
            .unwrap()
            .clone();
        (
            item["mods"]["implicit"].as_array().map(|a| a.len()).unwrap_or(0),
            item["mods"]["explicit"].as_array().map(|a| a.len()).unwrap_or(0),
        )
    };
    let (implicits_before, explicits_before) = counts(&mut h);

    // An eldritch implicit lands on the implicit list, and nowhere else.
    let pool = h.call("items.modPool", json!({ "item": body, "source": "EXARCH" }));
    let pick = pool["mods"].as_array().unwrap().first().expect("exarch mods exist").clone();
    h.call("items.addMod", json!({ "item": body, "source": "EXARCH", "index": pick["index"] }));

    let (implicits_after, explicits_after) = counts(&mut h);
    assert_eq!(implicits_after, implicits_before + 1, "it belongs on the implicit list");
    assert_eq!(explicits_after, explicits_before, "and must not touch the explicits");

    // Corrupting sets the flag on the item.
    let corrupt_pool = h.call("items.modPool", json!({ "item": body, "source": "CORRUPTED" }));
    let corrupt_pick = corrupt_pool["mods"]
        .as_array()
        .unwrap()
        .first()
        .expect("corrupted implicits exist")
        .clone();
    let corrupted = h.call(
        "items.addMod",
        json!({ "item": body, "source": "CORRUPTED", "index": corrupt_pick["index"] }),
    );

    let item = corrupted["items"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"].as_i64() == Some(body))
        .unwrap();
    assert_eq!(item["corrupted"], json!(true), "a corrupted implicit corrupts the item");

    // And crafting stays available, deliberately. In the game a corrupted item
    // cannot be crafted; PoB does not enforce that, because it is a planner and
    // you may be modelling an item you already own. `modifiableItem`
    // (`ItemsTab.lua:1840`) is the only place corruption gates anything, and it
    // guards anoint-copying rather than the mod sources. Matching PoB here is
    // the point — inventing the restriction would make real items unmodellable.
    let after: Vec<String> = h.call("items.modSources", json!({ "item": body }))["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        after.contains(&"MASTER".to_string()),
        "PoB keeps the bench available on a corrupted item: {after:?}"
    );
}
