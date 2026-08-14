//! The live-character import path.
//!
//! This has to live in Rust for two reasons: the webview cannot call
//! pathofexile.com (CORS), and PoB's own network code does not work headless,
//! so the host expects us to hand it already-fetched JSON via
//! `build.load { character }`.
//!
//! Two endpoints make a character:
//!   /character-window/get-items          — gear, jewels, skills
//!   /character-window/get-passive-skills — allocated nodes, jewel sockets, masteries
//!
//! Failure modes users actually hit are modelled explicitly so the UI can say
//! something useful instead of "request failed".

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const BASE: &str = "https://www.pathofexile.com";
/// GGG blocks requests without a descriptive agent and asks for a contact.
const USER_AGENT: &str = concat!(
    "poe-planner/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/poe-planner; passive tree planner)"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterQuery {
    pub account: String,
    pub character: String,
    /// "pc" | "xbox" | "sony". Defaults to pc.
    pub realm: Option<String>,
    /// Session cookie, required for private profiles. Never persisted.
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ImportError {
    /// 403: profile is private, or the tab is hidden.
    PrivateProfile { account: String },
    /// 401 or a rejected cookie.
    Unauthorized { detail: String },
    /// 404, or GGG's in-body error code 1/2.
    NotFound { what: String },
    /// 429. GGG publishes the policy that tripped in the headers.
    RateLimited {
        retry_after_secs: Option<u64>,
        policy: Option<String>,
    },
    /// DNS, TLS, offline, timeout.
    Network { message: String },
    /// Anything else the site returned.
    Upstream { status: u16, message: String },
    /// The body was not the JSON we expect.
    Malformed { message: String },
}

impl ImportError {
    fn network(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return ImportError::Network {
                message: "pathofexile.com did not respond in time".into(),
            };
        }
        if e.is_connect() {
            return ImportError::Network {
                message: "could not reach pathofexile.com — check your connection".into(),
            };
        }
        ImportError::Network {
            message: e.to_string(),
        }
    }
}

fn client() -> Result<reqwest::Client, ImportError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .gzip(true)
        .build()
        .map_err(ImportError::network)
}

async fn get_json(
    client: &reqwest::Client,
    path: &str,
    q: &CharacterQuery,
) -> Result<Value, ImportError> {
    let realm = q.realm.clone().unwrap_or_else(|| "pc".into());
    let mut req = client
        .get(format!("{BASE}{path}"))
        .query(&[
            ("accountName", q.account.as_str()),
            ("character", q.character.as_str()),
            ("realm", realm.as_str()),
        ])
        .header("Accept", "application/json");

    if let Some(sid) = q.session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        req = req.header("Cookie", format!("POESESSID={}", sid.trim()));
    }

    let res = req.send().await.map_err(ImportError::network)?;
    let status = res.status();

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let headers = res.headers().clone();
        let retry_after_secs = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .or_else(|| {
                // X-Rate-Limit-Ip-State: "1:10:60" → hits:period:restriction
                headers
                    .get("x-rate-limit-ip-state")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.split(':').nth(2)?.parse::<u64>().ok())
            });
        let policy = headers
            .get("x-rate-limit-rules")
            .or_else(|| headers.get("x-rate-limit-policy"))
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        return Err(ImportError::RateLimited {
            retry_after_secs,
            policy,
        });
    }

    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(ImportError::PrivateProfile {
            account: q.account.clone(),
        });
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ImportError::Unauthorized {
            detail: "the session cookie was rejected".into(),
        });
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(ImportError::NotFound {
            what: format!("{} on {}", q.character, q.account),
        });
    }

    let body = res.text().await.map_err(ImportError::network)?;

    if !status.is_success() {
        return Err(ImportError::Upstream {
            status: status.as_u16(),
            message: truncate(&body, 300),
        });
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| ImportError::Malformed {
        message: format!("{e}; body started with {:?}", truncate(&body, 80)),
    })?;

    // These endpoints answer 200 with an error object for several real cases.
    if let Some(err) = value.get("error") {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string();
        return Err(match code {
            1 | 2 => ImportError::NotFound { what: message },
            6 => ImportError::PrivateProfile {
                account: q.account.clone(),
            },
            _ => ImportError::Upstream {
                status: 200,
                message,
            },
        });
    }

    Ok(value)
}

/// Fetch a character and return the payload the engine host expects.
///
/// Shape is `{ source, account, character, realm, items, passives }`. The
/// schema types `build.load`'s `character` field as `unknown`, so this shape is
/// a convention shared with Track 1 rather than something the compiler checks.
pub async fn fetch_character(q: CharacterQuery) -> Result<Value, ImportError> {
    if q.account.trim().is_empty() {
        return Err(ImportError::NotFound {
            what: "an account name is required".into(),
        });
    }
    if q.character.trim().is_empty() {
        return Err(ImportError::NotFound {
            what: "a character name is required".into(),
        });
    }

    let client = client()?;
    let items = get_json(&client, "/character-window/get-items", &q).await?;
    // Sequential on purpose: GGG rate-limits per IP and firing both at once is
    // the fastest way to a 429 on the very first import.
    let passives = get_json(&client, "/character-window/get-passive-skills", &q).await?;

    Ok(json!({
        "source": "pathofexile.com",
        "account": q.account,
        "character": q.character,
        "realm": q.realm.unwrap_or_else(|| "pc".into()),
        "items": items,
        "passives": passives,
    }))
}

/// The account's character list, so the import screen can offer a picker.
pub async fn fetch_character_list(q: CharacterQuery) -> Result<Value, ImportError> {
    let client = client()?;
    let realm = q.realm.clone().unwrap_or_else(|| "pc".into());
    let mut req = client
        .get(format!("{BASE}/character-window/get-characters"))
        .query(&[
            ("accountName", q.account.as_str()),
            ("realm", realm.as_str()),
        ])
        .header("Accept", "application/json");
    if let Some(sid) = q.session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        req = req.header("Cookie", format!("POESESSID={}", sid.trim()));
    }

    let res = req.send().await.map_err(ImportError::network)?;
    let status = res.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(ImportError::PrivateProfile {
            account: q.account.clone(),
        });
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(ImportError::RateLimited {
            retry_after_secs: res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok()),
            policy: None,
        });
    }
    let body = res.text().await.map_err(ImportError::network)?;
    if !status.is_success() {
        return Err(ImportError::Upstream {
            status: status.as_u16(),
            message: truncate(&body, 300),
        });
    }
    serde_json::from_str(&body).map_err(|e| ImportError::Malformed {
        message: e.to_string(),
    })
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}
