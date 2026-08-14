//! The CRLF fallback, checked against bytes actually served by GitHub.
//!
//! `tests/fixtures/fishing_lf.lua` and `enchantmentflask_lf.lua` are byte-exact
//! recordings of
//! `raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/32d4c87.../src/...`,
//! and the SHA1s asserted below are copied from that commit's `manifest.xml`.
//!
//! The point: the served bytes are LF, the manifest hash is of the CRLF-
//! normalised form, so hashing the download naively *never* matches. Without the
//! fallback every text file in the repo looks permanently out of date.

use pob_updater::hash::{HashMatch, lua_crlf, normalize_crlf, sha1_hex, verify};

const FISHING_LF: &[u8] = include_bytes!("fixtures/fishing_lf.lua");
const FISHING_MANIFEST_SHA1: &str = "438e34d1cbf39fad25111eba0336e659dc981eb8";

const FLASK_LF: &[u8] = include_bytes!("fixtures/enchantmentflask_lf.lua");
const FLASK_MANIFEST_SHA1: &str = "4570f69a726386c86bb8704380dec2be1690c3ca";

#[test]
fn served_bytes_really_are_lf() {
    assert!(
        !FISHING_LF.windows(2).any(|w| w == b"\r\n"),
        "fixture should be the LF form GitHub serves"
    );
}

#[test]
fn raw_hash_of_the_download_does_not_match_the_manifest() {
    assert_ne!(sha1_hex(FISHING_LF), FISHING_MANIFEST_SHA1);
    assert_eq!(sha1_hex(FISHING_LF), "3bc58707b3febfeaf88c6c2fad70f9a0f3a2a67b");
}

#[test]
fn crlf_fallback_matches_real_manifest_entries() {
    assert_eq!(verify(FISHING_MANIFEST_SHA1, FISHING_LF), HashMatch::LuaCrlf);
    assert_eq!(verify(FLASK_MANIFEST_SHA1, FLASK_LF), HashMatch::LuaCrlf);
}

#[test]
fn already_crlf_content_matches_raw() {
    // What a Windows git checkout looks like: the file on disk is already CRLF,
    // so it hashes correctly with no fallback at all.
    let crlf = lua_crlf(FISHING_LF);
    assert_eq!(verify(FISHING_MANIFEST_SHA1, &crlf), HashMatch::Raw);
}

#[test]
fn lua_fallback_is_faithful_including_its_bug() {
    // `content:gsub("\n", "\r\n")` on CRLF input produces `\r\r\n`. Reproducing
    // that exactly is why `NormalizedCrlf` exists as a third attempt.
    assert_eq!(lua_crlf(b"a\r\nb"), b"a\r\r\nb".to_vec());
    assert_eq!(normalize_crlf(b"a\r\nb"), b"a\r\nb".to_vec());
}

#[test]
fn mixed_endings_need_the_normalising_fallback() {
    // A file with mixed endings hashes to its normalised form in the manifest
    // (update_manifest.py always normalises), but the Lua substitution mangles
    // it. Our third attempt rescues the case Lua would call corrupt.
    let mixed = b"line1\r\nline2\nline3\rline4";
    let manifest_sha1 = sha1_hex(&normalize_crlf(mixed));
    assert_eq!(verify(&manifest_sha1, mixed), HashMatch::NormalizedCrlf);
    assert_ne!(sha1_hex(&lua_crlf(mixed)), manifest_sha1);
}

#[test]
fn binary_content_is_never_normalised() {
    // update_manifest.py skips normalisation when the file contains a NUL, so
    // rewriting a PNG's bytes could only produce a false match.
    let png_like = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x01";
    let raw = sha1_hex(png_like);
    assert_eq!(verify(&raw, png_like), HashMatch::Raw);
    assert_eq!(verify(&sha1_hex(&lua_crlf(png_like)), png_like), HashMatch::Mismatch);
}

#[test]
fn genuine_changes_still_fail() {
    let mut tampered = FISHING_LF.to_vec();
    tampered.extend_from_slice(b"\n-- injected\n");
    assert_eq!(verify(FISHING_MANIFEST_SHA1, &tampered), HashMatch::Mismatch);
    assert_eq!(verify(FISHING_MANIFEST_SHA1, b""), HashMatch::Mismatch);
}

#[test]
fn sha1_comparison_is_case_insensitive() {
    assert_eq!(
        verify(&FISHING_MANIFEST_SHA1.to_uppercase(), FISHING_LF),
        HashMatch::LuaCrlf
    );
}
