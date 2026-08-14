# pob-updater

Keeps a local, vendored copy of Path of Building's shipped game data current.

PoB's data (skills, mods, uniques, bases, passive trees) can't be extracted from
the game without a Windows box, a self-built Oodle extractor and a human
reviewing diffs. The PoB Community maintainers do that work every league and
publish the result as a SHA1-indexed file tree on GitHub. This tool consumes that
index the same way PoB's own `src/UpdateCheck.lua` does.

## Why Rust

- The Tauri shell in `src-tauri/` is Rust; the manifest parser, SHA1 diff and
  transaction logic here are a plain library (`src/lib.rs`) that the shell can
  depend on directly to offer in-app "check for data update" without shelling out
  to a second runtime or bundling Node.
- Shipping one static binary matters more than iteration speed for a tool that
  runs a few times per league.
- The hot paths are SHA1 over ~760 MB and 1000+ concurrent HTTPS GETs. A full
  re-verify of the vendored tree takes 1.9 s.

## Upstream mechanics

`manifest.xml` at the repo root is a flat SHA1 index of every shipped file, split
into parts declared in `manifest.cfg`:

| part | repo dir | files | notes |
|---|---|---|---|
| `default` | `/` | 3 | `changelog.txt`, `help.txt`, `LICENSE.md` |
| `runtime` | `runtime/` | 157 | win32 only; not needed for data |
| `program` | `src/` | 400 | the game data — skills, mods, uniques, bases |
| `tree` | `src/` | 830 | `TreeData/`, 548 MiB across 42 tree versions |

Every `<Source url>` points at
`https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/{branch}/...`.
There is no CDN and no release artifact for the data.

### The CRLF trap

`update_manifest.py` hashes files *after* normalising line endings to CRLF, but
only for files without a NUL byte:

```python
if b"\0" not in data:
    data = re.sub(rb"\r\n?|\n", b"\r\n", data)
sha1 = hashlib.sha1(data).hexdigest()
```

raw.githubusercontent.com serves the git blob, which is LF. So a correct,
freshly downloaded file *never* hashes to its manifest entry. `UpdateCheck.lua`
handles this with a second attempt, `sha1(content:gsub("\n", "\r\n"))`, and this
tool reproduces it exactly, plus a third attempt using the generator's proper
`\r\n?|\n` normalisation for mixed-ending files that the naive Lua substitution
would mangle into `\r\r\n` and wrongly call corrupt.

This is not an edge case: **306 of 1233 vendored files** match only via the
fallback. Skip it and the updater re-downloads a quarter of the tree forever.

## Usage

```sh
cargo build --release          # target/release/pob-updater

pob-updater init   --root vendor/pob --parts default,program
pob-updater check  --root vendor/pob
pob-updater update --root vendor/pob
pob-updater pin    --root vendor/pob
pob-updater status --root vendor/pob
pob-updater verify --root vendor/pob        # offline re-hash of the whole tree
```

The root defaults to `$POB_UPDATER_ROOT`, else `./vendor/pob`. It is entirely
self-managed — the tool never touches a PoB git checkout.

### Selective parts and tree versions

The full `tree` part is 548 MiB. It is excluded by default, and a version filter
narrows it further:

```sh
pob-updater check  --root vendor/pob --parts tree              # 830 files, 548.2 MiB
pob-updater check  --root vendor/pob --parts tree --tree 3_26  # 201 files,  37.0 MiB
pob-updater update --root vendor/pob --parts tree --tree 3_26 --save-scope
```

`--tree <version>` keeps `TreeData/<version>/**` plus the 182 shared,
unversioned `TreeData/*` assets that every tree version needs. `--tree all`
overrides a configured filter for one run; `--save-scope` persists the run's
scope as the new default.

Because vendoring is selective, the local `manifest.xml` after an update is
`(remote entries inside the selection) ∪ (existing local entries outside it)`.
Without that merge a `program`-only update would look like it had deleted every
tree file still on disk. Deletes are scoped the same way.

### Pinning

```sh
pob-updater pin                     # pin to the tracked branch's head
pob-updater pin <40-hex-commit>     # pin to a specific commit
pob-updater pin --branch master     # retarget the branch
pob-updater pin --unpin             # float on the branch again
```

`status` reports the pinned commit, the commit the tree was actually fetched
from, and flags a mismatch. Pinning is by commit rather than by
`<Version number>` because `dev` ships data changes without bumping the version.

Every run resolves the ref to a commit SHA *first* and fetches the manifest and
all files at that immutable SHA, so a push landing mid-update can't hand you a
manifest from one tree and files from another.

## Transactional apply

The guarantee: a network failure, a hash mismatch or a hard kill never leaves a
half-updated tree.

**Staging.** Changed files download into
`.pob-updater/txn/<id>/staging/<sha1>.blob` and are SHA1-verified there. All the
risk lives in this phase and the live tree is untouched; aborting is a
`remove_dir_all`. Blobs are content-addressed, so an interrupted run resumes
without re-downloading, and files sharing a SHA1 are fetched once — upstream has
real duplicates, and the full tree installs 609 files from 225 unique blobs.

**Commit.** Local renames only. Each op moves the current file to `backup/`, moves
the staged blob into place, then appends the completed op to an fsynced
`commit.log`. A run that dies mid-commit is rolled back on the next invocation by
replaying that log in reverse. The new `manifest.xml` is deliberately the **last**
op, so even an unrecoverable interruption leaves a manifest describing the old
state rather than one promising files that aren't there.

Recovery runs automatically at the start of every command.

## GitHub citizenship

- Descriptive `User-Agent` naming the tool and its purpose.
- `If-None-Match` on the manifest and the git-tree listing; a no-op `check`
  is two 304s and ~0 bytes of body.
- Semaphore-capped concurrency (default 8, configurable).
- Up to 5 attempts per request with exponential backoff, `Retry-After`
  honoured, plus a shared global retry budget so an outage fails fast. 404s
  never retry.
- Content files are *not* ETag-cached — they're SHA1-verified anyway, and
  caching them would just duplicate the vendored tree on disk.
- Byte sizes come from one recursive `git/trees` API call (~440 KB, cached by
  ETag), not from hundreds of HEAD requests. `--no-api` skips all API calls.

## Layout

```
<root>/
  manifest.xml            vendored manifest — the local side of the diff
  src/ runtime/ ...       vendored payload, mirroring PoB's own layout
  .pob-updater/
    config.toml           repo, branch, selection, concurrency, user-agent
    state.json            pin, applied commit, last check/update
    cache/                ETag-keyed response cache
    txn/<id>/             in-flight transaction (staging, backup, journal)
```

Metadata lives inside the root so staging → live moves stay same-volume renames.

## Tests

`cargo test` — 51 tests, no network. Fixtures under `tests/fixtures/` are
verbatim slices of the real manifest at commit `32d4c87…` (version 2.67.2), plus
byte-exact recordings of two files as raw.githubusercontent.com actually serves
them, asserted against their real manifest SHA1s.

- `manifest_test.rs` — parsing, `{space}` decoding, per-segment URL encoding,
  part→directory derivation, round-tripping, rejection of malformed input.
- `crlf_test.rs` — the fallback against real served bytes, faithful reproduction
  of the Lua substitution's `\r\r\n` behaviour, binary files never normalised,
  genuine changes still failing.
- `diff_test.rs` — scoping by part and tree version, delete scoping, new/changed/
  missing/corrupt reasons, on-disk verification, manifest merging.
- `apply_test.rs` — commit, abort, resume, shared-SHA1 blobs, and rollback from a
  hand-built crashed-mid-commit state.

## Measured (Windows 11, 1 Gbit, cold DNS)

| operation | result |
|---|---|
| `check`, empty vendor dir | 1.02 s — 403 files / 210.7 MiB to fetch |
| `check`, up to date | 0.45 s (manifest 304) |
| `check --verify`, 403 files | 0.88 s (0.37 s re-hashing) |
| `check`, full 1233-file tree | 0.96 s (0.60 s diff) |
| `update`, 403 files / 210.7 MiB | 8.0 s — 5.7 s download, 1.6 s swap |
| `update`, tree 3_26 only, 201 files / 37 MiB | 8.4 s |
| `update`, rest of tree, 609 files | 11.6 s — 174 blobs fetched, 51 resumed |
| `verify`, 1233 files / 759 MiB | 1.9 s |
