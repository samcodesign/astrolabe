/**
 * Live character import.
 *
 * The fetch itself happens in Rust (`src-tauri/src/poe_api.rs`) because the
 * webview cannot reach pathofexile.com and PoB's own network path does not
 * work headless. This module owns the *messages*: private profiles and rate
 * limits are the two failures every user hits, and "request failed" is not an
 * acceptable answer for either.
 */

import { invoke } from "@tauri-apps/api/core";

export type Realm = "pc" | "xbox" | "sony";

export interface CharacterQuery {
  account: string;
  character: string;
  realm?: Realm;
  /** Session cookie for private profiles. Held in memory only, never saved. */
  sessionId?: string;
}

/** Mirrors `ImportError` in `src-tauri/src/poe_api.rs`. */
export type ImportError =
  | { kind: "privateProfile"; account: string }
  | { kind: "unauthorized"; detail: string }
  | { kind: "notFound"; what: string }
  | { kind: "rateLimited"; retryAfterSecs: number | null; policy: string | null }
  | { kind: "network"; message: string }
  | { kind: "upstream"; status: number; message: string }
  | { kind: "malformed"; message: string };

export function isImportError(e: unknown): e is ImportError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

export interface ImportMessage {
  /** One sentence, in the imperative where there is something to do. */
  title: string;
  /** What to try next. Empty when there is nothing useful to say. */
  hint?: string;
  /** Whether a retry button makes sense. */
  retryable: boolean;
  /** Seconds to wait before a retry can succeed, for rate limits. */
  retryAfterSecs?: number;
}

export function describeImportError(e: unknown): ImportMessage {
  if (!isImportError(e)) {
    return {
      title: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }

  switch (e.kind) {
    case "privateProfile":
      return {
        title: `${e.account}'s profile is private.`,
        hint:
          "Make the characters tab public at pathofexile.com/my-account/privacy, " +
          "or paste a POESESSID below to import from your own account.",
        retryable: true,
      };

    case "unauthorized":
      return {
        title: "That session cookie was rejected.",
        hint: "POESESSID values expire. Copy a fresh one from your browser and try again.",
        retryable: true,
      };

    case "notFound":
      return {
        title: `Not found: ${e.what}.`,
        hint:
          "Account names are case sensitive and now include the discriminator, " +
          "for example Exile#1234. Check the realm too.",
        retryable: true,
      };

    case "rateLimited": {
      const secs = e.retryAfterSecs ?? null;
      return {
        title: secs
          ? `Rate limited by pathofexile.com. Try again in ${formatSeconds(secs)}.`
          : "Rate limited by pathofexile.com.",
        hint: e.policy
          ? `The limit that tripped was "${e.policy}". Importing several characters in a row triggers this.`
          : "Importing several characters in a row triggers this. Wait a moment.",
        retryable: true,
        ...(secs !== null ? { retryAfterSecs: secs } : {}),
      };
    }

    case "network":
      return {
        title: "Could not reach pathofexile.com.",
        hint: e.message,
        retryable: true,
      };

    case "upstream":
      return {
        title: `pathofexile.com returned ${e.status}.`,
        hint:
          e.status >= 500
            ? "That is a problem on their side — the site or the API may be down for maintenance."
            : e.message,
        retryable: e.status >= 500,
      };

    case "malformed":
      return {
        title: "The response from pathofexile.com could not be read.",
        hint: "The site may be showing a maintenance or Cloudflare page.",
        retryable: true,
      };
  }
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * The payload handed to `build.load { character }`.
 *
 * NOTE: `schema/rpc.d.ts` types that field as `unknown`, so this shape is a
 * convention agreed with the host rather than something the compiler enforces.
 */
export interface CharacterPayload {
  source: "pathofexile.com";
  account: string;
  character: string;
  /**
   * Narrower than a plain string on purpose: this must stay assignable to the
   * schema's `CharacterPayload`, which the engine's `build.load` takes. Widening
   * it here silently broke that assignability once already.
   */
  realm: Realm;
  /** Raw /character-window/get-items response. */
  items: unknown;
  /** Raw /character-window/get-passive-skills response. */
  passives: unknown;
}

export interface CharacterListEntry {
  name: string;
  level: number;
  class: string;
  league?: string;
  ascendancyClass?: number;
}

/** Normalise what the user typed: strip a pasted profile URL, trim spaces. */
export function normaliseAccountName(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /pathofexile\.com\/account\/view-profile\/([^/?#]+)/i.exec(trimmed);
  if (urlMatch?.[1]) return decodeURIComponent(urlMatch[1]).replace(/-(\d{3,5})$/, "#$1");
  return trimmed;
}

export async function fetchCharacter(q: CharacterQuery): Promise<CharacterPayload> {
  return invoke<CharacterPayload>("fetch_character", {
    query: {
      account: normaliseAccountName(q.account),
      character: q.character.trim(),
      realm: q.realm ?? "pc",
      sessionId: q.sessionId?.trim() || null,
    },
  });
}

export async function fetchCharacterList(
  q: Omit<CharacterQuery, "character">,
): Promise<CharacterListEntry[]> {
  const raw = await invoke<unknown>("fetch_character_list", {
    query: {
      account: normaliseAccountName(q.account),
      character: "",
      realm: q.realm ?? "pc",
      sessionId: q.sessionId?.trim() || null,
    },
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      name: String(c["name"] ?? ""),
      level: Number(c["level"] ?? 0),
      class: String(c["class"] ?? ""),
      league: typeof c["league"] === "string" ? c["league"] : undefined,
      ascendancyClass:
        typeof c["ascendancyClass"] === "number" ? c["ascendancyClass"] : undefined,
    }))
    .filter((c) => c.name);
}

/** A one-line label for the imported build, e.g. "Exile#1234 / Zealot (92)". */
export function characterLabel(p: CharacterPayload, level?: number): string {
  return `${p.account} / ${p.character}${level ? ` (${level})` : ""}`;
}
