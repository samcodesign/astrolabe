//! Serving the vendored passive-tree art to the webview.
//!
//! `tree.geometry` names every sheet it needs as a path relative to Path of
//! Building's `src/TreeData` — `3_29/skills-3.jpg`, `BackgroundStr.png`. Under
//! the dev server a Vite middleware maps `/treedata/…` onto that directory. A
//! packaged build has no dev server, so the same mapping has to exist here.
//!
//! **The root must be the one the engine used.** The sheet paths come out of
//! whichever checkout the sidecar loaded; serving art from a different one
//! yields missing or subtly mismatched sprites with no error anywhere. So the
//! root is resolved once, at startup, and the same value is handed to the
//! sidecar *and* used here — see `PobRoot`.
//!
//! Tauri exposes a custom scheme as `treedata://localhost/<path>` on macOS and
//! Linux, and `http://treedata.localhost/<path>` on Windows. Both origins are
//! in the CSP's `img-src`.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext};

/// Where Path of Building lives, resolved once at startup.
///
/// Managed state rather than a lookup at each use: the supervisor passes it to
/// the sidecar and the asset route reads from it, and those two agreeing is the
/// whole point.
/// Mutable because a fresh install resolves to nothing at startup and to a real
/// directory a minute later, once the first-run download finishes. Holding the
/// value read at launch would leave the asset route serving 404s until restart.
pub struct PobRoot(pub Mutex<Option<PathBuf>>);

impl PobRoot {
    pub fn new(root: Option<PathBuf>) -> Self {
        PobRoot(Mutex::new(root))
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|g| g.clone())
    }

    pub fn set(&self, root: Option<PathBuf>) {
        if let Ok(mut g) = self.0.lock() {
            *g = root;
        }
    }

    /// `<pob>/src`, the directory sheet paths are relative to.
    ///
    /// Not `src/TreeData`, even though nearly every sheet lives there. PoB's own
    /// art namespace is `src`: it loads tree sheets as `TreeData/…` and the
    /// jewel rings as `Assets/ShadedOuterRing.png`, and rooting a level deeper
    /// makes the second kind unnameable.
    pub fn src_dir(&self) -> Option<PathBuf> {
        self.path().map(|p| p.join("src"))
    }
}

/// Where the updater keeps its copy of Path of Building.
///
/// Under the app's data directory rather than beside the executable: the
/// install location is typically read-only for the user who runs the app
/// (`Program Files` on Windows), and this tree is written to on every update.
/// It is also the only copy that can be kept current — a bundled one is frozen
/// at whatever the installer shipped.
pub fn managed_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("PathOfBuilding"))
}

/// True when a directory holds a usable Path of Building.
///
/// `src/TreeData` rather than the directory merely existing: the updater
/// creates the root before it has fetched anything, and an empty root would
/// otherwise win the search and leave the engine loading nothing.
pub fn is_usable(root: &Path) -> bool {
    root.join("src").join("TreeData").is_dir()
}

/// Resolve Path of Building, most specific first.
///
/// Deliberately mirrors how `supervisor::resolve_host_exe` finds the sidecar —
/// walk a short list of plausible locations and take the first that exists —
/// rather than inventing a second convention.
///
/// Returning `None` is a normal first-run state, not a failure: a fresh install
/// has no data until the updater fetches it.
pub fn resolve_pob_root(app: &AppHandle) -> Option<PathBuf> {
    // An explicit override wins outright, and is not required to be usable —
    // if someone points `POB_PATH` at a broken checkout they should be told
    // that, not silently given a different one.
    if let Ok(explicit) = std::env::var("POB_PATH") {
        let p = PathBuf::from(explicit);
        if p.is_dir() {
            return Some(p);
        }
    }

    let mut tried: Vec<PathBuf> = Vec::new();

    // The updater's copy: the normal case for an installed app, and the only
    // one that receives updates.
    if let Some(managed) = managed_root(app) {
        tried.push(managed);
    }
    // Bundled as an installer resource. Not how we ship — the checkout is
    // 1.9 GB — but honoured if someone builds it that way.
    if let Ok(dir) = app.path().resource_dir() {
        tried.push(dir.join("PathOfBuilding"));
    }
    // A working copy beside the repo, which is how this runs in development.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        if let Some(parent) = root.parent() {
            tried.push(parent.join("PathOfBuilding"));
        }
    }

    tried.into_iter().find(|p| is_usable(p))
}

/// Content type from the extension. Only the formats TreeData actually holds;
/// anything else is refused rather than guessed at.
fn mime_for(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Join a request path onto the root, refusing anything that climbs out.
///
/// A webview should not be able to read arbitrary disk through this, so `..`
/// and absolute components are rejected outright instead of being normalised —
/// normalising invites a symlink to defeat it.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let decoded = percent_decode(rel);
    let candidate = Path::new(&decoded);
    for part in candidate.components() {
        match part {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    let joined = root.join(candidate);
    joined.is_file().then_some(joined)
}

/// Minimal percent-decoding: sheet names are ASCII, but a space or a `+` in a
/// future asset name should not 404.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A custom scheme is a *different origin* from the app, so anything the page
/// reads with `fetch` needs CORS headers — Pixi loads textures by fetching the
/// bytes, not by pointing an `<img>` at them, and an `<img>` is exactly the
/// case that works without these. Tauri's own asset protocol sets them too.
///
/// `*` is right here: the responses are read-only static art with no
/// credentials and nothing user-specific to leak.
fn allow_cors(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
}

fn not_found(reason: &str) -> Response<Vec<u8>> {
    allow_cors(Response::builder().status(StatusCode::NOT_FOUND))
        .header("Content-Type", "text/plain")
        .body(reason.as_bytes().to_vec())
        .expect("static response builds")
}

/// Handler for the `treedata` scheme.
///
/// A thin wrapper: everything decidable without a running app lives in
/// [`serve`], which the tests exercise against the real `TreeData` directory.
pub fn handle(ctx: UriSchemeContext<'_, tauri::Wry>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let root = match ctx.app_handle().state::<PobRoot>().src_dir() {
        Some(r) => r,
        None => return not_found("Path of Building is not available"),
    };
    // `treedata://localhost/TreeData/3_29/skills-3.jpg` and the Windows
    // `http://treedata.localhost/...` both leave the path here as `/TreeData/…`.
    serve(&root, req.uri().path())
}

/// Resolve one request path against PoB's `src` root.
pub fn serve(root: &Path, uri_path: &str) -> Response<Vec<u8>> {
    let rel = uri_path.trim_start_matches('/');
    if rel.is_empty() {
        return not_found("no asset requested");
    }

    let file = match safe_join(root, rel) {
        Some(f) => f,
        None => return not_found("no such asset"),
    };
    let mime = match mime_for(&file) {
        Some(m) => m,
        None => return not_found("unsupported asset type"),
    };
    let body = match std::fs::read(&file) {
        Ok(b) => b,
        Err(err) => return not_found(&format!("could not read asset: {err}")),
    };

    allow_cors(Response::builder().status(StatusCode::OK))
        .header("Content-Type", mime)
        // Tree art for a given version never changes.
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(body)
        .expect("response builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_that_climb_out() {
        let root = Path::new("/tree");
        assert!(safe_join(root, "../secret").is_none());
        assert!(safe_join(root, "a/../../secret").is_none());
        assert!(safe_join(root, "/etc/passwd").is_none());
        // `..` percent-encoded is still `..`.
        assert!(safe_join(root, "%2e%2e/secret").is_none());
    }

    #[test]
    fn maps_only_the_formats_treedata_holds() {
        assert_eq!(mime_for(Path::new("a/skills-3.jpg")), Some("image/jpeg"));
        assert_eq!(mime_for(Path::new("frame-3.png")), Some("image/png"));
        assert_eq!(mime_for(Path::new("bloodline-3.webp")), Some("image/webp"));
        assert_eq!(mime_for(Path::new("tree.lua")), None);
        assert_eq!(mime_for(Path::new("sprites")), None);
    }

    /// The vendored checkout, when this machine has one. Skipped otherwise so
    /// the suite stays green on a box without it.
    fn pob_src_root() -> Option<PathBuf> {
        let root = std::env::var("POB_PATH")
            .map(PathBuf::from)
            .ok()
            .or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()?
                    .parent()
                    .map(|p| p.join("PathOfBuilding"))
            })?
            .join("src");
        root.is_dir().then_some(root)
    }

    #[test]
    fn serves_the_sheets_the_geometry_asks_for() {
        let Some(root) = pob_src_root() else { return };

        // The four shapes `TreeGeometry.sheets` holds: a per-version atlas, a
        // shared TreeData asset, the legion sheets in their own directory, and —
        // the reason this is rooted at `src` rather than `src/TreeData` — the
        // jewel rings, which live outside TreeData entirely.
        for (path, mime, magic) in [
            ("/TreeData/3_29/skills-3.jpg", "image/jpeg", &[0xFF, 0xD8][..]),
            ("/TreeData/3_29/frame-3.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
            ("/TreeData/BackgroundStr.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
            ("/TreeData/legion/legion-art.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
            ("/Assets/ShadedOuterRing.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
            ("/Assets/ShadedInnerRingFlipped.png", "image/png", &[0x89, b'P', b'N', b'G'][..]),
        ] {
            let res = serve(&root, path);
            assert_eq!(res.status(), StatusCode::OK, "{path} should be served");
            assert_eq!(
                res.headers().get("Content-Type").unwrap(),
                mime,
                "{path} content type"
            );
            assert!(
                res.body().starts_with(magic),
                "{path} should be real image bytes, got {} bytes",
                res.body().len()
            );
        }
    }

    #[test]
    fn always_carries_cors_headers() {
        let Some(root) = pob_src_root() else { return };
        // Both the hit and the miss: a fetch that 404s must still be readable,
        // or the caller sees an opaque network error instead of a 404.
        for path in ["/TreeData/3_29/frame-3.png", "/TreeData/3_29/nope.png"] {
            let res = serve(&root, path);
            assert_eq!(
                res.headers().get("Access-Control-Allow-Origin").map(|v| v.as_bytes()),
                Some(&b"*"[..]),
                "{path} needs CORS: Pixi fetches texture bytes rather than using an <img>"
            );
        }
    }

    #[test]
    fn refuses_what_it_should() {
        let Some(root) = pob_src_root() else { return };

        // Missing art is a 404, not a hang or a silent empty body.
        assert_eq!(
            serve(&root, "/TreeData/3_29/no-such-sheet.png").status(),
            StatusCode::NOT_FOUND
        );
        // Rooting at `src` puts the whole engine within reach of a join, so the
        // extension allowlist is load-bearing, not a nicety: Lua is never served.
        assert_eq!(serve(&root, "/TreeData/3_29/tree.lua").status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(&root, "/TreeData/3_29/sprites.lua").status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(&root, "/HeadlessWrapper.lua").status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(&root, "/Modules/Build.lua").status(), StatusCode::NOT_FOUND);
        // Climbing out of the root.
        assert_eq!(serve(&root, "/../../README.md").status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(&root, "/").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b.png"), "a b.png");
        assert_eq!(percent_decode("plain.png"), "plain.png");
        // A stray `%` is left alone rather than eating the next characters.
        assert_eq!(percent_decode("100%.png"), "100%.png");
    }
}
