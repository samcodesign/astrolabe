//! Test harness: drives a real `engine-host serve` process over the wire.
//!
//! These are not unit tests of Lua functions — they exercise the actual
//! contract, framing included, against the actual engine. Booting costs a few
//! seconds, so every test in a binary shares one process behind a mutex.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};

pub struct Host {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: i64,
}

impl Host {
    fn start() -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_engine-host"))
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // PoB narrates its boot on stderr in serve mode; let it through so a
            // failing test still shows what the engine said.
            .stderr(Stdio::inherit())
            .spawn()
            .expect("could not start engine-host");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Host { child, stdin, stdout, next_id: 1 }
    }

    fn read_message(&mut self) -> Value {
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).expect("host stdout closed");
        assert!(read > 0, "host closed its output stream");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("host emitted non-JSON: {e}\n{line}"))
    }

    /// Write a raw line, bypassing the request builder — for testing what the
    /// host does with traffic that is not a valid request.
    pub fn send_raw(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").expect("could not write to host");
        self.stdin.flush().unwrap();
    }

    /// Read one message, whatever it is.
    pub fn read(&mut self) -> Value {
        self.read_message()
    }

    /// Send a request without waiting for its answer.
    pub fn send(&mut self, method: &str, params: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{request}").expect("could not write to host");
        self.stdin.flush().unwrap();
        id
    }

    /// Send a request and read until its response, collecting any notifications
    /// that arrive first.
    pub fn call_raw(&mut self, method: &str, params: Value) -> (Value, Vec<Value>) {
        let id = self.send(method, params);
        let mut notifications = Vec::new();
        loop {
            let message = self.read_message();
            assert_eq!(message["jsonrpc"], "2.0", "every message carries the version");
            // Notifications have no id; responses always do.
            if message["id"] == json!(id) {
                return (message, notifications);
            }
            notifications.push(message);
        }
    }

    /// The `result` of a call that is expected to succeed.
    pub fn call(&mut self, method: &str, params: Value) -> Value {
        let (message, _) = self.call_raw(method, params);
        assert!(
            message["error"].is_null(),
            "{method} failed: {}",
            message["error"]
        );
        message["result"].clone()
    }

    /// The `error` of a call that is expected to fail.
    pub fn call_err(&mut self, method: &str, params: Value) -> Value {
        let (message, _) = self.call_raw(method, params);
        assert!(
            message["result"].is_null(),
            "{method} was expected to fail but returned {}",
            message["result"]
        );
        message["error"].clone()
    }

    /// Read notifications until one with `method` arrives; returns all of them.
    pub fn drain_until(&mut self, method: &str) -> Vec<Value> {
        let mut collected = Vec::new();
        loop {
            let message = self.read_message();
            let done = message["method"] == json!(method);
            collected.push(message);
            if done {
                return collected;
            }
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

static HOST: OnceLock<Mutex<Host>> = OnceLock::new();

/// The shared host. Booting takes seconds, so tests queue for it rather than
/// starting one process each.
pub fn host() -> MutexGuard<'static, Host> {
    HOST.get_or_init(|| Mutex::new(Host::start()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A build XML from PoB's own test corpus, so the fixtures and assertions are
/// about a build somebody actually made.
pub fn sample_build_xml() -> String {
    let pob = pob_path();
    let path = pob.join("spec").join("TestBuilds").join("3.13").join("OccVortex.xml");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()))
}

/// Where Path of Building lives for the test suite: `POB_PATH`, then a checkout
/// beside the repo.
///
/// Anchored on `CARGO_MANIFEST_DIR`, which only resolves inside a source tree —
/// the same property `resolve_pob_path` in `src/main.rs` relies on. The point is
/// that no machine-specific path is ever baked in; this helper used to carry one
/// and it was missed when the binary's copy was fixed.
pub fn pob_path() -> std::path::PathBuf {
    if let Ok(env_path) = std::env::var("POB_PATH") {
        return std::path::PathBuf::from(env_path);
    }
    // <repo>/engine-host → <repo>/../PathOfBuilding
    let sibling = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(|dir| dir.join("PathOfBuilding"));
    match sibling {
        Some(dir) if dir.join("src").join("HeadlessWrapper.lua").is_file() => dir,
        _ => panic!(
            "no Path of Building checkout found; set POB_PATH or place one \
             beside the repository"
        ),
    }
}

// ---------------------------------------------------------------------------
// base64, in the URL-safe alphabet PoB share codes use

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64url_decode(text: &str) -> Vec<u8> {
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut out = Vec::new();
    for c in text.bytes() {
        if c == b'=' {
            break;
        }
        let Some(index) = ALPHABET.iter().position(|&a| a == c) else { continue };
        bits = (bits << 6) | index as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    out
}

/// Where the shared fixtures live: `<repo>/fixtures`.
pub fn fixtures_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine-host has a parent directory")
        .join("fixtures")
}
