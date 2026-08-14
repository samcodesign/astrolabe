import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, URL } from "node:url";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Vendored PoB art. `TreeGeometry.sheets` paths are relative to this.
 *
 * PoB's `src`, not `src/TreeData`: the tree sheets are under `TreeData/` but the
 * jewel rings are under `Assets/`, and PoB names both relative to `src`. Must
 * stay in step with `PobRoot::src_dir` in the shell, which serves the same
 * directory in a packaged build.
 */
const POB_SRC = resolvePath("../../PathOfBuilding/src");
/** Recorded engine responses, for working on the UI without the sidecar. */
const FIXTURES = resolvePath("../fixtures");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

/**
 * Serve the tree art at `/treedata` in dev.
 *
 * The renderer asks for every sheet named in `TreeGeometry.sheets`. Without
 * this the dev server answers each one with index.html, every texture fails to
 * decode, and the tree draws as bare geometry — which is not obviously an
 * asset problem when you are looking at it.
 */
function serveTreeData(): Plugin {
  return {
    name: "poe-planner-dev-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const mount = url.startsWith("/treedata/")
          ? ([POB_SRC, "/treedata/"] as const)
          : url.startsWith("/fixtures/")
            ? ([FIXTURES, "/fixtures/"] as const)
            : null;
        if (!mount) return next();
        const [root, prefix] = mount;
        const rel = decodeURIComponent(url.slice(prefix.length).split("?")[0] ?? "");
        const file = normalize(join(root, rel));
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          return next();
        }
        // Art only. The `/treedata` root is PoB's whole `src`, so without this
        // the dev server would hand out the engine's Lua as well — the shell's
        // route refuses the same way, and the two should not diverge.
        if (!(extname(file).toLowerCase() in MIME)) return next();
        res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
        // Fixtures are regenerated from the engine during development; a cached
        // copy means the UI silently keeps showing stale geometry after a regen.
        res.setHeader(
          "Cache-Control",
          extname(file).toLowerCase() === ".json" ? "no-store" : "public, max-age=3600",
        );
        createReadStream(file).pipe(res);
      });
    },
  };
}

// Tauri drives this dev server; it must be a fixed port and must not clear the
// terminal the Rust side is logging to.
export default defineConfig({
  plugins: [react(), serveTreeData()],
  clearScreen: false,
  resolve: {
    alias: {
      "@schema": resolvePath("../schema"),
      // The real renderer, reached through the adapter in src/tree-renderer —
      // the app and the package name the same events differently, and that is
      // the one place the two vocabularies are translated.
      "@poe-planner/tree-renderer": resolvePath("./src/tree-renderer/index.ts"),
      // The adapter reaches the package through this second alias. Vite gets
      // the *source*, so the dev server hot-reloads renderer edits; tsconfig
      // maps the same name to the built `.d.ts`, which keeps the package's own
      // (looser) compiler settings from being re-checked under the app's.
      "@poe-planner/tree-renderer-pkg": resolvePath("../packages/tree-renderer/src/index.ts"),
      "@": resolvePath("./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: { ignored: ["**/src-tauri/**", "**/engine-host/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri 2 on Windows ships WebView2 (Chromium), so we can target modern JS.
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: "default",
  },
});
