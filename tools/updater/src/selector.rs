//! Which slice of the manifest we actually vendor.
//!
//! The whole `tree` part is 554 MB across 831 files and 100+ historical tree
//! versions. A planner needs the `program` part (skills, mods, uniques, bases)
//! plus usually one or two tree versions, so every operation is scoped by a
//! [`Selection`] and nothing outside the selection is fetched, deleted, or
//! reported on.

use crate::manifest::{FileEntry, PART_RUNTIME, PART_TREE};
use std::collections::BTreeSet;

/// Tree paths that *look* version-scoped but are shared by every version.
///
/// `tree_version_of` reads any `TreeData/<dir>/` as a version, which is right
/// for `3_29` and wrong for these two. Both are loaded unconditionally during
/// `PassiveTree`'s constructor, so leaving either out of a scoped vendoring
/// kills the engine during init — with an error naming a tree version nobody
/// asked for.
pub fn is_shared_tree_path(name: &str) -> bool {
    // `PassiveTree.lua:211-213`: every tree since 3.19 ships no asset table of
    // its own and falls back to this one file.
    name == "TreeData/3_19/Assets.lua"
        // `PassiveTree.lua:367`: the legion sprite sheets, which back the
        // artwork for any node a timeless jewel replaces.
        || name.starts_with("TreeData/legion/")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub parts: BTreeSet<String>,
    /// `None` means "every tree version"; `Some(set)` restricts to those
    /// `TreeData/<version>/` directories. Ignored unless `tree` is in `parts`.
    pub tree_versions: Option<BTreeSet<String>>,
    pub platform: String,
}

impl Selection {
    pub fn new<I, S>(parts: I, tree_versions: Option<Vec<String>>, platform: &str) -> Selection
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Selection {
            parts: parts.into_iter().map(Into::into).collect(),
            tree_versions: tree_versions.map(|v| v.into_iter().collect()),
            platform: platform.to_string(),
        }
    }

    /// The `TreeData/<version>/` directory a tree file belongs to, if any.
    /// Shared assets live directly in `TreeData/` and have no version.
    pub fn tree_version_of(name: &str) -> Option<&str> {
        let rest = name.strip_prefix("TreeData/")?;
        let (head, tail) = rest.split_once('/')?;
        if tail.is_empty() { None } else { Some(head) }
    }

    pub fn includes(&self, entry: &FileEntry) -> bool {
        if !self.parts.contains(&entry.part) {
            return false;
        }
        if !entry.applies_to(&self.platform) {
            return false;
        }
        // The `runtime` part is the desktop client: its own executable, the
        // MSVC redistributables, d3dcompiler. We embed the engine instead, and
        // need exactly one thing from here — the pure-Lua libraries that
        // `bootstrap.lua` puts on `package.path` (dkjson, base64, sha1).
        //
        // Taking the whole part does not merely waste bandwidth, it fails:
        // `runtime/Path of Building.exe` is a build artefact that exists in no
        // release tag and 404s, which aborts the entire update.
        if entry.part == PART_RUNTIME && !entry.name.starts_with("lua/") {
            return false;
        }
        if entry.part == PART_TREE
            && let Some(wanted) = &self.tree_versions
        {
            // Shared, unversioned TreeData assets always come along — the tree
            // renderer needs them regardless of which version is loaded.
            //
            // So does one versioned file. `PassiveTree.lua:211-213` falls back
            // to `TreeData/3_19/Assets.lua` for the asset table whenever a
            // tree's own data has none, which has been every version since 3.19.
            // Vendor 3_29 alone and the engine dies during init on a 3_19 path,
            // long before anything mentions trees.
            return is_shared_tree_path(&entry.name)
                || match Self::tree_version_of(&entry.name) {
                    Some(v) => wanted.contains(v),
                    None => true,
                };
        }
        true
    }

    /// Every tree version present in a manifest, for `status` / discovery.
    ///
    /// Shared directories are excluded. `TreeData/legion/` looks exactly like a
    /// version to `tree_version_of` — same shape, one path segment down — but it
    /// is the timeless-jewel sprite data every version loads. Left in, it is
    /// offered to the user as a passive tree they could install, and a
    /// lexicographic sort even ranks it the newest one.
    pub fn available_tree_versions(files: &[FileEntry]) -> BTreeSet<String> {
        files
            .iter()
            .filter(|f| f.part == PART_TREE && !is_shared_tree_path(&f.name))
            .filter_map(|f| Self::tree_version_of(&f.name))
            .map(|s| s.to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_entry(name: &str) -> FileEntry {
        FileEntry {
            name: name.to_string(),
            part: PART_RUNTIME.to_string(),
            sha1: "0".repeat(40),
            platform: None,
            runtime: None,
        }
    }

    #[test]
    fn runtime_gives_us_the_lua_libraries_and_nothing_else() {
        let sel = Selection::new(["runtime"], None, "win32");
        assert!(sel.includes(&runtime_entry("lua/dkjson.lua")));
        assert!(sel.includes(&runtime_entry("lua/sha1/init.lua")));
        // The desktop client. `Path of Building.exe` is not in the repository at
        // all, so taking it 404s and aborts the whole update.
        assert!(!sel.includes(&runtime_entry("Path of Building.exe")));
        assert!(!sel.includes(&runtime_entry("d3dcompiler_47.dll")));
        assert!(!sel.includes(&runtime_entry("concrt140.dll")));
    }

    #[test]
    fn the_shared_asset_table_survives_any_tree_selection() {
        let tree = |name: &str| FileEntry {
            name: name.to_string(),
            part: PART_TREE.to_string(),
            sha1: "0".repeat(40),
            platform: None,
            runtime: None,
        };
        let sel = Selection::new(["tree"], Some(vec!["3_29".into()]), "win32");
        assert!(sel.includes(&tree("TreeData/3_29/tree.lua")));
        assert!(sel.includes(&tree("TreeData/SepiaOil.png")));
        assert!(!sel.includes(&tree("TreeData/3_20/tree.lua")));
        // Every version reads its asset table out of this one.
        assert!(sel.includes(&tree("TreeData/3_19/Assets.lua")));
        // ...and only this file from that version, not the whole directory.
        assert!(!sel.includes(&tree("TreeData/3_19/tree.lua")));
        // The legion sheets look version-scoped and are not.
        assert!(sel.includes(&tree("TreeData/legion/tree-legion.lua")));
        assert!(sel.includes(&tree("TreeData/legion/legion-art.png")));
    }

    #[test]
    fn shared_directories_are_not_offered_as_tree_versions() {
        let files = vec![
            FileEntry {
                name: "TreeData/3_29/tree.lua".into(),
                part: PART_TREE.into(),
                sha1: "0".repeat(40),
                platform: None,
                runtime: None,
            },
            FileEntry {
                name: "TreeData/legion/tree-legion.lua".into(),
                part: PART_TREE.into(),
                sha1: "0".repeat(40),
                platform: None,
                runtime: None,
            },
        ];
        let found = Selection::available_tree_versions(&files);
        assert!(found.contains("3_29"));
        // Not a tree anyone can plan on, and it sorts first alphabetically.
        assert!(!found.contains("legion"));
    }

    #[test]
    fn version_extraction() {
        assert_eq!(
            Selection::tree_version_of("TreeData/3_26/tree.lua"),
            Some("3_26")
        );
        assert_eq!(
            Selection::tree_version_of("TreeData/3_26_ruthless/sprites.lua"),
            Some("3_26_ruthless")
        );
        assert_eq!(Selection::tree_version_of("TreeData/SepiaOil.png"), None);
        assert_eq!(Selection::tree_version_of("Data/Skills/act_str.lua"), None);
    }
}
