import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';

const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(REPO_ROOT, 'fixtures');
/** Vendored PoB tree art. The sheet paths in geometry.sheets are relative to it. */
const TREE_DATA = resolve(REPO_ROOT, '../PathOfBuilding/src/TreeData');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

/**
 * Serves the real fixtures and the vendored tree art to the demo. Both live
 * outside the package, and neither should be copied into it.
 */
function serveAssets(): Plugin {
  const mount = (prefix: string, root: string) => (url: string) => {
    if (!url.startsWith(prefix)) return null;
    const rel = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  };
  const mounts = [mount('/treedata/', TREE_DATA), mount('/fixtures/', FIXTURES)];

  return {
    name: 'poe-planner-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        for (const m of mounts) {
          const file = m(req.url ?? '');
          if (!file) continue;
          const ext = extname(file).toLowerCase();
          res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
          // Tree art never changes, so cache it hard. Fixtures are regenerated
          // from the engine host during development, and a cached copy means
          // the demo silently keeps showing the old geometry after a regen —
          // which has already cost one debugging detour.
          res.setHeader(
            'Cache-Control',
            ext === '.json' ? 'no-store' : 'public, max-age=3600',
          );
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  build:
    mode === 'demo'
      ? { outDir: 'dist-demo', emptyOutDir: true, target: 'esnext' }
      : {
          lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'PoeTreeRenderer',
            formats: ['es'],
            fileName: () => 'tree-renderer.js',
          },
          rollupOptions: { external: ['pixi.js'] },
          sourcemap: true,
          emptyOutDir: true,
        },
  plugins: mode === 'demo' ? [serveAssets()] : [serveAssets(), dts({ include: ['src'], rollupTypes: false })],
  server: { port: 5273, open: false },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
}));
