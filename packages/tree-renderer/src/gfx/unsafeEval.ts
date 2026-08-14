/**
 * Opt-in polyfill for hosts whose CSP forbids `unsafe-eval`.
 *
 * Pixi's default WebGL path builds its shader-sync and uniform-upload
 * functions with `new Function`, and refuses to start when that is blocked:
 * *"Current environment does not allow unsafe-eval, please use
 * pixi.js/unsafe-eval module to enable support."* The Tauri shell ships
 * `script-src 'self'`, so the app hits this and the demo does not.
 *
 * `pixi.js/unsafe-eval` swaps those generators for interpreted equivalents by
 * patching prototypes on import — a module side effect, so it must land before
 * the first renderer is constructed.
 *
 * It lives here, not in the app, so the patch is applied to the *same* Pixi
 * instance this package renders with. Importing `pixi.js` from the app would
 * resolve a second copy and patch prototypes nothing uses.
 *
 * Not imported at module scope on purpose: the polyfilled paths are slower, and
 * a host without the restriction should keep the generated ones.
 */
let installed: Promise<void> | null = null;

export function installUnsafeEvalPolyfill(): Promise<void> {
  installed ??= import('pixi.js/unsafe-eval').then(() => undefined);
  return installed;
}
