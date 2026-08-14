import { describe, expect, it } from "vitest";

import {
  describeImportError,
  isImportError,
  normaliseAccountName,
  type ImportError,
} from "./character";

describe("normaliseAccountName", () => {
  it("trims whitespace", () => {
    expect(normaliseAccountName("  Exile#1234  ")).toBe("Exile#1234");
  });

  it("extracts the account from a pasted profile URL", () => {
    expect(
      normaliseAccountName("https://www.pathofexile.com/account/view-profile/Exile-1234"),
    ).toBe("Exile#1234");
  });

  it("decodes percent-escapes in a pasted URL", () => {
    expect(
      normaliseAccountName("https://www.pathofexile.com/account/view-profile/My%20Name-9999"),
    ).toBe("My Name#9999");
  });

  it("leaves a plain name alone", () => {
    expect(normaliseAccountName("Exile")).toBe("Exile");
  });
});

describe("describeImportError", () => {
  const check = (e: ImportError) => describeImportError(e);

  it("explains a private profile and how to fix it", () => {
    const m = check({ kind: "privateProfile", account: "Exile#1234" });
    expect(m.title).toContain("Exile#1234");
    expect(m.title).toContain("private");
    expect(m.hint).toMatch(/privacy|POESESSID/);
    expect(m.retryable).toBe(true);
  });

  it("gives the wait time for a rate limit", () => {
    const m = check({ kind: "rateLimited", retryAfterSecs: 45, policy: "backend:60" });
    expect(m.title).toContain("45 seconds");
    expect(m.retryAfterSecs).toBe(45);
    expect(m.hint).toContain("backend:60");
  });

  it("renders a long rate-limit wait in minutes", () => {
    const m = check({ kind: "rateLimited", retryAfterSecs: 300, policy: null });
    expect(m.title).toContain("5 minutes");
  });

  it("copes with a rate limit that carries no retry hint", () => {
    const m = check({ kind: "rateLimited", retryAfterSecs: null, policy: null });
    expect(m.title).toBe("Rate limited by pathofexile.com.");
    expect(m.retryAfterSecs).toBeUndefined();
  });

  it("mentions the discriminator for a not-found account", () => {
    const m = check({ kind: "notFound", what: "Zealot on Exile" });
    expect(m.title).toContain("Zealot on Exile");
    expect(m.hint).toContain("#1234");
  });

  it("says session cookies expire", () => {
    const m = check({ kind: "unauthorized", detail: "rejected" });
    expect(m.hint).toContain("expire");
  });

  it("marks a 5xx as retryable and a 4xx as not", () => {
    expect(check({ kind: "upstream", status: 503, message: "" }).retryable).toBe(true);
    expect(check({ kind: "upstream", status: 418, message: "nope" }).retryable).toBe(false);
  });

  it("blames the network without jargon", () => {
    const m = check({ kind: "network", message: "dns error" });
    expect(m.title).toBe("Could not reach pathofexile.com.");
    expect(m.hint).toBe("dns error");
  });

  it("suggests a maintenance page for an unparseable body", () => {
    expect(check({ kind: "malformed", message: "x" }).hint).toMatch(/maintenance|Cloudflare/);
  });

  it("falls back for a plain Error", () => {
    const m = describeImportError(new Error("something broke"));
    expect(m.title).toBe("something broke");
    expect(m.retryable).toBe(true);
  });

  it("falls back for a thrown string", () => {
    expect(describeImportError("boom").title).toBe("boom");
  });
});

describe("isImportError", () => {
  it("recognises the tagged union from Rust", () => {
    expect(isImportError({ kind: "privateProfile", account: "x" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isImportError(new Error("x"))).toBe(false);
    expect(isImportError(null)).toBe(false);
    expect(isImportError("kind")).toBe(false);
  });
});
