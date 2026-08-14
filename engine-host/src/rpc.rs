//! `serve` mode: newline-delimited JSON-RPC 2.0 over stdio.
//!
//! The split of responsibility here is deliberate. Rust owns only what Lua
//! cannot do: framing on stdio, a reader thread so a long streaming job can be
//! interrupted by a `tree.powerCancel` that arrives mid-flight, and zlib (PoB's
//! `Deflate`/`Inflate`, which `HeadlessWrapper.lua` stubs out). Everything else
//! — parsing, dispatch, the engine calls — lives in `lua/rpc.lua`, because that
//! is the side of the boundary that can actually touch the build object.
//!
//! One consequence of hosting a program that was written for a console: PoB
//! prints. `ConPrintf` goes through the global `print`, so in serve mode we
//! rebind `print` to stderr before booting the engine, leaving stdout clean for
//! the protocol.

use flate2::read::{ZlibDecoder, ZlibEncoder};
use flate2::Compression;
use mlua::{Function, Lua};
use std::error::Error;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, TryRecvError};
use std::time::Instant;

/// Rebind `print` to stderr. Must run *before* the engine boots, so that the
/// `ConPrintf` defined by `HeadlessWrapper.lua` picks it up on first use.
pub fn quiet_stdout(lua: &Lua) -> mlua::Result<()> {
    let print = lua.create_function(|_, args: mlua::MultiValue| {
        let err = std::io::stderr();
        let mut lock = err.lock();
        for (i, value) in args.iter().enumerate() {
            if i > 0 {
                let _ = lock.write_all(b"\t");
            }
            let text = match value {
                mlua::Value::String(s) => s.to_string_lossy().to_string(),
                other => format!("{other:?}"),
            };
            let _ = lock.write_all(text.as_bytes());
        }
        let _ = lock.write_all(b"\n");
        Ok(())
    })?;
    lua.globals().set("print", print)
}

/// Install the host primitives `lua/rpc.lua` and the api modules rely on.
///
/// `Deflate`/`Inflate` must be installed *after* the engine has booted, because
/// `HeadlessWrapper.lua` defines its own stubs at load time and would otherwise
/// overwrite ours.
pub fn install(lua: &Lua, pob: &Path, boot_ms: f64) -> mlua::Result<()> {
    let globals = lua.globals();
    let started = Instant::now();

    globals.set(
        "RPC_WRITE",
        lua.create_function(|_, line: mlua::String| {
            let out = std::io::stdout();
            let mut lock = out.lock();
            lock.write_all(&line.as_bytes())
                .and_then(|_| lock.write_all(b"\n"))
                .and_then(|_| lock.flush())
                .map_err(mlua::Error::external)
        })?,
    )?;

    globals.set(
        "RPC_LOG",
        lua.create_function(|_, line: mlua::String| {
            let err = std::io::stderr();
            let mut lock = err.lock();
            lock.write_all(&line.as_bytes())
                .and_then(|_| lock.write_all(b"\n"))
                .map_err(mlua::Error::external)
        })?,
    )?;

    // Milliseconds since `install` was called. Lua's os.clock() is CPU time on
    // some platforms, which is the wrong thing to report as elapsed wall time.
    globals.set(
        "RPC_NOW_MS",
        lua.create_function(move |_, ()| Ok(started.elapsed().as_secs_f64() * 1000.0))?,
    )?;

    // PoB share codes are base64 over a zlib stream (they decode to a 0x78
    // header, and PoB's own runtime ships zlib1.dll).
    globals.set(
        "Deflate",
        lua.create_function(|lua, data: mlua::String| {
            let bytes = data.as_bytes();
            let mut encoder = ZlibEncoder::new(&bytes[..], Compression::best());
            let mut out = Vec::new();
            encoder
                .read_to_end(&mut out)
                .map_err(mlua::Error::external)?;
            lua.create_string(&out)
        })?,
    )?;

    // Returns nil rather than raising, so a malformed share code surfaces as a
    // clean "not a valid code" instead of an engine-level error.
    globals.set(
        "Inflate",
        lua.create_function(|lua, data: mlua::String| {
            let bytes = data.as_bytes();
            let mut out = Vec::new();
            let ok = ZlibDecoder::new(&bytes[..]).read_to_end(&mut out).is_ok();
            if !ok {
                // Some third-party exporters emit a raw deflate stream.
                out.clear();
                if flate2::read::DeflateDecoder::new(&bytes[..])
                    .read_to_end(&mut out)
                    .is_err()
                {
                    return Ok(mlua::Value::Nil);
                }
            }
            Ok(mlua::Value::String(lua.create_string(&out)?))
        })?,
    )?;

    globals.set("RPC_HOST_VERSION", env!("CARGO_PKG_VERSION"))?;
    globals.set("RPC_BOOT_MS", boot_ms)?;
    globals.set("RPC_POB_COMMIT", pob_commit(pob).unwrap_or_default())?;
    Ok(())
}

/// Read the PoB checkout's HEAD commit, so the frontend can pin behaviour to an
/// exact engine revision. Best-effort: a tarball checkout simply has no commit.
fn pob_commit(pob: &Path) -> Option<String> {
    let head = std::fs::read_to_string(pob.join(".git").join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        let resolved = std::fs::read_to_string(pob.join(".git").join(reference)).ok()?;
        return Some(resolved.trim().to_string());
    }
    Some(head.to_string())
}

/// Run the request loop until stdin closes.
///
/// `rpc.lua` is loaded from disk rather than embedded, because it `require`s the
/// api modules from the same directory: having half the RPC layer baked into the
/// binary and half read at runtime is a trap worth avoiding.
pub fn serve(lua: &Lua) -> Result<(), Box<dyn Error>> {
    let host_lua: String = lua.globals().get("HOST_LUA")?;
    lua.load(format!("return dofile({:?})", host_lua + "/rpc.lua"))
        .set_name("=rpc-boot")
        .exec()?;
    let handle: Function = lua.globals().get("RPC_HANDLE")?;
    let step: Function = lua.globals().get("RPC_STEP")?;

    // Reading on its own thread is what makes cancellation work: while a
    // streaming job is mid-flight the main thread can poll for a new request
    // between chunks instead of blocking on stdin until the job finishes.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut busy = false;
    loop {
        if busy {
            match rx.try_recv() {
                Ok(line) => busy = dispatch(&handle, &line),
                Err(TryRecvError::Empty) => busy = advance(&step),
                Err(TryRecvError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(line) => busy = dispatch(&handle, &line),
                Err(_) => break,
            }
        }
    }
    Ok(())
}

/// `RPC_HANDLE` never raises — it answers with an RpcError instead — but if the
/// dispatcher itself were ever broken we still must not take the process down.
fn dispatch(handle: &Function, line: &str) -> bool {
    match handle.call::<bool>(line.trim_end_matches(['\r', '\n'])) {
        Ok(busy) => busy,
        Err(err) => {
            eprintln!("rpc: dispatcher failed: {err}");
            false
        }
    }
}

fn advance(step: &Function) -> bool {
    match step.call::<bool>(()) {
        Ok(busy) => busy,
        Err(err) => {
            eprintln!("rpc: job step failed: {err}");
            false
        }
    }
}
