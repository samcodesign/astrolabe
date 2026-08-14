//! Importing a build from a paste-site link.
//!
//! A build code is base64 over a deflated XML document, and for a geared
//! character it runs to tens of thousands of characters. PoB's own UI says so:
//! *"this code can be very long; you can use 'Share' to shrink it."* Moving one
//! by hand through a chat window or a forum post is how codes arrive truncated,
//! and a truncated code fails to inflate with no useful diagnosis.
//!
//! So PoB accepts a *link* as well, fetches the raw code itself, and imports
//! that. This is a port of `Modules/BuildSiteTools.lua`'s `websiteList` and
//! `DownloadBuild`: match the URL, rewrite it to the site's raw endpoint, GET
//! it, and hand the body to the ordinary code importer.
//!
//! It lives in Rust for the same reason `poe_api` does — the webview cannot
//! make these requests (CORS), and they want a real User-Agent.

use std::time::Duration;

use serde::Serialize;

/// Deliberately **not** a general fetcher.
///
/// This runs with the shell's privileges and is reachable from the webview, so
/// letting it GET an arbitrary URL would turn the app into an open proxy —
/// including to `file://` and to hosts on the user's private network. Only the
/// sites PoB itself supports are accepted, and the URL is rebuilt from the
/// captured id rather than passed through.
struct Site {
    /// PoB's `label`, shown to the user.
    label: &'static str,
    /// Host, matched exactly against the URL's host (minus a `www.` prefix).
    host: &'static str,
    /// Path prefix the build id follows, e.g. `/poe/pob/`. Empty means the id
    /// is the whole path.
    prefix: &'static str,
    /// `{}` is replaced by the captured id.
    raw_url: &'static str,
}

/// Ported from `BuildSiteTools.lua:19-40`.
const SITES: &[Site] = &[
    Site {
        label: "Maxroll",
        host: "maxroll.gg",
        prefix: "/poe/pob/",
        raw_url: "https://maxroll.gg/poe/api/pob/{}",
    },
    Site {
        label: "pob.codes",
        host: "pob.codes",
        prefix: "/b/",
        raw_url: "https://api.pob.codes/{}/raw",
    },
    Site {
        label: "pobb.in",
        host: "pobb.in",
        prefix: "/",
        raw_url: "https://pobb.in/pob/{}",
    },
    Site {
        label: "poe.ninja",
        host: "poe.ninja",
        prefix: "/poe1/pob/",
        raw_url: "https://poe.ninja/poe1/pob/raw/{}",
    },
    Site {
        label: "poe.ninja",
        host: "poe.ninja",
        prefix: "/pob/",
        raw_url: "https://poe.ninja/poe1/pob/raw/{}",
    },
    Site {
        label: "Pastebin",
        host: "pastebin.com",
        prefix: "/",
        raw_url: "https://pastebin.com/raw/{}",
    },
    Site {
        label: "PastebinP",
        host: "pastebinp.com",
        prefix: "/",
        raw_url: "https://pastebinp.com/raw/{}",
    },
    Site {
        label: "Rentry",
        host: "rentry.co",
        prefix: "/",
        raw_url: "https://rentry.co/paste/{}/raw",
    },
    Site {
        label: "poedb.tw",
        host: "poedb.tw",
        prefix: "/pob/",
        raw_url: "https://poedb.tw/pob/{}/raw",
    },
];

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FetchError {
    /// Not a link to a site we know. The caller should treat the input as a
    /// raw code instead of guessing.
    UnsupportedSite { message: String },
    NotFound { site: String },
    Network { message: String },
    Empty { site: String },
}

const USER_AGENT: &str = concat!(
    "poe-planner/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/poe-planner; passive tree planner)"
);

/// A build id is a short slug. Anything else is a mis-parse, and letting it
/// through would put user-controlled text into the outbound URL.
fn is_plausible_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The raw-code endpoint for a link, or `None` when it is not a known site.
fn raw_url_for(link: &str) -> Option<(&'static Site, String)> {
    let trimmed = link.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    // Drop a query string or fragment before reading the id.
    let path = path.split(['?', '#']).next().unwrap_or(path);

    for site in SITES {
        if site.host != host {
            continue;
        }
        let Some(id) = path.strip_prefix(site.prefix) else {
            continue;
        };
        let id = id.trim_end_matches('/');
        if !is_plausible_id(id) {
            continue;
        }
        return Some((site, site.raw_url.replace("{}", id)));
    }
    None
}

/// True when the input looks like a link rather than a build code, so the UI
/// can route it without asking the user which it is.
pub fn looks_like_url(input: &str) -> bool {
    let t = input.trim();
    t.starts_with("https://") || t.starts_with("http://")
}

/// Fetch the raw build code behind a supported link.
pub async fn fetch_build_code(link: String) -> Result<String, FetchError> {
    let Some((site, url)) = raw_url_for(&link) else {
        return Err(FetchError::UnsupportedSite {
            message: format!(
                "not a build link we recognise. Supported: {}.",
                supported_labels().join(", ")
            ),
        });
    };

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| FetchError::Network { message: e.to_string() })?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| FetchError::Network { message: e.to_string() })?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(FetchError::NotFound { site: site.label.to_string() });
    }
    if !res.status().is_success() {
        return Err(FetchError::Network {
            message: format!("{} answered {}", site.label, res.status()),
        });
    }

    let body = res
        .text()
        .await
        .map_err(|e| FetchError::Network { message: e.to_string() })?;
    let code = body.trim().to_string();
    if code.is_empty() {
        return Err(FetchError::Empty { site: site.label.to_string() });
    }
    Ok(code)
}

/// Site labels, for error messages and the import screen's hint.
pub fn supported_labels() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for s in SITES {
        if !out.contains(&s.label) {
            out.push(s.label);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_known_links_to_their_raw_endpoint() {
        let cases = [
            ("https://pobb.in/abc123", "https://pobb.in/pob/abc123"),
            ("https://www.pobb.in/abc123", "https://pobb.in/pob/abc123"),
            ("https://pob.codes/b/xyz", "https://api.pob.codes/xyz/raw"),
            ("https://maxroll.gg/poe/pob/qq11", "https://maxroll.gg/poe/api/pob/qq11"),
            ("https://poe.ninja/poe1/pob/9wz", "https://poe.ninja/poe1/pob/raw/9wz"),
            ("https://pastebin.com/AbCd1234", "https://pastebin.com/raw/AbCd1234"),
            ("https://rentry.co/somebuild", "https://rentry.co/paste/somebuild/raw"),
            // Query strings and trailing slashes are noise, not part of the id.
            ("https://pobb.in/abc123/", "https://pobb.in/pob/abc123"),
            ("https://pobb.in/abc123?utm=x", "https://pobb.in/pob/abc123"),
        ];
        for (link, expected) in cases {
            let got = raw_url_for(link).map(|(_, u)| u);
            assert_eq!(got.as_deref(), Some(expected), "for {link}");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_a_known_build_site() {
        // This runs with the shell's privileges, so it must not be usable as a
        // general fetcher — an arbitrary host, a private address, or a
        // non-http scheme all have to fall through to "unsupported".
        for link in [
            "https://example.com/abc",
            "http://127.0.0.1:8080/secret",
            "http://192.168.1.1/admin",
            "file:///C:/Windows/win.ini",
            "ftp://pobb.in/abc",
            "https://pobb.in.evil.com/abc",
            "https://evilpobb.in/abc",
            // Path traversal in the id must not survive the slug check.
            "https://pobb.in/../../etc/passwd",
        ] {
            assert!(raw_url_for(link).is_none(), "{link} must not be fetched");
        }
    }

    #[test]
    fn tells_a_link_from_a_code() {
        assert!(looks_like_url("https://pobb.in/abc"));
        assert!(looks_like_url("  http://pastebin.com/x  "));
        // A build code is bare base64url and must not be mistaken for a link.
        assert!(!looks_like_url("eNrtPWtzm8iyn1e_gnLVuV"));
        assert!(!looks_like_url(""));
    }
}
