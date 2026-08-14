/**
 * The vendored Path of Building data the engine loads.
 *
 * None of this ships in the installer — the checkout is 1.9 GB and goes stale
 * the moment GGG changes the tree — so a fresh install fetches it once and
 * tracks upstream from there. That is also what makes league-day updates arrive
 * on their own: the PoB maintainers do the extraction and we follow their
 * manifest.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../rpc/tauri-transport";

export interface DataStatus {
  /** True when the engine has something to load. */
  ready: boolean;
  root: string | null;
  managedRoot: string | null;
  /** The resolved copy is the one we manage, i.e. ours to update. */
  managed: boolean;
  /**
   * False when a `POB_PATH` or development checkout is in use. Downloading
   * would not touch that copy — it would install ours alongside and silently
   * take over — so the UI must say so rather than offer a bare "Download".
   */
  updatable: boolean;
  version: string | null;
  commit: string | null;
  /** Without the updater binary there is no way to get data at all. */
  updaterAvailable: boolean;
}

/** One line of the updater's progress stream, passed through unchanged. */
export type DataProgress =
  | { event: "resolved"; ref: string; commit: string | null; version: string }
  | { event: "uptodate"; checked: number }
  | { event: "plan"; files: number; deletes: number; bytes: number; extras: number }
  | { event: "staged"; done: number; total: number; bytes: number }
  | { event: "applying"; files: number }
  | { event: "failed"; failures: number; staged: number; detail: string[] }
  | {
      event: "done";
      installed: number;
      deleted: number;
      extras: number;
      bytes: number;
      version: string;
      commit: string | null;
      seconds: number;
    };

/** What an upstream check found, or `null` when there is nothing to check. */
export interface UpdateInfo {
  available: boolean;
  files: number;
  deletes: number;
  /** Download size where GitHub reported it; 0 when unknown. */
  bytes: number;
  localVersion: string | null;
  remoteVersion: string | null;
  /**
   * The tree versions this copy already vendors. An update must pull the same
   * set — installing with today's default would silently drop any older tree
   * the user had added.
   */
  treeVersions: string[];
}

const PROGRESS_EVENT = "pob-data://progress";

/**
 * In a browser there is no shell to ask, and the dev server serves art from the
 * repo checkout — so report ready and let nothing offer to download.
 */
const BROWSER_STATUS: DataStatus = {
  ready: true,
  root: null,
  managedRoot: null,
  managed: false,
  updatable: false,
  version: null,
  commit: null,
  updaterAvailable: false,
};

export async function dataStatus(): Promise<DataStatus> {
  if (!isTauri()) return BROWSER_STATUS;
  return invoke<DataStatus>("data_status");
}

/**
 * The tree versions upstream offers, newest first.
 *
 * Asked rather than hardcoded. A literal like `"3_29"` is correct exactly until
 * the next league ships, and then a fresh install quietly vendors last season's
 * passive tree.
 */
export async function availableTreeVersions(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("data_tree_versions");
}

/**
 * Ask upstream whether the vendored copy is behind.
 *
 * Resolves `null` when there is nothing to check — no managed copy, or no
 * updater binary — which is not the same as "checked and up to date". Callers
 * must not treat a `null` as a reason to show anything.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdateInfo | null>("data_check");
}

/**
 * Fetch the data, reporting progress as it goes.
 *
 * Resolves with the status afterwards; rejects with the updater's own message.
 * An interrupted run is resumable — the updater keeps verified files staged and
 * touches the live copy only at the end — so retrying costs only what is left.
 */
export async function installData(
  treeVersions: string[],
  onProgress: (p: DataProgress) => void,
): Promise<DataStatus> {
  if (!isTauri()) throw new Error("game data can only be downloaded in the desktop app");
  const stop = await listen<DataProgress>(PROGRESS_EVENT, (e) => onProgress(e.payload));
  try {
    return await invoke<DataStatus>("data_install", { treeVersions });
  } finally {
    stop();
  }
}

/** `3_29` as PoB names it, `3.29` as a person reads it. */
export function treeVersionLabel(version: string): string {
  return version.replace(/_/g, ".").replace(/\.(ruthless|alternate)/g, " $1");
}
