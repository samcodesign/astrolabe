/**
 * A ~40-line store, in place of a state library.
 *
 * The app has exactly one store and one writer (the engine session), so
 * anything bigger would be ceremony. `useSyncExternalStore` gives correct
 * tearing behaviour under React 19 concurrent rendering for free.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

export interface Store<T> {
  getState(): T;
  setState(update: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(update) {
      const patch = typeof update === "function" ? update(state) : update;
      let changed = false;
      for (const k of Object.keys(patch) as Array<keyof T>) {
        if (!Object.is(state[k], patch[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Shallow equality over objects and arrays; `Object.is` for anything else. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe a component to a slice.
 *
 * The selected value is memoised behind a shallow comparison. Without that,
 * the common `(s) => ({ a: s.a, b: s.b })` selector returns a fresh object on
 * every call, `useSyncExternalStore` sees the snapshot change on every render,
 * and React loops until it throws "Maximum update depth exceeded".
 */
export function useStore<T extends object, S>(
  store: Store<T>,
  select: (state: T) => S,
): S {
  const selectRef = useRef(select);
  selectRef.current = select;
  const cache = useRef<{ value: S } | null>(null);

  const getSnapshot = useCallback(() => {
    const next = selectRef.current(store.getState());
    const last = cache.current;
    if (last && shallowEqual(last.value, next)) return last.value;
    cache.current = { value: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
