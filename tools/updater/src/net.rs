//! HTTP client: conditional requests, an on-disk ETag cache, bounded
//! concurrency and bounded retries.
//!
//! Being a good citizen with raw.githubusercontent.com matters here — a full
//! `tree` fetch is 831 requests. So:
//!   * a descriptive `User-Agent` identifying the tool and its purpose;
//!   * `If-None-Match` on the manifest and the git-tree listing, which turns the
//!     common "nothing changed" `check` into two 304s and ~0 bytes of body;
//!   * a semaphore capping in-flight requests (default 8);
//!   * exponential backoff that honours `Retry-After`, and a global retry budget
//!     so a sustained outage fails fast instead of hammering.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};

pub const RAW_BASE: &str = "https://raw.githubusercontent.com";
pub const API_BASE: &str = "https://api.github.com";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EtagStore {
    /// URL -> (etag, cache file name)
    entries: HashMap<String, EtagEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EtagEntry {
    etag: String,
    file: String,
}

pub enum Conditional {
    /// Server returned 304; body is the previously cached response.
    NotModified(Vec<u8>),
    /// Fresh body.
    Modified(Vec<u8>),
}

impl Conditional {
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Conditional::NotModified(b) | Conditional::Modified(b) => b,
        }
    }
    pub fn was_cached(&self) -> bool {
        matches!(self, Conditional::NotModified(_))
    }
}

pub struct Http {
    client: reqwest::Client,
    sem: Arc<Semaphore>,
    cache_dir: PathBuf,
    etags: Mutex<EtagStore>,
    max_attempts: u32,
    /// Shared budget across all files, like `globalRetryLimit` in UpdateCheck.lua.
    retry_budget: AtomicI64,
}

impl Http {
    pub fn new(
        user_agent: &str,
        concurrency: usize,
        max_attempts: u32,
        cache_dir: &Path,
    ) -> Result<Http> {
        let client = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .build()
            .context("could not build HTTP client")?;
        std::fs::create_dir_all(cache_dir).ok();
        let etags = load_etags(cache_dir);
        Ok(Http {
            client,
            sem: Arc::new(Semaphore::new(concurrency.max(1))),
            cache_dir: cache_dir.to_path_buf(),
            etags: Mutex::new(etags),
            max_attempts: max_attempts.max(1),
            retry_budget: AtomicI64::new(20),
        })
    }

    /// Plain GET with retries. Used for content files, which we validate by
    /// SHA1 anyway so caching them would only duplicate the vendored tree.
    pub async fn get(&self, url: &str) -> Result<Vec<u8>> {
        let _permit = self.sem.acquire().await?;
        self.get_inner(url, None, false).await.map(|r| match r {
            Conditional::Modified(b) | Conditional::NotModified(b) => b,
        })
    }

    /// Conditional GET backed by the ETag cache.
    pub async fn get_conditional(&self, url: &str) -> Result<Conditional> {
        let _permit = self.sem.acquire().await?;
        let known = {
            let store = self.etags.lock().await;
            store.entries.get(url).cloned()
        };
        let cached_body = known.as_ref().and_then(|e| {
            let p = self.cache_dir.join(&e.file);
            std::fs::read(p).ok()
        });
        // Only send If-None-Match if we still have the body it refers to.
        let etag = known.as_ref().filter(|_| cached_body.is_some()).map(|e| e.etag.clone());

        match self.get_inner(url, etag.as_deref(), true).await? {
            Conditional::NotModified(_) => {
                let body = cached_body.ok_or_else(|| anyhow!("cache miss after 304 for {url}"))?;
                Ok(Conditional::NotModified(body))
            }
            Conditional::Modified(body) => Ok(Conditional::Modified(body)),
        }
    }

    /// `cacheable` is what the caller opted into, not what the server offered.
    ///
    /// GitHub returns an ETag for every file, so storing a body whenever one is
    /// present quietly kept a second copy of the whole vendored tree — 246 MB
    /// of duplicate bytes beside 245 MB of real ones. It buys nothing for
    /// content files: the manifest's SHA1 diff already decides what to fetch,
    /// so an unchanged file is never requested and its cached body is never
    /// read. Only the metadata requests — the manifest, commit resolution,
    /// blob sizes — are revalidated, and only those are worth keeping.
    async fn get_inner(
        &self,
        url: &str,
        if_none_match: Option<&str>,
        cacheable: bool,
    ) -> Result<Conditional> {
        let mut last_err: Option<anyhow::Error> = None;

        for attempt in 1..=self.max_attempts {
            if attempt > 1 {
                let base = 400u64 << (attempt - 2).min(5);
                tokio::time::sleep(Duration::from_millis(base)).await;
            }

            let mut req = self.client.get(url);
            if let Some(tag) = if_none_match {
                req = req.header(reqwest::header::IF_NONE_MATCH, tag);
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status == reqwest::StatusCode::NOT_MODIFIED {
                        return Ok(Conditional::NotModified(Vec::new()));
                    }
                    if status.is_success() {
                        let etag = resp
                            .headers()
                            .get(reqwest::header::ETAG)
                            .and_then(|v| v.to_str().ok())
                            .map(|s| s.to_string());
                        let body = resp
                            .bytes()
                            .await
                            .with_context(|| format!("could not read response body for {url}"))?
                            .to_vec();
                        if cacheable && let Some(etag) = etag {
                            self.store_etag(url, &etag, &body).await;
                        }
                        return Ok(Conditional::Modified(body));
                    }
                    if status == reqwest::StatusCode::NOT_FOUND {
                        // A 404 will not become a 200 by trying harder.
                        bail!("{url} -> 404 Not Found");
                    }
                    let retryable = status.is_server_error()
                        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                        || status == reqwest::StatusCode::REQUEST_TIMEOUT;
                    let retry_after = resp
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.trim().parse::<u64>().ok());
                    last_err = Some(anyhow!("{url} -> HTTP {status}"));
                    if !retryable || !self.spend_retry() {
                        break;
                    }
                    if let Some(secs) = retry_after {
                        tokio::time::sleep(Duration::from_secs(secs.min(60))).await;
                    }
                }
                Err(e) => {
                    last_err = Some(anyhow!("{url} -> {e}"));
                    if !self.spend_retry() {
                        break;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("request failed: {url}")))
    }

    fn spend_retry(&self) -> bool {
        self.retry_budget.fetch_sub(1, Ordering::Relaxed) > 0
    }

    async fn store_etag(&self, url: &str, etag: &str, body: &[u8]) {
        let file = format!("{}.bin", crate::hash::sha1_hex(url.as_bytes()));
        if std::fs::write(self.cache_dir.join(&file), body).is_err() {
            return;
        }
        let mut store = self.etags.lock().await;
        store.entries.insert(
            url.to_string(),
            EtagEntry {
                etag: etag.to_string(),
                file,
            },
        );
        if let Ok(text) = serde_json::to_string_pretty(&*store) {
            let _ = crate::state::write_atomic(&self.cache_dir.join("etags.json"), text.as_bytes());
        }
    }
}

fn load_etags(cache_dir: &Path) -> EtagStore {
    std::fs::read_to_string(cache_dir.join("etags.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// `https://raw.githubusercontent.com/<repo>/<ref>/<path>`
pub fn raw_url(repo: &str, git_ref: &str, repo_path: &str) -> String {
    format!(
        "{RAW_BASE}/{repo}/{git_ref}/{}",
        crate::manifest::encode_url_path(repo_path)
    )
}

/// Resolve a branch (or any ref) to a commit SHA. One API call; the
/// `vnd.github.sha` media type makes the response the bare 40-char SHA.
pub async fn resolve_commit(http: &Http, repo: &str, git_ref: &str) -> Result<String> {
    if is_commit_sha(git_ref) {
        return Ok(git_ref.to_ascii_lowercase());
    }
    let url = format!("{API_BASE}/repos/{repo}/commits/{git_ref}");
    let _permit = http.sem.acquire().await?;
    let resp = http
        .client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github.sha")
        .send()
        .await
        .with_context(|| format!("could not resolve ref `{git_ref}`"))?;
    if !resp.status().is_success() {
        bail!("could not resolve ref `{git_ref}`: HTTP {}", resp.status());
    }
    let sha = resp.text().await?.trim().to_ascii_lowercase();
    if !is_commit_sha(&sha) {
        bail!("unexpected response resolving `{git_ref}`: {sha:.80}");
    }
    Ok(sha)
}

pub fn is_commit_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Byte sizes for every blob at a commit, via one recursive tree request.
///
/// The manifest carries SHA1s but no sizes, so this is the only way to report
/// "how much will this download" without issuing hundreds of HEAD requests. For
/// this repo the response is ~440 KB / 1673 entries and is not truncated.
pub async fn fetch_blob_sizes(
    http: &Http,
    repo: &str,
    commit: &str,
) -> Result<std::collections::BTreeMap<String, u64>> {
    let url = format!("{API_BASE}/repos/{repo}/git/trees/{commit}?recursive=1");
    let body = http.get_conditional(&url).await?.into_bytes();
    let json: serde_json::Value =
        serde_json::from_slice(&body).context("could not parse git tree response")?;
    let mut map = std::collections::BTreeMap::new();
    if json.get("truncated").and_then(|v| v.as_bool()) == Some(true) {
        // Still useful: partial sizes beat none, and `check` reports the gap.
        eprintln!("warning: git tree listing was truncated; some sizes will be unknown");
    }
    if let Some(items) = json.get("tree").and_then(|v| v.as_array()) {
        for item in items {
            if item.get("type").and_then(|v| v.as_str()) != Some("blob") {
                continue;
            }
            if let (Some(path), Some(size)) = (
                item.get("path").and_then(|v| v.as_str()),
                item.get("size").and_then(|v| v.as_u64()),
            ) {
                map.insert(path.to_string(), size);
            }
        }
    }
    Ok(map)
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}
