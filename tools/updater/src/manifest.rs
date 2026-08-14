//! Parsing and writing of PoB's `manifest.xml`.
//!
//! Shape (see the real file at the repo root of PathOfBuilding):
//!
//! ```xml
//! <?xml version='1.0' encoding='UTF-8'?>
//! <PoBVersion>
//!   <Version number="2.67.2" />
//!   <Source part="default" url="https://raw.githubusercontent.com/.../{branch}/" />
//!   <Source part="runtime" platform="win32" url=".../{branch}/runtime/" />
//!   <Source part="program" url=".../{branch}/src/" />
//!   <Source part="tree"    url=".../{branch}/src/" />
//!   <File name="changelog.txt" part="default" sha1="cb40..." />
//!   ...
//! </PoBVersion>
//! ```
//!
//! An *installed* manifest additionally carries `platform` and `branch` on
//! `<Version>`; the copy committed to the repo does not, which is why the
//! branch/ref lives in our own config instead.

use anyhow::{Context, Result, bail};
use quick_xml::events::Event;
use std::collections::BTreeMap;

pub const PART_DEFAULT: &str = "default";
pub const PART_RUNTIME: &str = "runtime";
pub const PART_PROGRAM: &str = "program";
pub const PART_TREE: &str = "tree";

pub const KNOWN_PARTS: [&str; 4] = [PART_DEFAULT, PART_RUNTIME, PART_PROGRAM, PART_TREE];

/// The `{branch}` placeholder present in every upstream `<Source url>`.
pub const BRANCH_PLACEHOLDER: &str = "{branch}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub part: String,
    pub platform: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Name exactly as it appears in the manifest; may contain the `{space}`
    /// escape (upstream uses it for `Path{space}of{space}Building.exe`).
    pub name: String,
    pub part: String,
    pub sha1: String,
    /// `platform` attribute; `UpdateCheck.lua` drops entries whose platform
    /// does not match the local one.
    pub platform: Option<String>,
    /// `runtime` attribute, set on `.dll`/`.exe` entries by `update_manifest.py`.
    pub runtime: Option<String>,
}

impl FileEntry {
    /// Filesystem-safe name: `{space}` decoded back to a real space.
    pub fn rel_path(&self) -> String {
        self.name.replace("{space}", " ")
    }

    /// Applies to us if it has no platform constraint or ours matches.
    pub fn applies_to(&self, platform: &str) -> bool {
        match &self.platform {
            None => true,
            Some(p) => p == platform,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    pub platform: Option<String>,
    pub branch: Option<String>,
    pub sources: Vec<Source>,
    pub files: Vec<FileEntry>,
}

impl Manifest {
    pub fn parse(xml: &str) -> Result<Manifest> {
        let mut reader = quick_xml::Reader::from_str(xml);
        reader.config_mut().trim_text(true);

        let mut man = Manifest::default();
        let mut saw_root = false;
        let mut have_version = false;

        loop {
            match reader.read_event() {
                Err(e) => bail!("malformed manifest XML at byte {}: {e}", reader.buffer_position()),
                Ok(Event::Eof) => break,
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    let attrs = read_attrs(&e)?;
                    match name.as_str() {
                        "PoBVersion" => saw_root = true,
                        "Version" => {
                            man.version = attrs
                                .get("number")
                                .cloned()
                                .context("<Version> is missing the `number` attribute")?;
                            man.platform = attrs.get("platform").cloned();
                            man.branch = attrs.get("branch").cloned();
                            have_version = true;
                        }
                        "Source" => man.sources.push(Source {
                            part: attrs
                                .get("part")
                                .cloned()
                                .context("<Source> is missing the `part` attribute")?,
                            platform: attrs.get("platform").cloned(),
                            url: attrs
                                .get("url")
                                .cloned()
                                .context("<Source> is missing the `url` attribute")?,
                        }),
                        "File" => man.files.push(FileEntry {
                            name: attrs
                                .get("name")
                                .cloned()
                                .context("<File> is missing the `name` attribute")?,
                            part: attrs
                                .get("part")
                                .cloned()
                                .context("<File> is missing the `part` attribute")?,
                            sha1: attrs
                                .get("sha1")
                                .map(|s| s.trim().to_ascii_lowercase())
                                .context("<File> is missing the `sha1` attribute")?,
                            platform: attrs.get("platform").cloned(),
                            runtime: attrs.get("runtime").cloned(),
                        }),
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        if !saw_root {
            bail!("not a PoB manifest: no <PoBVersion> root element");
        }
        if !have_version {
            bail!("invalid manifest: no <Version> element");
        }
        if man.sources.is_empty() {
            bail!("invalid manifest: no <Source> elements");
        }
        if man.files.is_empty() {
            bail!("invalid manifest: no <File> elements");
        }
        Ok(man)
    }

    /// Source for a part, preferring an exact platform match and falling back to
    /// the platform-less entry — same precedence as `UpdateCheck.lua`.
    pub fn source_for(&self, part: &str, platform: &str) -> Option<&Source> {
        let mut generic = None;
        for s in &self.sources {
            if s.part != part {
                continue;
            }
            match &s.platform {
                Some(p) if p == platform => return Some(s),
                None => generic = Some(s),
                _ => {}
            }
        }
        generic
    }

    /// Where a part's files live relative to the vendored root.
    ///
    /// Derived from the `<Source url>` rather than hardcoded: everything after
    /// `{branch}/` in the URL is the repo-relative directory, which is also the
    /// layout PoB expects on disk (`default` -> root, `program`/`tree` -> `src`,
    /// `runtime` -> `runtime`).
    pub fn part_subdir(&self, part: &str, platform: &str) -> String {
        if let Some(src) = self.source_for(part, platform)
            && let Some(idx) = src.url.find(BRANCH_PLACEHOLDER)
        {
            let tail = &src.url[idx + BRANCH_PLACEHOLDER.len()..];
            return tail.trim_matches('/').to_string();
        }
        // Fallback for a manifest whose URLs were rewritten to a pinned commit.
        match part {
            PART_RUNTIME => "runtime".into(),
            PART_PROGRAM | PART_TREE => "src".into(),
            _ => String::new(),
        }
    }

    pub fn by_name(&self) -> BTreeMap<&str, &FileEntry> {
        self.files.iter().map(|f| (f.name.as_str(), f)).collect()
    }

    /// Serialise back out in upstream's format: XML declaration with single
    /// quotes, tab indentation, self-closing elements.
    pub fn to_xml(&self) -> String {
        let mut out = String::with_capacity(64 * 1024);
        out.push_str("<?xml version='1.0' encoding='UTF-8'?>\n<PoBVersion>\n");

        out.push_str("\t<Version");
        attr(&mut out, "number", Some(&self.version));
        attr(&mut out, "platform", self.platform.as_deref());
        attr(&mut out, "branch", self.branch.as_deref());
        out.push_str(" />\n");

        for s in &self.sources {
            out.push_str("\t<Source");
            attr(&mut out, "part", Some(&s.part));
            attr(&mut out, "platform", s.platform.as_deref());
            attr(&mut out, "url", Some(&s.url));
            out.push_str(" />\n");
        }
        for f in &self.files {
            out.push_str("\t<File");
            attr(&mut out, "name", Some(&f.name));
            attr(&mut out, "part", Some(&f.part));
            attr(&mut out, "runtime", f.runtime.as_deref());
            attr(&mut out, "sha1", Some(&f.sha1));
            attr(&mut out, "platform", f.platform.as_deref());
            out.push_str(" />\n");
        }
        out.push_str("</PoBVersion>\n");
        out
    }
}

fn attr(out: &mut String, key: &str, value: Option<&str>) {
    if let Some(v) = value {
        out.push(' ');
        out.push_str(key);
        out.push_str("=\"");
        for c in v.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                _ => out.push(c),
            }
        }
        out.push('"');
    }
}

fn read_attrs(e: &quick_xml::events::BytesStart<'_>) -> Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for attr in e.attributes() {
        let attr = attr.context("malformed attribute in manifest")?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let val = attr
            .normalized_value(quick_xml::XmlVersion::Explicit1_0)
            .context("could not unescape attribute value")?
            .into_owned();
        map.insert(key, val);
    }
    Ok(map)
}

/// Percent-encode a repo-relative path for a raw.githubusercontent.com request.
///
/// Deliberately *not* the same as `UpdateCheck.lua`, which calls
/// `curl_easy_escape` on the whole path — that escapes `/` to `%2F` and would
/// 404 for any file in a subdirectory. We encode per segment so separators
/// survive, which is what the upstream code means to do.
pub fn encode_url_path(rel_path: &str) -> String {
    rel_path
        .split('/')
        .map(|seg| {
            let mut s = String::with_capacity(seg.len());
            for b in seg.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        s.push(b as char)
                    }
                    _ => s.push_str(&format!("%{b:02X}")),
                }
            }
            s
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_spaces_but_keeps_separators() {
        assert_eq!(encode_url_path("src/Data/a b.lua"), "src/Data/a%20b.lua");
        assert_eq!(encode_url_path("Path of Building.exe"), "Path%20of%20Building.exe");
    }
}
