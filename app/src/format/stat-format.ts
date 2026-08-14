/**
 * Rendering for `DisplayStat` rows.
 *
 * The host hands back values already labelled and formatted by PoB's
 * `BuildDisplayStats`. `format` is PoB's own `fmt` field, which is a printf
 * conversion *without* the leading `%` — `".1f"`, `"d"`, `".0f%%"` — because
 * PoB prepends the `%` itself when it renders. Feeding that straight to a
 * printf leaves the spec on screen as literal text, so it is normalised at the
 * boundary by {@link pobFormatSpec}.
 *
 * JavaScript has no printf, so we implement the subset PoB actually uses, then
 * layer readability on top: thousands separators, and compact notation for the
 * handful of numbers that run to seven digits.
 */

import type { DisplayStat } from "@schema/rpc";

const CONVERSION = /%([-+ 0#]*)(\d+)?(?:\.(\d+))?([dfgexs%])/;

/**
 * PoB's `fmt` as a printf spec.
 *
 * `BuildDisplayStats` stores the conversion bare (`fmt = ".1f"`,
 * `fmt = "d"`) and writes `"%" .. fmt` at render time. A spec that already
 * carries its `%` is passed through, so a caller holding a full printf string
 * still works.
 */
export function pobFormatSpec(format: string | undefined): string | undefined {
  if (!format) return undefined;
  // Only a spec that *opens* with a bare conversion is missing its `%`.
  // Testing for a leading "%" is not enough: ".0f%%" needs one even though it
  // contains a `%`, and "+%d%%" must not get a second one.
  return BARE_CONVERSION.test(format) ? `%${format}` : format;
}

/** A printf conversion with no `%` in front, i.e. PoB's `fmt` as stored. */
const BARE_CONVERSION = /^[-+ 0#]*\d*(?:\.\d+)?[dfgexs]/;

/** printf subset: flags `-+ 0`, width, precision, conversions d/f/g/e/x/s/%. */
export function printf(spec: string, value: number | string): string {
  let out = "";
  let rest = spec;
  let consumed = false;

  for (;;) {
    const m = CONVERSION.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);

    const [, flags = "", widthStr, precisionStr, conv] = m;
    if (conv === "%") {
      out += "%";
      continue;
    }
    // Only the first conversion gets the value; PoB specs never take two.
    const v = consumed ? "" : value;
    consumed = true;

    const precision = precisionStr === undefined ? undefined : Number(precisionStr);
    let body: string;

    if (conv === "s" || typeof v === "string") {
      body = String(v);
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        body = n > 0 ? "∞" : Number.isNaN(n) ? "NaN" : "-∞";
      } else if (conv === "d") {
        // C truncates toward zero for %d; it does not round. PoB relies on
        // this: `ManaUnreservedPercent` of 2.735 prints as "2%", and rounding
        // it to "3%" is a visible disagreement with the number PoB shows for
        // the same build.
        body = Math.trunc(Math.abs(n)).toString();
        if (n < 0) body = "-" + body;
      } else if (conv === "x") {
        body = Math.trunc(n).toString(16);
      } else if (conv === "f") {
        body = Math.abs(n).toFixed(precision ?? 6);
        if (n < 0 || Object.is(n, -0)) body = "-" + body;
      } else if (conv === "e") {
        body = n.toExponential(precision ?? 6);
      } else {
        // %g: significant digits, trailing zeros dropped.
        const sig = precision ?? 6;
        body = Number(n.toPrecision(sig)).toString();
      }
      if (flags.includes("+") && n >= 0) body = "+" + body;
      else if (flags.includes(" ") && n >= 0) body = " " + body;
    }

    const width = widthStr ? Number(widthStr) : 0;
    if (width > body.length) {
      if (flags.includes("-")) body = body.padEnd(width);
      else if (flags.includes("0") && typeof v === "number") {
        const negative = body.startsWith("-") || body.startsWith("+");
        body = negative
          ? body[0] + body.slice(1).padStart(width - 1, "0")
          : body.padStart(width, "0");
      } else body = body.padStart(width);
    }
    out += body;
  }

  return out;
}

/** Insert thin thousands separators into the integer part of a formatted number. */
export function groupThousands(s: string): string {
  // Four digits, not five. PoB's `formatNumSep` (Common.lua:741) groups every
  // three digits from the right with no minimum — its own example is
  // "1234.56" -> "1,234.5" — so Life 2574 reads "2,574" there. Requiring
  // five printed "7717" against PoB's "7,717" for the same build.
  return s.replace(/(?<![\d.])(-?\d{4,})(?=\D|$)/g, (m) =>
    m.replace(/\B(?=(\d{3})+(?!\d))/g, ","),
  );
}

/** 1_284_310 → "1.28M". Used only where space is tight. */
export function compactNumber(n: number, digits = 2): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${trimZeros((abs / 1e9).toFixed(digits))}B`;
  if (abs >= 1e6) return `${sign}${trimZeros((abs / 1e6).toFixed(digits))}M`;
  if (abs >= 10_000) return `${sign}${trimZeros((abs / 1e3).toFixed(1))}k`;
  if (abs >= 100) return `${sign}${Math.round(abs)}`;
  return `${sign}${trimZeros(abs.toFixed(digits))}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export interface FormatOptions {
  /** Abbreviate anything with six or more digits. Off in the dense list. */
  compact?: boolean;
  /** Separator grouping. On everywhere except compact mode. */
  group?: boolean;
}

/** The value as the panel should show it. `null` becomes an em dash. */
export function formatStatValue(
  stat: Pick<DisplayStat, "value" | "format">,
  opts: FormatOptions = {},
): string {
  const { value, format } = stat;
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "—";

  const { compact = false, group = true } = opts;

  if (compact && Math.abs(value) >= 100_000) {
    const suffix = format?.includes("%%") || format?.trimEnd().endsWith("%") ? "%" : "";
    return compactNumber(value) + suffix;
  }

  const spec = pobFormatSpec(format);
  const rendered = spec ? printf(spec, value) : defaultFormat(value);
  return group ? groupThousands(rendered) : rendered;
}

/** When PoB gives no spec: integers plain, fractions to two decimals. */
function defaultFormat(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return trimZeros(n.toFixed(2));
}

export interface FormattedDelta {
  /** "+1,204" — signed, formatted with the stat's own spec. */
  text: string;
  /** "+3.2%" relative to the baseline, or null when it is not meaningful. */
  percent: string | null;
  direction: "up" | "down" | "flat";
}

/**
 * A delta for the compare column.
 *
 * `delta` is defined by the schema as *value minus the baseline*, so a positive
 * number always means "this variant has more". Whether more is better is a
 * separate question — see `isLowerBetter`.
 */
export function formatDelta(
  stat: Pick<DisplayStat, "value" | "format" | "delta" | "key">,
  opts: { epsilon?: number } = {},
): FormattedDelta | null {
  const { delta } = stat;
  if (delta === undefined || delta === null || !Number.isFinite(delta)) return null;

  const epsilon = opts.epsilon ?? 0.005;
  if (Math.abs(delta) < epsilon) {
    return { text: "—", percent: null, direction: "flat" };
  }

  const spec = signedSpec(stat.format);
  const text = groupThousands(printf(spec, delta));

  let percent: string | null = null;
  if (typeof stat.value === "number" && Number.isFinite(stat.value)) {
    const baseline = stat.value - delta;
    if (Math.abs(baseline) > epsilon) {
      const pct = (delta / Math.abs(baseline)) * 100;
      if (Math.abs(pct) >= 0.05 && Math.abs(pct) < 100_000) {
        percent = `${pct > 0 ? "+" : ""}${trimZeros(pct.toFixed(1))}%`;
      }
    }
  }

  return { text, percent, direction: delta > 0 ? "up" : "down" };
}

/** Force a `+` flag into a printf spec so deltas always carry their sign. */
export function signedSpec(format: string | undefined): string {
  const spec = pobFormatSpec(format);
  if (!spec) return "%+.2f";
  // Already signed, e.g. "+%d%%" or "%+d".
  if (/^\+/.test(spec) || /%[-0 #]*\+/.test(spec)) return spec;
  return spec.replace(CONVERSION, (whole, flags: string, ...rest) => {
    const [width, precision, conv] = rest as [string?, string?, string?];
    if (conv === "%") return whole;
    return `%${flags}+${width ?? ""}${precision ? "." + precision : ""}${conv}`;
  });
}

/**
 * Stats where a *smaller* number is the improvement. Everything else is
 * "higher is better", which is the overwhelming majority.
 */
const LOWER_IS_BETTER = new Set([
  "ManaCost",
  "LifeCost",
  "ESCost",
  "RageCost",
  "SoulCost",
  "SkillMana",
  "ReservedLife",
  "ReservedMana",
  "CostPerSecond",
]);

export function isLowerBetter(key: string): boolean {
  return LOWER_IS_BETTER.has(key);
}

/** "up"/"down" mapped to good/bad for colouring. */
export function deltaTone(
  key: string,
  direction: FormattedDelta["direction"],
): "good" | "bad" | "flat" {
  if (direction === "flat") return "flat";
  const better = isLowerBetter(key) ? "down" : "up";
  return direction === better ? "good" : "bad";
}
