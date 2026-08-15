/**
 * Which skill the stats describe.
 *
 * This sits above the stat panel rather than inside a tab, because PoB puts it
 * in the sidebar that every tab shares (`Modules/Build.lua:473-561`) — and for
 * the same reason: the number below it is meaningless without knowing which
 * skill produced it.
 *
 * The engine decides which controls exist. A single-part skill has no part
 * selector at all, not a disabled one, so this renders exactly what
 * `skills.mainSelection` reports and knows nothing about which skills have
 * stages, mines or minions.
 */

import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { Select } from "./primitives";

export function MainSkillBar({ session }: { session: EngineSession }) {
  const { sel, pending } = useStore(session.store, (s) => ({
    sel: s.mainSkill,
    pending: s.statsPending,
  }));

  if (!sel) return null;

  // A build with no gems is a real state — a tree started from nothing — and
  // saying so is more use than an empty dropdown. PoB shows the same sentence
  // (`Build.lua:1558`).
  if (sel.empty) {
    return (
      <div className="mainskill mainskill--empty">
        <span className="mainskill__label">Main skill</span>
        <span className="mainskill__none">No skills in this build yet</span>
      </div>
    );
  }

  const set = (params: Parameters<EngineSession["setMainSkill"]>[0]) => {
    void session.setMainSkill(params);
  };

  return (
    <div className="mainskill" aria-busy={pending}>
      <span className="mainskill__label">Main skill</span>

      <Row label="Socket group">
        <Select
          value={sel.groupIndex}
          disabled={sel.groups.length <= 1}
          onChange={(e) => set({ group: Number(e.target.value) })}
        >
          {sel.groups.map((g) => (
            <option key={g.index} value={g.index}>
              {g.label}
            </option>
          ))}
        </Select>
      </Row>

      {sel.skill && (
        <Row label="Skill">
          <Select
            value={sel.skill.index}
            disabled={!sel.skill.enabled}
            onChange={(e) => set({ skill: Number(e.target.value) })}
          >
            {sel.skill.options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
      )}

      {sel.part && (
        <Row label="Part">
          <Select
            value={sel.part.index}
            onChange={(e) => set({ part: Number(e.target.value) })}
          >
            {sel.part.options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
      )}

      {sel.stageCount != null && (
        <Row label="Stages">
          <Counter value={sel.stageCount} onCommit={(n) => set({ stageCount: n })} />
        </Row>
      )}

      {"mineCount" in sel && (
        <Row label="Active mines">
          <Counter value={sel.mineCount ?? null} onCommit={(n) => set({ mineCount: n })} />
        </Row>
      )}

      {sel.minion && (
        <Row label={sel.minion.kind === "itemSet" ? "Item set" : "Minion"}>
          {sel.minion.options.length === 0 ? (
            <span className="mainskill__none">{sel.minion.note ?? "None available"}</span>
          ) : (
            <Select
              value={String(sel.minion.id ?? "")}
              disabled={!sel.minion.enabled}
              onChange={(e) => {
                // Item sets are numbered, minions are named. The engine told us
                // which this skill uses; echo the right type back or it writes
                // the wrong field.
                const raw = e.target.value;
                set({ minion: sel.minion!.kind === "itemSet" ? Number(raw) : raw });
              }}
            >
              {sel.minion.options.map((o) => (
                <option key={String(o.id)} value={String(o.id)}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Row>
      )}

      {sel.minionSkill && (
        <Row label="Minion skill">
          <Select
            value={sel.minionSkill.index}
            disabled={!sel.minionSkill.enabled}
            onChange={(e) => set({ minionSkill: Number(e.target.value) })}
          >
            {sel.minionSkill.options.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mainskill__row">
      <span className="mainskill__row-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * A number that only reaches the engine when the user has finished typing.
 *
 * Each commit is a full recalculation, so firing on every keystroke would run
 * one per digit — and typing "12" would briefly compute a build with 1 stage.
 * Uncontrolled with a `key`, so a value that changes underneath (switching to a
 * skill with different stages) replaces the box rather than fighting the
 * cursor.
 */
function Counter({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (n: number) => void;
}) {
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) return;
    if (n !== value) onCommit(Math.floor(n));
  };
  return (
    <input
      key={String(value)}
      className="input mainskill__count"
      type="number"
      min={0}
      defaultValue={value ?? ""}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
