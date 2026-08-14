/**
 * The updater's progress, in the user's terms rather than the tool's.
 *
 * Shared by the first-run download and the in-app update, because they are the
 * same operation seen from two places — the only difference is whether anything
 * was there before.
 */

import type { DataProgress } from "../platform/gamedata";

/**
 * Sized to the number. A first run is ~240 MB, but a repair can be a handful of
 * kilobytes, and rounding those to "0 MiB" tells the user their update is
 * nothing at all.
 */
export function formatBytes(n: number): string {
  if (n <= 0) return "";
  const kib = n / 1024;
  if (kib < 1024) return `${Math.max(1, Math.round(kib))} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/** A label for the current event. */
export function describeProgress(p: DataProgress | null): string {
  if (!p) return "Contacting GitHub…";
  switch (p.event) {
    case "resolved":
      return `Path of Building ${p.version} — reading the file list`;
    case "plan":
      return `Downloading ${p.files} files${p.bytes ? `, ${formatBytes(p.bytes)}` : ""}`;
    case "staged":
      return `Downloading ${p.done} of ${p.total} files`;
    case "applying":
      return "Installing";
    case "uptodate":
      return "Already up to date";
    case "done":
      return "Done";
    case "failed":
      return "Download failed";
  }
}

/**
 * Determinate only. The updater reports per file, so there is always a real
 * fraction — an indeterminate bar here would be pretending.
 */
export function DataProgressView({ progress }: { progress: DataProgress | null }) {
  const staged = progress?.event === "staged" ? progress : null;
  const pct = staged && staged.total > 0 ? (staged.done / staged.total) * 100 : null;

  return (
    <>
      <div className="splash__steps">
        <div className="step step--active">
          <span className="step__mark">
            <span className="spinner" />
          </span>
          <span>{describeProgress(progress)}</span>
          <span className="step__time">{pct !== null ? `${Math.round(pct)}%` : ""}</span>
        </div>
      </div>
      {pct !== null && (
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </>
  );
}
