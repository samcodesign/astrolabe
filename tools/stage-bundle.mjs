// Build the sidecars and stage everything the installer has to carry.
//
// The app is three programs, not one: the Tauri shell, the `engine-host` that
// runs Path of Building's Lua, and the `pob-updater` that fetches the game
// data. Only the shell is built by `tauri build`, so without this step the
// installer ships an app that cannot start an engine and cannot download the
// data it would load.
//
// `engine-host/lua` comes along for a reason that is easy to miss: the host
// prefers `CARGO_MANIFEST_DIR/lua` and only falls back to `<exe>/lua`. That
// first path is baked in at compile time and resolves on the machine that built
// it — so a locally-built installer finds the source tree and looks fine while
// being broken everywhere else. It has to be shipped beside the binary.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const staging = join(repo, 'src-tauri', 'bundle-resources');

const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

/** Each crate that produces a binary the installer needs. */
const CRATES = [
  { dir: join(repo, 'engine-host'), bin: exe('engine-host') },
  { dir: join(repo, 'tools', 'updater'), bin: exe('pob-updater') },
];

function build(dir) {
  console.log(`building ${dir}`);
  execFileSync('cargo', ['build', '--release'], { cwd: dir, stdio: 'inherit' });
}

function main() {
  const skipBuild = process.argv.includes('--no-build');

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const crate of CRATES) {
    if (!skipBuild) build(crate.dir);
    const src = join(crate.dir, 'target', 'release', crate.bin);
    if (!existsSync(src)) {
      throw new Error(`${crate.bin} was not built: ${src} does not exist`);
    }
    cpSync(src, join(staging, crate.bin));
    console.log(`staged ${crate.bin} (${(statSync(src).size / 1024 / 1024).toFixed(1)} MiB)`);
  }

  // The host's own Lua: rpc dispatch, the api modules, bootstrap.
  const lua = join(repo, 'engine-host', 'lua');
  cpSync(lua, join(staging, 'lua'), { recursive: true });
  console.log('staged lua/');

  // Fail loudly rather than shipping an installer that is quietly incomplete.
  for (const required of ['lua/bootstrap.lua', 'lua/rpc.lua', 'lua/api/tree.lua']) {
    if (!existsSync(join(staging, required))) {
      throw new Error(`staging is incomplete: ${required} is missing`);
    }
  }
  console.log(`\nstaged into ${staging}`);
}

main();
