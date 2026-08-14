/**
 * Turning a paste-site link into a build code.
 *
 * A geared build's code is tens of thousands of characters, and one that loses
 * a chunk on its way through a chat window or a forum post fails to inflate
 * with nothing useful to say — every character still looks like valid base64.
 * PoB hit this long ago and its own UI says so: *"this code can be very long;
 * you can use 'Share' to shrink it."*
 *
 * So `ImportTab` takes a link as readily as a code and fetches the raw code
 * itself (`Modules/BuildSiteTools.lua`). The fetch has to happen in the shell,
 * not the webview — these hosts send no CORS headers — so this is a thin
 * wrapper over the `fetch_build_code` command.
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../rpc/tauri-transport";

/**
 * Whether the input is a link rather than a build code.
 *
 * Build codes are bare base64url and never contain `:` or `/`, so the test is
 * unambiguous — no need to make the user say which they pasted.
 */
export function looksLikeBuildLink(input: string): boolean {
  const t = input.trim();
  return t.startsWith("https://") || t.startsWith("http://");
}

/** Shape of the Rust `FetchError` enum. */
type FetchError =
  | { kind: "unsupportedSite"; message: string }
  | { kind: "notFound"; site: string }
  | { kind: "network"; message: string }
  | { kind: "empty"; site: string };

function describe(err: unknown): string {
  const e = err as Partial<FetchError> | undefined;
  switch (e?.kind) {
    case "unsupportedSite":
      return e.message ?? "That is not a build link we recognise.";
    case "notFound":
      return `${e.site} has no build at that link. It may have expired.`;
    case "empty":
      return `${e.site} returned an empty build.`;
    case "network":
      return `Could not reach the build site: ${e.message}`;
    default:
      return typeof err === "string" ? err : "Could not fetch that build link.";
  }
}

/** The raw build code behind a supported link. Throws with a readable message. */
export async function fetchBuildCode(link: string): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      "Importing from a link needs the desktop app — a browser cannot reach these sites directly.",
    );
  }
  try {
    return await invoke<string>("fetch_build_code", { link: link.trim() });
  } catch (err) {
    throw new Error(describe(err));
  }
}

/** Site names, for the import screen's hint. Empty when not in the shell. */
export async function buildSiteLabels(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>("build_site_labels");
  } catch {
    return [];
  }
}
