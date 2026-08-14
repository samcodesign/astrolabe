//! Owns the `engine-host` sidecar process.
//!
//! Responsibilities, in order of importance:
//!   1. Spawn it and keep newline-delimited JSON flowing both ways.
//!   2. Notice when it dies and tell the frontend *immediately*, so in-flight
//!      requests can be failed instead of hanging forever. The host boots in
//!      ~4.2 s, so a silent death would otherwise look like a slow request.
//!   3. Restart it with backoff, and give up loudly rather than thrashing.
//!
//! The frontend does all JSON-RPC correlation; this module is deliberately
//! ignorant of the protocol beyond "one message per line".

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_MESSAGE: &str = "engine://message";
pub const EVENT_STATE: &str = "engine://state";
pub const EVENT_STDERR: &str = "engine://stderr";

/// Give up after this many consecutive crashes.
const MAX_RESTARTS: u32 = 4;
/// A process that stayed up this long counts as healthy; the crash counter resets.
const HEALTHY_UPTIME: Duration = Duration::from_secs(20);
/// Keep this much stderr so a crash report has context.
const STDERR_RING: usize = 40;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostState {
    Stopped,
    Starting {
        attempt: u32,
    },
    /// Spawned, pipes attached, stdin writable. The engine still needs ~4.2 s
    /// before it answers anything — that wait belongs to the splash, not here.
    Ready,
    Exited {
        code: Option<i32>,
        stderr_tail: String,
        will_restart: bool,
    },
    Failed {
        reason: String,
    },
}

struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    state: HostState,
    /// Incremented per spawn so reader threads from a dead process are ignored.
    generation: u64,
    attempts: u32,
    spawned_at: Option<Instant>,
    shutting_down: bool,
}

pub struct Supervisor {
    app: AppHandle,
    /// Path of Building, shared with the asset route so both halves load the
    /// same checkout. Mutable: on a fresh install it is `None` until the
    /// first-run download finishes, and the engine has to be told where the
    /// data landed without a restart.
    pob_root: Mutex<Option<PathBuf>>,
    inner: Mutex<Inner>,
    stderr_ring: Mutex<VecDeque<String>>,
    generation_seq: AtomicU64,
}

impl Supervisor {
    /// Point the sidecar at a different checkout. Takes effect on the next
    /// spawn, so the caller restarts the host after a first-run download.
    pub fn set_pob_root(&self, root: Option<PathBuf>) {
        if let Ok(mut g) = self.pob_root.lock() {
            *g = root;
        }
    }

    pub fn new(app: AppHandle, pob_root: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            app,
            pob_root: Mutex::new(pob_root),
            inner: Mutex::new(Inner {
                child: None,
                stdin: None,
                state: HostState::Stopped,
                generation: 0,
                attempts: 0,
                spawned_at: None,
                shutting_down: false,
            }),
            stderr_ring: Mutex::new(VecDeque::with_capacity(STDERR_RING)),
            generation_seq: AtomicU64::new(0),
        })
    }

    pub fn state(&self) -> HostState {
        self.inner.lock().unwrap().state.clone()
    }

    /// Idempotent: calling it while the host is already up is a no-op.
    pub fn start(self: &Arc<Self>) -> Result<HostState, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.shutting_down = false;
            if matches!(inner.state, HostState::Ready | HostState::Starting { .. }) {
                return Ok(inner.state.clone());
            }
            inner.attempts = 0;
        }
        self.spawn()
    }

    pub fn stop(self: &Arc<Self>) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.shutting_down = true;
        inner.stdin.take(); // dropping stdin asks the host to exit cleanly
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.spawned_at = None;
        set_state(&self.app, &mut inner, HostState::Stopped);
        Ok(())
    }

    pub fn restart(self: &Arc<Self>) -> Result<HostState, String> {
        self.stop()?;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.shutting_down = false;
            inner.attempts = 0;
        }
        self.spawn()
    }

    /// Write one frame. The caller supplies the trailing newline; we add one if
    /// it is missing rather than corrupting the stream.
    pub fn send(&self, frame: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !matches!(inner.state, HostState::Ready) {
            return Err(format!("engine host is not running ({:?})", inner.state));
        }
        let stdin = inner
            .stdin
            .as_mut()
            .ok_or_else(|| "engine host stdin is closed".to_string())?;

        let write = (|| -> std::io::Result<()> {
            stdin.write_all(frame.as_bytes())?;
            if !frame.ends_with('\n') {
                stdin.write_all(b"\n")?;
            }
            stdin.flush()
        })();

        if let Err(err) = write {
            // A broken pipe means the host is gone but the reader thread has
            // not noticed yet. Report it now; the exit path still runs.
            drop(inner);
            return Err(format!("write to engine host failed: {err}"));
        }
        Ok(())
    }

    // ------------------------------------------------------------------

    fn spawn(self: &Arc<Self>) -> Result<HostState, String> {
        let exe = resolve_host_exe(&self.app)?;
        let generation = self.generation_seq.fetch_add(1, Ordering::SeqCst) + 1;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.attempts += 1;
            let attempt = inner.attempts;
            set_state(&self.app, &mut inner, HostState::Starting { attempt });
        }

        let mut cmd = Command::new(&exe);
        cmd.arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Always pass the resolved root rather than letting the host fall back
        // to its own lookup: the asset route serves art from this same
        // directory, and the sheet paths in `tree.geometry` only line up if
        // both halves agree on the checkout.
        if let Some(pob) = self.pob_root.lock().ok().and_then(|g| g.clone()) {
            cmd.arg(pob);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                let reason = format!("could not launch {}: {err}", exe.display());
                let mut inner = self.inner.lock().unwrap();
                set_state(&self.app, &mut inner, HostState::Failed { reason: reason.clone() });
                return Err(reason);
            }
        };

        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let stderr = child.stderr.take().ok_or("no stderr pipe")?;
        let stdin = child.stdin.take().ok_or("no stdin pipe")?;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.stdin = Some(stdin);
            inner.generation = generation;
            inner.spawned_at = Some(Instant::now());
            set_state(&self.app, &mut inner, HostState::Ready);
        }
        self.stderr_ring.lock().unwrap().clear();

        // stdout: one JSON-RPC frame per line, forwarded verbatim.
        {
            let this = Arc::clone(self);
            std::thread::Builder::new()
                .name(format!("engine-stdout-{generation}"))
                .spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        match line {
                            Ok(line) => {
                                let trimmed = line.trim();
                                if trimmed.is_empty() {
                                    continue;
                                }
                                // Pre-`serve` builds print human text on stdout.
                                // Anything that is not a JSON object is treated
                                // as a log line so it cannot poison the parser.
                                if trimmed.starts_with('{') {
                                    let _ = this.app.emit(EVENT_MESSAGE, trimmed);
                                } else {
                                    this.push_stderr(trimmed);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    this.on_child_exit(generation);
                })
                .map_err(|e| e.to_string())?;
        }

        // stderr: diagnostics, and the tail we attach to a crash report.
        {
            let this = Arc::clone(self);
            std::thread::Builder::new()
                .name(format!("engine-stderr-{generation}"))
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        this.push_stderr(&line);
                    }
                })
                .map_err(|e| e.to_string())?;
        }

        Ok(HostState::Ready)
    }

    fn push_stderr(&self, line: &str) {
        {
            let mut ring = self.stderr_ring.lock().unwrap();
            if ring.len() == STDERR_RING {
                ring.pop_front();
            }
            ring.push_back(line.to_string());
        }
        let _ = self.app.emit(EVENT_STDERR, line);
    }

    fn stderr_tail(&self) -> String {
        self.stderr_ring
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// stdout hit EOF: the process is going away. Reap it, publish the exit,
    /// and decide whether to bring it back.
    fn on_child_exit(self: &Arc<Self>, generation: u64) {
        let (code, will_restart, backoff) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return; // a stale reader thread from a previous process
            }
            inner.stdin.take();
            let code = inner
                .child
                .take()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code());

            let healthy = inner
                .spawned_at
                .map(|t| t.elapsed() >= HEALTHY_UPTIME)
                .unwrap_or(false);
            if healthy {
                inner.attempts = 0;
            }
            inner.spawned_at = None;

            let will_restart = !inner.shutting_down && inner.attempts < MAX_RESTARTS;
            // 0.5 s, 1 s, 2 s, 4 s.
            let backoff = Duration::from_millis(500u64 << inner.attempts.min(3));

            let state = if inner.shutting_down {
                HostState::Stopped
            } else {
                HostState::Exited {
                    code,
                    stderr_tail: self.stderr_tail(),
                    will_restart,
                }
            };
            set_state(&self.app, &mut inner, state);
            (code, will_restart, backoff)
        };

        if !will_restart {
            let shutting_down = self.inner.lock().unwrap().shutting_down;
            if !shutting_down {
                let mut inner = self.inner.lock().unwrap();
                let reason = format!(
                    "engine host exited {} times in a row (last code {}). Giving up.",
                    MAX_RESTARTS,
                    code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
                );
                set_state(&self.app, &mut inner, HostState::Failed { reason });
            }
            return;
        }

        let this = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(backoff);
            if this.inner.lock().unwrap().shutting_down {
                return;
            }
            if let Err(err) = this.spawn() {
                eprintln!("[supervisor] restart failed: {err}");
            }
        });
    }
}

fn set_state(app: &AppHandle, inner: &mut Inner, state: HostState) {
    inner.state = state.clone();
    let _ = app.emit(EVENT_STATE, state);
}

/// Where the sidecar lives, most specific first:
///   1. `POE_ENGINE_HOST` — an explicit override, used by CI and by devs.
///   2. the bundled resource, for an installed app.
///   3. next to our own executable (Tauri `externalBin` layout).
///   4. the sibling cargo target dir, for `npm run tauri dev` in the repo.
fn resolve_host_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) {
        "engine-host.exe"
    } else {
        "engine-host"
    };

    if let Ok(explicit) = std::env::var("POE_ENGINE_HOST") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "POE_ENGINE_HOST points at {}, which is not a file",
            p.display()
        ));
    }

    let mut tried: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        tried.push(dir.join(exe_name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            tried.push(dir.join(exe_name));
        }
    }
    // Repo layout: <root>/src-tauri/target/<profile>/app.exe → <root>/engine-host/...
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        tried.push(
            root.join("engine-host")
                .join("target")
                .join("release")
                .join(exe_name),
        );
        tried.push(
            root.join("engine-host")
                .join("target")
                .join("debug")
                .join(exe_name),
        );
    }

    for candidate in &tried {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "could not find {exe_name}. Looked in:\n{}",
        tried
            .iter()
            .map(|p| format!("  {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}
