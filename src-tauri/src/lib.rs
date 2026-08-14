//! Tauri shell for PoE Planner.
//!
//! The window is a thin frame around the React app; everything interesting
//! here is process supervision (`supervisor`) and the two things a webview
//! cannot do itself: reach pathofexile.com (`poe_api`) and touch the disk.

mod build_sites;
mod pobdata;
mod poe_api;
mod supervisor;
mod treedata;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, State};

use build_sites::FetchError;
use poe_api::{CharacterQuery, ImportError};
use supervisor::{HostState, Supervisor};
use treedata::PobRoot;

type Sup<'a> = State<'a, Arc<Supervisor>>;

// ---------------------------------------------------------------------------
// engine host

#[tauri::command]
fn engine_start(sup: Sup<'_>) -> Result<HostState, String> {
    sup.start()
}

#[tauri::command]
fn engine_send(sup: Sup<'_>, frame: String) -> Result<(), String> {
    sup.send(&frame)
}

#[tauri::command]
fn engine_stop(sup: Sup<'_>) -> Result<(), String> {
    sup.stop()
}

#[tauri::command]
fn engine_restart(sup: Sup<'_>) -> Result<HostState, String> {
    sup.restart()
}

#[tauri::command]
fn engine_status(sup: Sup<'_>) -> HostState {
    sup.state()
}

// ---------------------------------------------------------------------------
// game data
//
// Without PoB's data the engine cannot start, so on a fresh install this runs
// before anything else the app does.

#[tauri::command]
fn data_status(app: tauri::AppHandle) -> pobdata::DataStatus {
    pobdata::status(&app)
}

#[tauri::command]
async fn data_tree_versions(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pobdata::tree_versions(&app))
        .await
        .map_err(|e| format!("listing tree versions panicked: {e}"))?
}

#[tauri::command]
async fn data_check(app: tauri::AppHandle) -> Result<Option<pobdata::UpdateInfo>, String> {
    // A network round-trip, so off the runtime's worker like the install.
    tauri::async_runtime::spawn_blocking(move || pobdata::check(&app))
        .await
        .map_err(|e| format!("the update check panicked: {e}"))?
}

#[tauri::command]
async fn data_install(
    app: tauri::AppHandle,
    tree_versions: Vec<String>,
) -> Result<pobdata::DataStatus, String> {
    // Blocking work — a 240 MB download — so it must not hold the async
    // runtime's worker while the webview is waiting to paint progress.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || pobdata::install(&handle, tree_versions))
        .await
        .map_err(|e| format!("the data download panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// character import

#[tauri::command]
async fn fetch_character(query: CharacterQuery) -> Result<Value, ImportError> {
    poe_api::fetch_character(query).await
}

#[tauri::command]
async fn fetch_character_list(query: CharacterQuery) -> Result<Value, ImportError> {
    poe_api::fetch_character_list(query).await
}

// ---------------------------------------------------------------------------
// build links
//
// A geared build's code runs to tens of thousands of characters, and one that
// loses a chunk in transit fails to inflate with nothing useful to say. PoB
// solves this by accepting a paste-site link and fetching the code itself
// (`Modules/BuildSiteTools.lua`); this is the same thing.

#[tauri::command]
async fn fetch_build_code(link: String) -> Result<String, FetchError> {
    build_sites::fetch_build_code(link).await
}

#[tauri::command]
fn build_site_labels() -> Vec<&'static str> {
    build_sites::supported_labels()
}

// ---------------------------------------------------------------------------
// files
//
// Paths always come from the dialog plugin, i.e. from an explicit user pick.

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, contents).map_err(|e| format!("could not write {path}: {e}"))
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The passive tree's art, which the webview loads by URL. Registered
        // before `setup` so the first frame can already resolve sheets.
        .register_uri_scheme_protocol("treedata", treedata::handle)
        .setup(|app| {
            // Resolved once and shared: the sidecar is told which Path of
            // Building to load, and the asset route serves art out of the same
            // one. Two independent lookups could disagree, and the symptom
            // would be missing sprites with nothing logged anywhere.
            let resolved = treedata::resolve_pob_root(app.handle());
            if resolved.is_none() {
                // Not an error on a fresh install: the app shows a first-run
                // screen and `data_install` fetches the data.
                eprintln!(
                    "poe-planner: no Path of Building data yet; the first-run download will fetch it (or set POB_PATH)."
                );
            }
            let root = PobRoot::new(resolved.clone());
            let sup = Supervisor::new(app.handle().clone(), resolved);
            app.manage(root);
            app.manage(sup);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_send,
            engine_stop,
            engine_restart,
            engine_status,
            data_status,
            data_check,
            data_tree_versions,
            data_install,
            fetch_character,
            fetch_character_list,
            fetch_build_code,
            build_site_labels,
            read_text_file,
            write_text_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // Never leave an orphaned LuaJIT process behind.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(sup) = app.try_state::<Arc<Supervisor>>() {
                    let _ = sup.stop();
                }
            }
        });
}
