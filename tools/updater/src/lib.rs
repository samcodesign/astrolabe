//! Keeps a local, vendored copy of Path of Building's shipped game data current.
//!
//! PoB's game data cannot be extracted from the game without a Windows box, a
//! self-built Oodle extractor and a human reviewing diffs — but the PoB
//! Community maintainers do that work every league and publish the result as a
//! plain SHA1-indexed file tree on GitHub. This crate consumes that index the
//! same way PoB's own `src/UpdateCheck.lua` does, with the differences a
//! vendoring tool needs: selective parts, pinning, and a transactional apply.

pub mod apply;
pub mod hash;
pub mod manifest;
pub mod net;
pub mod plan;
pub mod selector;
pub mod state;
