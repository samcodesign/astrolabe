//! SHA1 verification with the line-ending fallbacks PoB relies on.
//!
//! Why this is subtle: `update_manifest.py` (upstream, repo root) hashes files
//! *after* normalising every line ending to CRLF, but only for files that look
//! like text (no NUL byte):
//!
//! ```python
//! if b"\0" not in data:
//!     data = re.sub(rb"\r\n?|\n", b"\r\n", data)
//! sha1 = hashlib.sha1(data).hexdigest()
//! ```
//!
//! The bytes actually served by raw.githubusercontent.com are whatever git has
//! stored, which for this repo is LF. So a freshly downloaded, perfectly valid
//! file hashes to something *different* from its manifest entry. `UpdateCheck.lua`
//! papers over this with a second attempt:
//!
//! ```lua
//! if data.sha1 ~= sha1(content) and data.sha1 ~= sha1(content:gsub("\n", "\r\n")) then
//! ```
//!
//! Note that the Lua fallback is a naive `\n -> \r\n` replacement: run it on
//! content that already has CRLF and you get `\r\r\n`. We reproduce that exactly
//! (`LuaCrlf`), and additionally try the *proper* normalisation the generator
//! used (`NormalizedCrlf`) which catches mixed-ending files that Lua would
//! wrongly flag as corrupt.

use sha1::{Digest, Sha1};

/// Which hashing strategy produced a match, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashMatch {
    /// Raw bytes hashed to the expected value.
    Raw,
    /// Matched after the naive `\n` -> `\r\n` substitution `UpdateCheck.lua` uses.
    LuaCrlf,
    /// Matched after full `\r\n|\r|\n` -> `\r\n` normalisation (what
    /// `update_manifest.py` does when generating the manifest).
    NormalizedCrlf,
    /// No strategy matched: the file genuinely differs.
    Mismatch,
}

impl HashMatch {
    pub fn is_match(self) -> bool {
        !matches!(self, HashMatch::Mismatch)
    }
}

pub fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Exactly `content:gsub("\n", "\r\n")` from Lua: every LF becomes CRLF,
/// including the LF of an existing CRLF (yielding `\r\r\n`).
pub fn lua_crlf(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 32);
    for &b in data {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}

/// Full normalisation matching `re.sub(rb"\r\n?|\n", b"\r\n", data)`:
/// CRLF, lone CR and lone LF all collapse to a single CRLF.
pub fn normalize_crlf(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 32);
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            b'\r' => {
                out.extend_from_slice(b"\r\n");
                // `\r\n?` consumes an optional following LF.
                i += if data.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
            }
            b'\n' => {
                out.extend_from_slice(b"\r\n");
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// Treated as binary by the manifest generator, which skips normalisation.
pub fn looks_binary(data: &[u8]) -> bool {
    data.contains(&0u8)
}

/// Check `data` against a manifest SHA1, trying each fallback in turn.
pub fn verify(expected_sha1: &str, data: &[u8]) -> HashMatch {
    let expected = expected_sha1.trim().to_ascii_lowercase();
    if sha1_hex(data) == expected {
        return HashMatch::Raw;
    }
    // The generator only rewrote line endings for non-binary files, so there is
    // nothing to gain (and cycles to burn) normalising a 7 MB PNG.
    if looks_binary(data) {
        return HashMatch::Mismatch;
    }
    if sha1_hex(&lua_crlf(data)) == expected {
        return HashMatch::LuaCrlf;
    }
    if sha1_hex(&normalize_crlf(data)) == expected {
        return HashMatch::NormalizedCrlf;
    }
    HashMatch::Mismatch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lua_crlf_doubles_existing_cr() {
        assert_eq!(lua_crlf(b"a\r\nb"), b"a\r\r\nb".to_vec());
        assert_eq!(lua_crlf(b"a\nb"), b"a\r\nb".to_vec());
    }

    #[test]
    fn normalize_is_idempotent() {
        let once = normalize_crlf(b"a\r\nb\rc\nd");
        assert_eq!(once, b"a\r\nb\r\nc\r\nd".to_vec());
        assert_eq!(normalize_crlf(&once), once);
    }
}
