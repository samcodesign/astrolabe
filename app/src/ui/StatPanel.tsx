/**
 * The stat panel.
 *
 * Driven entirely by `stats.get`, which returns rows PoB has already labelled
 * and formatted. Everything this component adds is *legibility*:
 *
 *   - four headline tiles, so the number you came for is not row 27
 *   - curated groups instead of engine order
 *   - tabular figures and right-aligned values, so digits form a column
 *   - a compare column that shows the delta and the percentage, coloured by
 *     whether the change is an improvement rather than by its sign
 */

import { useMemo, useState } from "react";
import type { DisplayStat } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { getCompare } from "../engine/specs";
import { useStore } from "../state/store";
import {
  deltaTone,
  formatDelta,
  formatStatValue,
} from "../format/stat-format";
import {
  filterStats,
  groupStats,
  heroStats,
  type StatRow,
} from "../format/stat-groups";
import { Button, Input, Spinner } from "./primitives";

export function StatPanel({ session }: { session: EngineSession }) {
  const { stats, statsPending, specs } = useStore(session.store, (s) => ({
    stats: s.stats,
    statsPending: s.statsPending,
    specs: s.specs,
  }));
  const [query, setQuery] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [searching, setSearching] = useState(false);

  const compare = getCompare(specs);
  const comparing = compare !== null;

  const filtered = useMemo(() => filterStats(stats, query), [stats, query]);
  const groups = useMemo(
    () => groupStats(filtered, { hideEmpty: !showEmpty }),
    [filtered, showEmpty],
  );
  const heroes = useMemo(() => heroStats(stats), [stats]);

  return (
    <aside className="stats">
      <div className="stats__head">
        <div className="stats__title-row">
          <span className="stats__title">Stats</span>
          {statsPending && <Spinner />}
          <div className="stats__tools">
            {searching ? (
              <Input
                autoFocus
                value={query}
                placeholder="Filter stats…"
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => {
                  if (!query) setSearching(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    setSearching(false);
                  }
                }}
                style={{ height: 30, width: 170, fontSize: 13 }}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSearching(true)}
                title="Filter stats"
              >
                Filter
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEmpty((v) => !v)}
              title="Show stats that are zero everywhere"
              aria-pressed={showEmpty}
              style={showEmpty ? { color: "var(--accent)" } : undefined}
            >
              {showEmpty ? "Hide zeroes" : "Show zeroes"}
            </Button>
          </div>
        </div>

        {heroes.length > 0 && (
          <div className="heroes">
            {heroes.map((h) => (
              <HeroTile key={h.stat.key} caption={h.caption} stat={h.stat} />
            ))}
          </div>
        )}

        {comparing && (
          <div className="stats__compare-note">
            <span className="dot dot--live" />
            <span>
              Comparing against <b>{compare.title}</b>
            </span>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => session.setCompare(null)}>
              Clear
            </Button>
          </div>
        )}
      </div>

      <div className={`stats__scroll ${statsPending ? "stats__scroll--pending" : ""}`}>
        {stats.length === 0 ? (
          <div className="empty">
            No stats yet.
            <br />
            They appear as soon as a build is loaded.
          </div>
        ) : groups.length === 0 ? (
          <div className="empty">Nothing matches “{query}”.</div>
        ) : (
          groups.map((g) => (
            <section className="group" key={g.id}>
              <h3 className="group__title">{g.title}</h3>
              {g.rows.map((row) => (
                <StatRowView key={row.key} row={row} comparing={comparing} />
              ))}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function HeroTile({ caption, stat }: { caption: string; stat: DisplayStat }) {
  const delta = formatDelta(stat);
  const tone = delta ? deltaTone(stat.key, delta.direction) : "flat";
  return (
    <div className="hero">
      <div className="hero__caption">{caption}</div>
      <div className="hero__value selectable" title={String(stat.value ?? "")}>
        {formatStatValue(stat, { compact: true })}
      </div>
      {delta ? (
        <div className={`hero__delta srow__delta--${tone}`}>
          <span>{delta.text}</span>
          {delta.percent && <span className="srow__delta-pct">{delta.percent}</span>}
        </div>
      ) : (
        <div className="hero__label">{stat.label}</div>
      )}
    </div>
  );
}

function StatRowView({ row, comparing }: { row: StatRow; comparing: boolean }) {
  const delta = formatDelta(row);
  const tone = delta ? deltaTone(row.key, delta.direction) : "flat";

  return (
    <div className={`srow ${comparing ? "srow--compare" : ""}`}>
      <span className="srow__label" title={row.key}>
        {row.label}
      </span>
      <span
        className={`srow__value selectable ${row.colour === "gold" ? "srow__value--gold" : ""}`}
      >
        {formatStatValue(row)}
        {row.overCap !== undefined && (
          <span className="srow__overcap" title="Over the maximum">
            (+{row.overCap})
          </span>
        )}
      </span>
      {comparing && (
        <span className={`srow__delta srow__delta--${tone}`}>
          {delta ? (
            <>
              {delta.text}
              {delta.percent && <span className="srow__delta-pct">{delta.percent}</span>}
            </>
          ) : (
            <span className="srow__delta--flat">—</span>
          )}
        </span>
      )}
    </div>
  );
}
