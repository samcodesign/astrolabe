use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use futures::StreamExt;
use pob_updater::apply::{self, Txn};
use pob_updater::hash;
use pob_updater::manifest::{KNOWN_PARTS, Manifest};
use pob_updater::net::{self, Http, human_bytes};
use pob_updater::plan::{self, Plan, PlanInput};
use pob_updater::selector::Selection;
use pob_updater::state::{Config, Workspace, format_ts, now_secs};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// Keep a vendored copy of Path of Building's game data up to date.
#[derive(Parser, Debug)]
#[command(name = "pob-updater", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Debug, Clone)]
struct RootArg {
    /// Vendored PoB directory. Defaults to $POB_UPDATER_ROOT, else ./vendor/pob
    #[arg(long, short = 'r', global = true)]
    root: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Create a vendored workspace and write its config.
    Init {
        #[command(flatten)]
        root: RootArg,
        /// owner/name of the upstream repository.
        #[arg(long, default_value = pob_updater::state::DEFAULT_REPO)]
        repo: String,
        /// Branch to follow.
        #[arg(long, default_value = pob_updater::state::DEFAULT_BRANCH)]
        branch: String,
        /// Manifest parts to vendor.
        #[arg(long, value_delimiter = ',', default_values_t = pob_updater::state::default_parts())]
        parts: Vec<String>,
        /// Tree versions to vendor, e.g. 3_26. Repeatable. Omit for all of them.
        #[arg(long = "tree", value_delimiter = ',')]
        tree_versions: Vec<String>,
        #[arg(long, default_value_t = 8)]
        concurrency: usize,
        #[arg(long, default_value = pob_updater::state::DEFAULT_PLATFORM)]
        platform: String,
    },
    /// Report what an update would change. Downloads nothing but the manifest.
    Check {
        #[command(flatten)]
        root: RootArg,
        #[command(flatten)]
        scope: ScopeArgs,
        /// Re-hash local files instead of trusting the vendored manifest.
        #[arg(long)]
        verify: bool,
        /// Skip the GitHub API calls (commit resolution and byte sizes).
        #[arg(long)]
        no_api: bool,
        #[arg(long)]
        json: bool,
    },
    /// Download and apply changed files.
    Update {
        #[command(flatten)]
        root: RootArg,
        #[command(flatten)]
        scope: ScopeArgs,
        /// Plan and report, but do not download or apply.
        #[arg(long)]
        dry_run: bool,
        /// Trust the vendored manifest instead of re-hashing local files.
        #[arg(long)]
        no_verify: bool,
        /// Persist --parts/--tree from this run as the new default selection.
        #[arg(long)]
        save_scope: bool,
        #[arg(long)]
        json: bool,
        /// Emit one JSON object per line as work proceeds, for a caller driving
        /// this as a subprocess. Replaces the human progress text; the final
        /// summary still honours --json.
        #[arg(long)]
        progress_json: bool,
    },
    /// Pin to a specific upstream commit so updates are deliberate.
    Pin {
        #[command(flatten)]
        root: RootArg,
        /// Commit SHA to pin to. Omit to pin to the tracked branch's head.
        commit: Option<String>,
        /// Retarget the tracked branch.
        #[arg(long)]
        branch: Option<String>,
        /// Remove the pin and follow the branch again.
        #[arg(long)]
        unpin: bool,
    },
    /// List the tree versions upstream offers. Needs no vendored workspace.
    Versions {
        #[arg(long, default_value = pob_updater::state::DEFAULT_REPO)]
        repo: String,
        #[arg(long, default_value = pob_updater::state::DEFAULT_BRANCH)]
        branch: String,
        #[arg(long)]
        json: bool,
    },
    /// Report the vendored version, pin, and selection.
    Status {
        #[command(flatten)]
        root: RootArg,
        #[arg(long)]
        json: bool,
    },
    /// Re-hash the vendored tree against its own manifest. No network.
    Verify {
        #[command(flatten)]
        root: RootArg,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Args, Debug, Clone, Default)]
struct ScopeArgs {
    /// Override the configured parts for this run.
    #[arg(long, value_delimiter = ',')]
    parts: Option<Vec<String>>,
    /// Override the configured tree versions for this run. `all` selects every version.
    #[arg(long = "tree", value_delimiter = ',')]
    tree_versions: Option<Vec<String>>,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    match cli.command {
        Command::Init {
            root,
            repo,
            branch,
            parts,
            tree_versions,
            concurrency,
            platform,
        } => {
            let root = resolve_root(&root);
            validate_parts(&parts)?;
            let config = Config {
                repo,
                branch,
                platform,
                parts,
                tree_versions: if tree_versions.is_empty() {
                    None
                } else {
                    Some(tree_versions)
                },
                concurrency: concurrency.clamp(1, 32),
                ..Config::default()
            };
            let ws = Workspace::init(&root, config)?;
            println!("Initialised vendored PoB workspace at {}", ws.root.display());
            println!("  repo:    {}", ws.config.repo);
            println!("  branch:  {}", ws.config.branch);
            println!("  parts:   {}", ws.config.parts.join(", "));
            println!("  tree:    {}", describe_tree(&ws.config.tree_versions));
            println!("\nNext: pob-updater update --root {}", ws.root.display());
            Ok(())
        }
        Command::Check {
            root,
            scope,
            verify,
            no_api,
            json,
        } => rt.block_on(cmd_check(&resolve_root(&root), scope, verify, no_api, json)),
        Command::Update {
            root,
            scope,
            dry_run,
            no_verify,
            save_scope,
            json,
            progress_json,
        } => rt.block_on(cmd_update(
            &resolve_root(&root),
            scope,
            dry_run,
            !no_verify,
            save_scope,
            json,
            progress_json,
        )),
        Command::Pin {
            root,
            commit,
            branch,
            unpin,
        } => rt.block_on(cmd_pin(&resolve_root(&root), commit, branch, unpin)),
        Command::Versions { repo, branch, json } => {
            rt.block_on(cmd_versions(&repo, &branch, json))
        }
        Command::Status { root, json } => cmd_status(&resolve_root(&root), json),
        Command::Verify { root, json } => cmd_verify(&resolve_root(&root), json),
    }
}

fn resolve_root(arg: &RootArg) -> PathBuf {
    arg.root
        .clone()
        .or_else(|| std::env::var_os("POB_UPDATER_ROOT").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("vendor/pob"))
}

fn validate_parts(parts: &[String]) -> Result<()> {
    for p in parts {
        if !KNOWN_PARTS.contains(&p.as_str()) {
            bail!(
                "unknown part `{p}`; expected one of: {}",
                KNOWN_PARTS.join(", ")
            );
        }
    }
    if parts.is_empty() {
        bail!("at least one part must be selected");
    }
    Ok(())
}

fn describe_tree(v: &Option<Vec<String>>) -> String {
    match v {
        None => "all versions".to_string(),
        Some(v) if v.is_empty() => "all versions".to_string(),
        Some(v) => v.join(", "),
    }
}

fn build_selection(ws: &Workspace, scope: &ScopeArgs) -> Result<Selection> {
    let parts = scope
        .parts
        .clone()
        .unwrap_or_else(|| ws.config.parts.clone());
    validate_parts(&parts)?;
    let tree = match &scope.tree_versions {
        Some(v) if v.iter().any(|s| s == "all") => None,
        Some(v) if v.is_empty() => ws.config.tree_versions.clone(),
        Some(v) => Some(v.clone()),
        None => ws.config.tree_versions.clone(),
    };
    Ok(Selection::new(parts, tree, &ws.config.platform))
}

/// Everything `check` and `update` both need: recovery, ref resolution, the
/// remote manifest and the diff.
struct Resolved {
    remote: Manifest,
    local: Manifest,
    commit: Option<String>,
    git_ref: String,
    manifest_cached: bool,
    plan: Plan,
    selection: Selection,
    timings: Vec<(&'static str, f64)>,
}

async fn resolve_and_plan(
    ws: &Workspace,
    http: &Http,
    selection: &Selection,
    verify_local: bool,
    use_api: bool,
) -> Result<Resolved> {
    let mut timings = Vec::new();

    // Resolve the ref to an immutable commit first. Beyond making `status`
    // meaningful, it means the manifest and every file we fetch come from the
    // same commit — a push landing mid-update cannot give us a manifest from one
    // tree and files from another.
    let t = Instant::now();
    let configured_ref = ws.git_ref();
    let commit = if use_api {
        match net::resolve_commit(http, &ws.config.repo, &configured_ref).await {
            Ok(sha) => Some(sha),
            Err(e) => {
                eprintln!("warning: could not resolve `{configured_ref}` to a commit ({e:#});");
                eprintln!("         falling back to the mutable ref");
                None
            }
        }
    } else {
        net::is_commit_sha(&configured_ref).then(|| configured_ref.to_ascii_lowercase())
    };
    timings.push(("resolve ref", t.elapsed().as_secs_f64()));

    let git_ref = commit.clone().unwrap_or(configured_ref);

    let t = Instant::now();
    let manifest_url = net::raw_url(&ws.config.repo, &git_ref, "manifest.xml");
    let fetched = http
        .get_conditional(&manifest_url)
        .await
        .context("could not download the remote manifest")?;
    let manifest_cached = fetched.was_cached();
    let bytes = fetched.into_bytes();
    let remote = Manifest::parse(&String::from_utf8_lossy(&bytes))
        .context("remote manifest is not a valid PoB manifest")?;
    timings.push(("fetch manifest", t.elapsed().as_secs_f64()));

    let t = Instant::now();
    let sizes: BTreeMap<String, u64> = match (&commit, use_api) {
        (Some(sha), true) => net::fetch_blob_sizes(http, &ws.config.repo, sha)
            .await
            .unwrap_or_else(|e| {
                eprintln!("warning: could not fetch blob sizes ({e:#}); sizes unavailable");
                BTreeMap::new()
            }),
        _ => BTreeMap::new(),
    };
    timings.push(("fetch sizes", t.elapsed().as_secs_f64()));

    let local = ws.local_manifest()?.unwrap_or_else(|| Manifest {
        version: "0.0.0".into(),
        ..Manifest::default()
    });

    let t = Instant::now();
    let plan = plan::compute(&PlanInput {
        local: &local,
        remote: &remote,
        selection,
        root: &ws.root,
        verify_local,
        sizes: &sizes,
    });
    timings.push(("diff", t.elapsed().as_secs_f64()));

    Ok(Resolved {
        remote,
        local,
        commit,
        git_ref,
        manifest_cached,
        plan,
        selection: selection.clone(),
        timings,
    })
}

fn make_http(ws: &Workspace) -> Result<Http> {
    Http::new(
        &ws.config.user_agent,
        ws.config.concurrency,
        ws.config.max_attempts,
        &ws.cache_dir(),
    )
}

fn run_recovery(ws: &Workspace) -> Result<()> {
    let rec = apply::recover(&ws.txn_dir())?;
    if rec.rolled_back > 0 {
        eprintln!(
            "note: rolled back {} interrupted update(s), restoring {} file(s); the tree is back to its previous state",
            rec.rolled_back, rec.restored_files
        );
    }
    Ok(())
}

async fn cmd_check(
    root: &Path,
    scope: ScopeArgs,
    verify: bool,
    no_api: bool,
    json: bool,
) -> Result<()> {
    let started = Instant::now();
    let mut ws = Workspace::open(root)?;
    run_recovery(&ws)?;
    let selection = build_selection(&ws, &scope)?;
    let http = make_http(&ws)?;

    let r = resolve_and_plan(&ws, &http, &selection, verify, !no_api).await?;
    let elapsed = started.elapsed().as_secs_f64();

    ws.state.last_check = Some(now_secs());
    ws.save_state().ok();

    if json {
        println!("{}", serde_json::to_string_pretty(&plan_json(&ws, &r, elapsed))?);
    } else {
        print_plan(&ws, &r, elapsed, verify);
    }
    if !r.plan.is_empty() {
        // Exit 0 still: "changes available" is not an error. Callers who want a
        // signal can use --json.
    }
    Ok(())
}

fn plan_json(ws: &Workspace, r: &Resolved, elapsed: f64) -> serde_json::Value {
    serde_json::json!({
        "root": ws.root.display().to_string(),
        "repo": ws.config.repo,
        "ref": r.git_ref,
        "commit": r.commit,
        "pinned": ws.is_pinned(),
        "manifest_from_cache": r.manifest_cached,
        "local_version": r.local.version,
        "remote_version": r.remote.version,
        "parts": r.selection.parts.iter().cloned().collect::<Vec<_>>(),
        "tree_versions": r.selection.tree_versions.as_ref()
            .map(|s| s.iter().cloned().collect::<Vec<_>>()),
        "updates": r.plan.updates.len(),
        "deletes": r.plan.deletes.len(),
        "unchanged": r.plan.unchanged,
        "bytes": r.plan.known_bytes(),
        "bytes_unknown_files": r.plan.unknown_size_count(),
        "by_reason": r.plan.counts_by_reason(),
        "elapsed_secs": (elapsed * 1000.0).round() / 1000.0,
        "timings": r.timings.iter()
            .map(|(k, v)| serde_json::json!({"step": k, "secs": (v * 1000.0).round() / 1000.0}))
            .collect::<Vec<_>>(),
        "changed_files": r.plan.updates.iter().take(500).map(|c| serde_json::json!({
            "path": c.repo_path, "reason": c.reason.label(), "sha1": c.entry.sha1, "size": c.size,
        })).collect::<Vec<_>>(),
        "deleted_files": r.plan.deletes.iter().take(500)
            .map(|d| d.entry.name.clone()).collect::<Vec<_>>(),
    })
}

fn print_plan(ws: &Workspace, r: &Resolved, elapsed: f64, verified: bool) {
    println!("Vendored root : {}", ws.root.display());
    println!("Upstream      : {} @ {}", ws.config.repo, ws.config.branch);
    println!(
        "Ref           : {}{}",
        r.commit.as_deref().unwrap_or(&r.git_ref),
        if ws.is_pinned() { " (pinned)" } else { " (branch head)" }
    );
    println!(
        "Manifest      : local {} -> remote {}{}",
        r.local.version,
        r.remote.version,
        if r.manifest_cached { " [304 not modified]" } else { "" }
    );
    println!(
        "Selection     : parts {} | tree {}",
        r.selection.parts.iter().cloned().collect::<Vec<_>>().join(","),
        match &r.selection.tree_versions {
            None => "all".to_string(),
            Some(s) => s.iter().cloned().collect::<Vec<_>>().join(","),
        }
    );
    println!();

    if r.plan.is_empty() {
        println!(
            "Up to date. {} selected file(s) match{}.",
            r.plan.unchanged,
            if verified { " (contents re-hashed)" } else { "" }
        );
    } else {
        let by_reason = r
            .plan
            .counts_by_reason()
            .into_iter()
            .map(|(k, v)| format!("{v} {k}"))
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "{} file(s) to download ({by_reason})",
            r.plan.updates.len()
        );
        let bytes = r.plan.known_bytes();
        let unknown = r.plan.unknown_size_count();
        if unknown == 0 {
            println!("{} to transfer", human_bytes(bytes));
        } else if bytes > 0 {
            println!(
                "{} to transfer (+{unknown} file(s) of unknown size)",
                human_bytes(bytes)
            );
        } else {
            println!("transfer size unavailable (GitHub API not reachable)");
        }
        if !r.plan.deletes.is_empty() {
            println!("{} file(s) to delete", r.plan.deletes.len());
        }
        println!("{} file(s) unchanged", r.plan.unchanged);

        println!();
        for c in r.plan.updates.iter().take(20) {
            println!(
                "  {:<8} {}{}",
                c.reason.label(),
                c.repo_path,
                c.size.map(|s| format!("  ({})", human_bytes(s))).unwrap_or_default()
            );
        }
        if r.plan.updates.len() > 20 {
            println!("  ... and {} more", r.plan.updates.len() - 20);
        }
        for d in r.plan.deletes.iter().take(10) {
            println!("  {:<8} {}", "delete", d.entry.name);
        }
        if r.plan.deletes.len() > 10 {
            println!("  ... and {} more deletions", r.plan.deletes.len() - 10);
        }
    }

    println!();
    let steps = r
        .timings
        .iter()
        .map(|(k, v)| format!("{k} {:.2}s", v))
        .collect::<Vec<_>>()
        .join(" | ");
    println!("check completed in {elapsed:.2}s  [{steps}]");
    if r.plan.verified > 0 {
        println!("({} local file(s) re-hashed)", r.plan.verified);
    }
}

async fn cmd_update(
    root: &Path,
    scope: ScopeArgs,
    dry_run: bool,
    verify_local: bool,
    save_scope: bool,
    json: bool,
    progress_json: bool,
) -> Result<()> {
    let started = Instant::now();
    // One JSON object per line, flushed as it happens, so a caller driving this
    // as a subprocess gets progress without parsing prose. Every branch that
    // ends the run emits a terminal event, so a reader never has to infer an
    // outcome from silence.
    let emit = |value: serde_json::Value| {
        if progress_json {
            println!("{value}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    };
    let mut ws = Workspace::open(root)?;
    run_recovery(&ws)?;
    let selection = build_selection(&ws, &scope)?;
    let http = make_http(&ws)?;

    let r = resolve_and_plan(&ws, &http, &selection, verify_local, true).await?;

    // An empty plan does not mean there is nothing to do: the extras carry no
    // manifest entry, so a copy whose manifest matches upstream can still be
    // missing its entry point. Checking the files themselves is the only way to
    // know, and it is what makes `update` repair such a copy instead of
    // reporting "already up to date" over a tree that cannot boot.
    let missing_extras: Vec<&String> = ws
        .config
        .extra_files
        .iter()
        .filter(|rel| !ws.root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)).is_file())
        .collect();

    emit(serde_json::json!({
        "event": "resolved",
        "ref": r.git_ref,
        "commit": r.commit,
        "version": r.remote.version,
    }));

    if r.plan.is_empty() && missing_extras.is_empty() {
        emit(serde_json::json!({ "event": "uptodate", "checked": r.plan.unchanged }));
        ws.state.last_check = Some(now_secs());
        if let Some(c) = &r.commit {
            ws.state.applied_commit = Some(c.clone());
        }
        ws.save_state().ok();
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "applied": false, "reason": "up-to-date",
                    "ref": r.git_ref, "commit": r.commit,
                }))?
            );
        } else if !progress_json {
            println!("Already up to date ({} file(s) checked).", r.plan.unchanged);
        }
        return Ok(());
    }

    if dry_run {
        print_plan(&ws, &r, started.elapsed().as_secs_f64(), verify_local);
        println!("\n(dry run — nothing downloaded)");
        return Ok(());
    }

    emit(serde_json::json!({
        "event": "plan",
        "files": r.plan.updates.len(),
        "deletes": r.plan.deletes.len(),
        "bytes": r.plan.known_bytes(),
        "extras": missing_extras.len(),
    }));
    if !progress_json {
        println!(
            "Downloading {} file(s), {} ...",
            r.plan.updates.len(),
            if r.plan.known_bytes() > 0 {
                human_bytes(r.plan.known_bytes())
            } else {
                "size unknown".into()
            }
        );
    }

    let dl_start = Instant::now();
    let mut txn = Txn::begin(&ws.txn_dir())?;

    // Content-addressed staging means duplicate SHA1s are fetched once.
    let mut wanted: BTreeMap<String, String> = BTreeMap::new(); // sha1 -> repo_path
    for c in &r.plan.updates {
        wanted.entry(c.entry.sha1.clone()).or_insert(c.repo_path.clone());
    }
    let total = wanted.len();
    let done = AtomicUsize::new(0);
    let reused = AtomicUsize::new(0);
    let bytes_in = AtomicUsize::new(0);

    let results: Vec<Result<()>> = futures::stream::iter(wanted.into_iter().map(|(sha1, path)| {
        let http = &http;
        let txn = &txn;
        let done = &done;
        let reused = &reused;
        let bytes_in = &bytes_in;
        let repo = ws.config.repo.clone();
        let git_ref = r.git_ref.clone();
        async move {
            if txn.blob_ready(&sha1) {
                reused.fetch_add(1, Ordering::Relaxed);
            } else {
                let url = net::raw_url(&repo, &git_ref, &path);
                let bytes = http
                    .get(&url)
                    .await
                    .with_context(|| format!("downloading {path}"))?;
                bytes_in.fetch_add(bytes.len(), Ordering::Relaxed);
                txn.stage(&sha1, &bytes).with_context(|| {
                    format!(
                        "{path} failed verification after download \
                         (tried raw, Lua CRLF and normalised CRLF hashing)"
                    )
                })?;
            }
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if progress_json {
                // Every file, not every 25th: the caller is driving a progress
                // bar and coarse steps make a long download look stalled.
                emit(serde_json::json!({
                    "event": "staged",
                    "done": n,
                    "total": total,
                    "bytes": bytes_in.load(Ordering::Relaxed),
                }));
            } else if n.is_multiple_of(25) || n == total {
                println!("  staged {n}/{total}");
            }
            Ok(())
        }
    }))
    .buffer_unordered(ws.config.concurrency.max(1))
    .collect()
    .await;

    let failures: Vec<String> = results
        .into_iter()
        .filter_map(|r| r.err().map(|e| format!("{e:#}")))
        .collect();

    if !failures.is_empty() {
        // Keep the staging directory: blobs already verified will be reused by
        // the next attempt. The live tree has not been touched.
        txn.keep_for_resume();
        // A terminal event on the failure path too. A caller that only listens
        // for "done" cannot tell a crash from a slow download.
        emit(serde_json::json!({
            "event": "failed",
            "failures": failures.len(),
            "staged": done.load(Ordering::Relaxed),
            "detail": failures.iter().take(5).collect::<Vec<_>>(),
        }));
        eprintln!("\n{} file(s) failed:", failures.len());
        for f in failures.iter().take(10) {
            eprintln!("  {f}");
        }
        bail!(
            "update aborted before any change was applied; the vendored copy is untouched. \
             Re-run `update` to resume from the {} staged file(s).",
            done.load(Ordering::Relaxed)
        );
    }
    let download_secs = dl_start.elapsed().as_secs_f64();

    // Build the ops. Deletes first, installs next, manifest last, so an
    // unrecoverable interruption leaves a manifest describing the old state.
    for d in &r.plan.deletes {
        if d.dest.exists() {
            txn.push_delete(d.dest.clone());
        }
    }
    for c in &r.plan.updates {
        txn.push_install(c.dest.clone(), &c.entry.sha1);
    }

    // Files the manifest does not list but the vendored copy needs anyway —
    // `src/HeadlessWrapper.lua`, which ships in no release. Fetched at the same
    // ref and installed in the same transaction, so a copy is never left with
    // sources from one revision and an entry point from another.
    let mut extra_sha1: BTreeMap<String, String> = BTreeMap::new();
    for rel in &ws.config.extra_files {
        let url = net::raw_url(&ws.config.repo, &r.git_ref, rel);
        let bytes = http
            .get(&url)
            .await
            .with_context(|| format!("downloading {rel} (not in the manifest, but required)"))?;
        let sha1 = hash::sha1_hex(&bytes);
        // No manifest hash to check against, so stage under the hash of what
        // actually arrived; the transaction still verifies it round-trips.
        txn.stage(&sha1, &bytes)
            .with_context(|| format!("staging {rel}"))?;
        let mut dest = ws.root.clone();
        for seg in rel.split('/') {
            dest.push(seg);
        }
        txn.push_install(dest, &sha1);
        extra_sha1.insert(rel.clone(), sha1);
    }

    let mut new_manifest = plan::merged_manifest(&r.local, &r.remote, &selection);
    new_manifest.platform = Some(ws.config.platform.clone());
    new_manifest.branch = Some(ws.config.branch.clone());
    let manifest_xml = new_manifest.to_xml();
    let manifest_sha = hash::sha1_hex(manifest_xml.as_bytes());
    txn.stage(&manifest_sha, manifest_xml.as_bytes())
        .context("could not stage the new manifest")?;
    txn.push_install(ws.manifest_path(), &manifest_sha);

    emit(serde_json::json!({ "event": "applying", "files": r.plan.updates.len() }));
    let commit_start = Instant::now();
    let deleted_dirs: Vec<PathBuf> = r
        .plan
        .deletes
        .iter()
        .filter_map(|d| d.dest.parent().map(|p| p.to_path_buf()))
        .collect();
    txn.commit().context("applying the update failed")?;
    for dir in deleted_dirs {
        apply::prune_empty_dirs(&ws.root, dir);
    }
    let commit_secs = commit_start.elapsed().as_secs_f64();

    ws.state.applied_commit = r.commit.clone();
    ws.state.applied_version = Some(r.remote.version.clone());
    ws.state.extra_file_sha1 = extra_sha1;
    ws.state.last_update = Some(now_secs());
    ws.state.last_check = Some(now_secs());
    if save_scope {
        ws.config.parts = selection.parts.iter().cloned().collect();
        ws.config.tree_versions = selection
            .tree_versions
            .as_ref()
            .map(|s| s.iter().cloned().collect());
        ws.save_config()?;
    }
    ws.save_state()?;

    let total_secs = started.elapsed().as_secs_f64();
    emit(serde_json::json!({
        "event": "done",
        "installed": r.plan.updates.len(),
        "deleted": r.plan.deletes.len(),
        "extras": ws.state.extra_file_sha1.len(),
        "bytes": bytes_in.load(Ordering::Relaxed),
        "version": r.remote.version,
        "commit": r.commit,
        "seconds": (total_secs * 100.0).round() / 100.0,
    }));
    if progress_json && !json {
        // The stream is the output; a prose summary after it would just be
        // noise the caller has to skip.
        return Ok(());
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "applied": true,
                "ref": r.git_ref,
                "commit": r.commit,
                "version": r.remote.version,
                "files_installed": r.plan.updates.len(),
                "files_deleted": r.plan.deletes.len(),
                "blobs_downloaded": total - reused.load(Ordering::Relaxed),
                "blobs_reused": reused.load(Ordering::Relaxed),
                "bytes_downloaded": bytes_in.load(Ordering::Relaxed),
                "download_secs": (download_secs * 100.0).round() / 100.0,
                "commit_secs": (commit_secs * 100.0).round() / 100.0,
                "total_secs": (total_secs * 100.0).round() / 100.0,
            }))?
        );
    } else {
        println!(
            "\nApplied: {} installed, {} deleted, {} downloaded in {download_secs:.2}s, \
             swap in {commit_secs:.2}s (total {total_secs:.2}s)",
            r.plan.updates.len(),
            r.plan.deletes.len(),
            human_bytes(bytes_in.load(Ordering::Relaxed) as u64),
        );
        println!("Now at manifest {} @ {}", r.remote.version, r.git_ref);
        if !ws.is_pinned() {
            println!(
                "Tip: `pob-updater pin` records this commit so future updates are deliberate."
            );
        }
    }
    Ok(())
}

async fn cmd_pin(
    root: &Path,
    commit: Option<String>,
    branch: Option<String>,
    unpin: bool,
) -> Result<()> {
    let mut ws = Workspace::open(root)?;
    if let Some(b) = branch {
        ws.config.branch = b;
        ws.save_config()?;
        println!("Tracking branch: {}", ws.config.branch);
    }
    if unpin {
        ws.state.pinned_commit = None;
        ws.save_state()?;
        println!("Unpinned; following {} @ {}", ws.config.repo, ws.config.branch);
        return Ok(());
    }

    let http = make_http(&ws)?;
    let target = match commit {
        Some(c) if net::is_commit_sha(&c) => c.to_ascii_lowercase(),
        Some(other) => net::resolve_commit(&http, &ws.config.repo, &other).await?,
        None => net::resolve_commit(&http, &ws.config.repo, &ws.config.branch).await?,
    };

    // Confirm the ref actually has a manifest before pinning to it.
    let url = net::raw_url(&ws.config.repo, &target, "manifest.xml");
    let bytes = http
        .get_conditional(&url)
        .await
        .with_context(|| format!("could not read manifest.xml at {target}"))?
        .into_bytes();
    let remote = Manifest::parse(&String::from_utf8_lossy(&bytes))?;

    let previous = ws.state.pinned_commit.clone();
    ws.state.pinned_commit = Some(target.clone());
    ws.save_state()?;

    println!("Pinned to {target}");
    println!("  manifest version : {}", remote.version);
    println!("  files in manifest: {}", remote.files.len());
    if let Some(p) = previous
        && p != target
    {
        println!("  previous pin     : {p}");
    }
    if ws.state.applied_commit.as_deref() != Some(target.as_str()) {
        println!("\nThe vendored copy is not at this commit yet. Run `pob-updater update`.");
    }
    Ok(())
}

/// Which tree versions upstream has, newest first.
///
/// Deliberately workspace-free: this is what a first run needs *before* it has
/// vendored anything, so it cannot read a local manifest. Without it the app
/// has to name a version as a literal, and that literal is wrong the day the
/// next league ships.
async fn cmd_versions(repo: &str, branch: &str, json: bool) -> Result<()> {
    let http = Http::new(
        &pob_updater::state::default_user_agent(),
        4,
        3,
        &std::env::temp_dir().join("pob-updater-versions"),
    )?;
    let url = net::raw_url(repo, branch, "manifest.xml");
    let bytes = http.get(&url).await.context("fetching the manifest")?;
    let manifest = Manifest::parse(&String::from_utf8_lossy(&bytes))?;
    let versions = sort_tree_versions(Selection::available_tree_versions(&manifest.files));

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "version": manifest.version,
                "tree_versions": versions,
                "latest": versions.first(),
            }))?
        );
    } else {
        println!("manifest {} — {} tree version(s)", manifest.version, versions.len());
        for v in &versions {
            println!("  {v}");
        }
    }
    Ok(())
}

/// Newest first, by version number rather than by string.
///
/// Lexicographic order is wrong here in a way that matters: `"3_9"` sorts after
/// `"3_29"`, so the plain sort would call 3.9 the newest tree and a fresh
/// install would vendor a seven-year-old passive tree.
///
/// Plain versions sort ahead of their `_ruthless` / `_alternate` siblings at the
/// same number, so `latest` is the one a normal build wants.
fn sort_tree_versions(set: std::collections::BTreeSet<String>) -> Vec<String> {
    let key = |v: &String| {
        let mut digits = v.split('_').map_while(|p| p.parse::<u32>().ok());
        let major = digits.next().unwrap_or(0);
        let minor = digits.next().unwrap_or(0);
        // Suffixed variants after the plain one at the same number.
        let suffixed = v.split('_').skip(2).next().is_some();
        (major, minor, !suffixed)
    };
    let mut out: Vec<String> = set.into_iter().collect();
    out.sort_by(|a, b| key(b).cmp(&key(a)).then_with(|| a.cmp(b)));
    out
}

fn cmd_status(root: &Path, json: bool) -> Result<()> {
    let ws = Workspace::open(root)?;
    run_recovery(&ws)?;
    let local = ws.local_manifest()?;

    let (files, bytes, parts_present, tree_present) = match &local {
        None => (0usize, 0u64, BTreeMap::new(), Vec::new()),
        Some(m) => {
            let mut parts: BTreeMap<String, usize> = BTreeMap::new();
            let mut bytes = 0u64;
            let mut files = 0usize;
            for f in &m.files {
                *parts.entry(f.part.clone()).or_insert(0) += 1;
                files += 1;
                let p = plan::dest_path(&ws.root, m, f, &ws.config.platform);
                if let Ok(md) = std::fs::metadata(&p) {
                    bytes += md.len();
                }
            }
            let tree: Vec<String> = Selection::available_tree_versions(&m.files)
                .into_iter()
                .collect();
            (files, bytes, parts, tree)
        }
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "root": ws.root.display().to_string(),
                "repo": ws.config.repo,
                "branch": ws.config.branch,
                "pinned_commit": ws.state.pinned_commit,
                "applied_commit": ws.state.applied_commit,
                "manifest_version": local.as_ref().map(|m| m.version.clone()),
                "applied_version": ws.state.applied_version,
                "configured_parts": ws.config.parts,
                "configured_tree_versions": ws.config.tree_versions,
                "vendored_files": files,
                "vendored_bytes": bytes,
                "files_by_part": parts_present,
                "vendored_tree_versions": tree_present,
                "last_check": ws.state.last_check,
                "last_update": ws.state.last_update,
            }))?
        );
        return Ok(());
    }

    println!("Vendored root  : {}", ws.root.display());
    println!("Upstream       : {}", ws.config.repo);
    println!("Tracking branch: {}", ws.config.branch);
    match &ws.state.pinned_commit {
        Some(c) => println!("Pinned commit  : {c}"),
        None => println!("Pinned commit  : (none — follows branch head)"),
    }
    println!(
        "Vendored from  : {}",
        ws.state.applied_commit.as_deref().unwrap_or("(never updated)")
    );
    if let (Some(p), Some(a)) = (&ws.state.pinned_commit, &ws.state.applied_commit)
        && p != a
    {
        println!("                 ^ differs from the pin; run `update`");
    }
    println!(
        "Manifest ver.  : {}",
        local.as_ref().map(|m| m.version.as_str()).unwrap_or("(none)")
    );
    println!(
        "Selection      : parts {} | tree {}",
        ws.config.parts.join(","),
        describe_tree(&ws.config.tree_versions)
    );
    println!("Vendored files : {files} ({})", human_bytes(bytes));
    for (part, n) in &parts_present {
        println!("    {part:<8} {n}");
    }
    if !tree_present.is_empty() {
        println!("Tree versions  : {}", tree_present.join(", "));
    }
    println!("Last check     : {}", format_ts(ws.state.last_check));
    println!("Last update    : {}", format_ts(ws.state.last_update));
    Ok(())
}

fn cmd_verify(root: &Path, json: bool) -> Result<()> {
    let ws = Workspace::open(root)?;
    run_recovery(&ws)?;
    let Some(local) = ws.local_manifest()? else {
        bail!("nothing vendored yet at {}", ws.root.display());
    };

    let started = Instant::now();
    let mut ok = 0usize;
    let mut via_crlf = 0usize;
    let mut missing = Vec::new();
    let mut corrupt = Vec::new();

    for f in &local.files {
        let p = plan::dest_path(&ws.root, &local, f, &ws.config.platform);
        match std::fs::read(&p) {
            Err(_) => missing.push(f.name.clone()),
            Ok(bytes) => match hash::verify(&f.sha1, &bytes) {
                hash::HashMatch::Raw => ok += 1,
                hash::HashMatch::LuaCrlf | hash::HashMatch::NormalizedCrlf => {
                    ok += 1;
                    via_crlf += 1;
                }
                hash::HashMatch::Mismatch => corrupt.push(f.name.clone()),
            },
        }
    }
    let secs = started.elapsed().as_secs_f64();

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "checked": local.files.len(), "ok": ok, "matched_via_crlf_fallback": via_crlf,
                "missing": missing, "corrupt": corrupt, "secs": (secs * 100.0).round() / 100.0,
            }))?
        );
    } else {
        println!(
            "Verified {} file(s) in {secs:.2}s: {ok} ok ({via_crlf} matched only after CRLF normalisation), {} missing, {} corrupt",
            local.files.len(),
            missing.len(),
            corrupt.len()
        );
        for n in missing.iter().take(10) {
            println!("  missing  {n}");
        }
        for n in corrupt.iter().take(10) {
            println!("  corrupt  {n}");
        }
    }
    if !missing.is_empty() || !corrupt.is_empty() {
        std::process::exit(2);
    }
    Ok(())
}
