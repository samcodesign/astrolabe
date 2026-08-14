//! Hosts Path of Building's calculation engine inside an embedded LuaJIT.
//!
//! PoB expects to run with `src/` as the working directory and to find its
//! bundled pure-Lua libraries on `package.path`; `bootstrap.lua` arranges both,
//! then boots `HeadlessWrapper.lua`.
//!
//! Two checks are available:
//!
//! * `specs` (default) — runs PoB's own regression suite inside our host. This
//!   is the gate: CI keeps these green on every PR, so passing here means we
//!   drive the engine exactly as PoB does.
//! * `golden` — runs the committed build snapshots. Informational only: they
//!   were last regenerated in 2022 against game version 3.13 and PoB excludes
//!   them from CI (`.busted` sets `exclude-tags = "builds"`), so they drift.
//!
//! `serve` turns the same process into a long-lived JSON-RPC host; see `rpc.rs`.

mod rpc;

use mlua::{Lua, Table, Value};
use std::{env, error::Error, fs, path::{Path, PathBuf}, process, time::Instant};

const BOOTSTRAP: &str = include_str!("../lua/bootstrap.lua");
const GOLDEN: &str = include_str!("../lua/golden.lua");
const SPEC_RUNNER: &str = include_str!("../lua/spec_runner.lua");
const BENCH: &str = include_str!("../lua/bench.lua");

/// PoB tags these `#builds` and excludes them from CI; the snapshots are stale.
const EXCLUDED_SPECS: &[&str] = &["TestBuilds_spec.lua"];

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mode = env::args().nth(1).unwrap_or_else(|| "specs".into());
    let pob = resolve_pob_path(env::args().nth(2))?;
    // In serve mode stdout carries the protocol and nothing else; everything the
    // host would otherwise print goes to stderr.
    let serving = mode == "serve";
    let say = |line: String| {
        if serving {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    };
    say(format!("Path of Building: {}", pob.display()));

    let src = pob.join("src");
    if !src.join("HeadlessWrapper.lua").is_file() {
        return Err(format!("{} has no src/HeadlessWrapper.lua", pob.display()).into());
    }

    let host_lua = host_lua_dir()?;

    // HeadlessWrapper does a relative `dofile("Launch.lua")`, so the working
    // directory has to be src/ before we boot it.
    env::set_current_dir(&src)?;

    // `Lua::new()` omits the `debug` library, which PoB needs in exactly one
    // place: `debug.traceback` as an xpcall handler (ItemsTab.lua:4329). That
    // is the only debug.* call site in the entire codebase. Loading the full
    // standard library is safe here — we are hosting a local, trusted engine,
    // not sandboxing untrusted script.
    let lua = unsafe { Lua::unsafe_new() };
    lua.globals()
        .set("HOST_LUA", host_lua.to_string_lossy().replace('\\', "/"))?;
    if serving {
        rpc::quiet_stdout(&lua)?;
    }

    let started = Instant::now();
    // Forward slashes: this goes into Lua path concatenation, where a Windows
    // backslash would be read as an escape.
    lua.load(BOOTSTRAP)
        .set_name("bootstrap.lua")
        .call::<()>(pob.to_string_lossy().replace('\\', "/"))?;
    let boot_ms = started.elapsed().as_secs_f64() * 1000.0;
    say(format!("engine booted in {:.2}s", boot_ms / 1000.0));

    match mode.as_str() {
        "specs" => run_specs(&lua, &pob),
        "golden" => run_golden(&lua, &pob),
        "serve" => {
            // After boot: HeadlessWrapper defines its own Deflate/Inflate stubs
            // at load time and would overwrite ours.
            rpc::install(&lua, &pob, boot_ms)?;
            rpc::serve(&lua)
        }
        "bench" => {
            // Install first, or this measures a PoB that never had its asset
            // dimensions patched: headless `ImageSize()` returns 1x1, so every
            // width reads as 1 and the numbers are meaningless.
            rpc::install(&lua, &pob, boot_ms)?;
            lua.globals()
                .set("POB_PATH", pob.to_string_lossy().replace('\\', "/"))?;
            lua.load(BENCH).set_name("bench.lua").exec()?;
            Ok(())
        }
        other => Err(format!(
            "unknown mode {other:?}; expected `specs`, `golden`, `serve` or `bench`"
        )
        .into()),
    }
}

fn run_specs(lua: &Lua, pob: &Path) -> Result<(), Box<dyn Error>> {
    let specs = find_specs(pob)?;
    if specs.is_empty() {
        return Err("found no spec files under spec/System".into());
    }
    println!("spec files: {}", specs.len());

    set_path_list(lua, "SPEC_FILES", &specs)?;

    let started = Instant::now();
    lua.load(SPEC_RUNNER).set_name("spec_runner.lua").exec()?;
    println!("ran in {:.2}s", started.elapsed().as_secs_f64());

    let globals = lua.globals();
    let passed = number_global(&globals, "RESULT_PASSED");
    let failed = number_global(&globals, "RESULT_FAILED");

    if failed == 0.0 && passed > 0.0 {
        println!("PASS — {passed} assertions, all green");
        Ok(())
    } else {
        eprintln!("FAIL — {failed} failed of {}", passed + failed);
        process::exit(1);
    }
}

fn run_golden(lua: &Lua, pob: &Path) -> Result<(), Box<dyn Error>> {
    let goldens = find_goldens(pob)?;
    println!("golden snapshots: {} (informational — last regenerated 2022, v3.13)", goldens.len());
    set_path_list(lua, "GOLDEN_FILES", &goldens)?;
    lua.load(GOLDEN).set_name("golden.lua").exec()?;
    Ok(())
}

fn set_path_list(lua: &Lua, name: &str, paths: &[PathBuf]) -> Result<(), Box<dyn Error>> {
    let list = lua.create_table()?;
    for (i, path) in paths.iter().enumerate() {
        list.set(i + 1, path.to_string_lossy().replace('\\', "/"))?;
    }
    lua.globals().set(name, list)?;
    Ok(())
}

fn number_global(globals: &Table, key: &str) -> f64 {
    match globals.get::<Value>(key) {
        Ok(Value::Number(n)) => n,
        Ok(Value::Integer(i)) => i as f64,
        _ => 0.0,
    }
}

/// The `lua/` directory shipped beside this crate.
fn host_lua_dir() -> Result<PathBuf, Box<dyn Error>> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lua");
    if manifest.is_dir() {
        return Ok(manifest);
    }
    let beside_exe = env::current_exe()?
        .parent()
        .map(|p| p.join("lua"))
        .filter(|p| p.is_dir());
    beside_exe.ok_or_else(|| "could not locate the host's lua/ directory".into())
}

/// Where PoB lives: argument, then `POB_PATH`, then a checkout beside the repo.
///
/// The shell always passes the path as an argument, so the fallbacks are for
/// running this host directly — the spec suite, the benchmarks, and the JSON-RPC
/// probes used while developing.
///
/// The sibling lookup is anchored on `CARGO_MANIFEST_DIR`, which only resolves
/// in a source tree. That is deliberate: it means a shipped binary has no
/// implicit path at all and must be told where the data is.
fn resolve_pob_path(arg: Option<String>) -> Result<PathBuf, Box<dyn Error>> {
    if let Some(arg) = arg {
        return Ok(PathBuf::from(arg));
    }
    if let Ok(env_path) = env::var("POB_PATH") {
        return Ok(PathBuf::from(env_path));
    }
    // <repo>/engine-host → <repo>/../PathOfBuilding
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|dir| dir.join("PathOfBuilding"));
    if let Some(dir) = sibling {
        if dir.join("src").join("HeadlessWrapper.lua").is_file() {
            return Ok(dir);
        }
    }
    Err("pass the Path of Building directory as the second argument or set POB_PATH".into())
}

fn find_specs(pob: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let dir = pob.join("spec").join("System");
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        let Some(name) = name else { continue };
        if name.ends_with("_spec.lua") && !EXCLUDED_SPECS.contains(&name.as_str()) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

/// Every `<name>.lua` under spec/TestBuilds that has a matching `<name>.xml`.
fn find_goldens(pob: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut out = Vec::new();
    collect_goldens(&pob.join("spec").join("TestBuilds"), &mut out)?;
    out.sort();
    Ok(out)
}

fn collect_goldens(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_goldens(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "lua")
            && path.with_extension("xml").is_file()
        {
            out.push(path);
        }
    }
    Ok(())
}
