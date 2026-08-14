/**
 * `pixi.js/unsafe-eval` ships `init.d.ts`, but its export map points at
 * `init.mjs` and this package resolves modules the classic way, so TypeScript
 * does not find the types through the subpath. The module is imported purely
 * for its side effect — it patches Pixi's prototypes — so an empty declaration
 * is the whole contract.
 */
declare module 'pixi.js/unsafe-eval';
