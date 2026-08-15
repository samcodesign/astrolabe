/**
 * The configuration tab.
 *
 * PoB's `ConfigTab` is 1,550 lines and `ConfigOptions` another 2,354, but
 * almost none of that is UI: the options are a declarative list, so this is one
 * generic renderer keyed on the option's `type` rather than a thousand
 * hand-built widgets. Adding an option upstream costs nothing here.
 *
 * Two things are deliberately not decided in this file:
 *
 *   - **Which options apply.** `ConfigState.shown` comes from the engine, where
 *     PoB's own predicates can be answered against live calculator state. A
 *     var missing from it is not relevant to this build right now.
 *   - **What the values mean.** Every value goes back verbatim as the engine
 *     described it; a `list` option's value may be a string, a number or a
 *     boolean depending on the option.
 *
 * Quest choices are pulled to the top because they are the one group a user
 * must set by hand: bandit and pantheon can only be imported over OAuth, so an
 * imported character silently keeps whatever the build already had.
 */

import { useMemo, useState } from "react";
import { CustomMods } from "./CustomMods";
import type { ConfigOption, ConfigSection, ConfigState } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { CompareTip } from "./CompareTip";
import { Banner, Button, ConfirmDialog, Input, PromptDialog, Select } from "./primitives";

/** Bandit and pantheon, the three the official API only gives up over OAuth. */
const QUEST_VARS = ["bandit", "pantheonMajorGod", "pantheonMinorGod"];

export function ConfigPanel({ session }: { session: EngineSession }) {
  const { schema, state, pending } = useStore(session.store, (s) => ({
    schema: s.configSchema,
    state: s.configState,
    pending: s.statsPending,
  }));
  const [query, setQuery] = useState("");
  // Dialogs rather than window.prompt/confirm: native ones render as browser
  // chrome inside a desktop app and cannot be styled.
  const [dialog, setDialog] = useState<
    { kind: "copy" | "blank" | "rename" } | { kind: "delete" } | null
  >(null);

  const visible = useMemo(
    () => (schema && state ? applicable(schema, state, query) : []),
    [schema, state, query],
  );
  const quest = useMemo(
    () => (schema ? questOptions(schema) : []),
    [schema],
  );

  if (!schema || !state) {
    return (
      <div className="config config--empty">
        <p className="config__note">Configuration is not available for this build.</p>
      </div>
    );
  }

  const set = (v: string, value: string | number | boolean) => {
    void session.setConfig({ values: { [v]: value } });
  };
  // Emptying a box means "never set", which is not the same as zero: the
  // engine falls back to the option's placeholder. Without this the hint we
  // now render becomes unreachable the moment you type over it.
  const clear = (v: string) => {
    void session.setConfig({ clear: [v] });
  };

  const total = visible.reduce((n, s) => n + s.options.length, 0);
  const activeTitle =
    state.sets.find((s) => s.id === state.activeSet)?.title ?? "Default";

  return (
    <div className="config" aria-busy={pending}>
      <div className="config__head">
        {/* Sets hold complete, independent copies of every value — "mapping"
            against "bossing" — and are saved with the build. */}
        <label className="config__sets">
          <span className="config__sets-label">Set</span>
          <Select
            value={state.activeSet}
            onChange={(e) => void session.activateConfigSet(Number(e.target.value))}
          >
            {state.sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          title="Add a set that starts as a copy of this one"
          onClick={() => setDialog({ kind: "copy" })}
        >
          + Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Add a set that starts from the defaults"
          onClick={() => setDialog({ kind: "blank" })}
        >
          + Blank
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Rename this set"
          onClick={() => setDialog({ kind: "rename" })}
        >
          Rename
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="btn--danger"
          disabled={state.sets.length <= 1}
          title={
            state.sets.length <= 1
              ? "A build must keep at least one config set"
              : "Delete this set"
          }
          onClick={() => setDialog({ kind: "delete" })}
        >
          ✕
        </Button>

        <Input
          className="config__search"
          value={query}
          placeholder="Search options…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="config__count">
          {total} {total === 1 ? "option" : "options"} apply to this build
        </span>
      </div>

      <div className="config__body">
        {!query && quest.length > 0 && (
          <section className="config__section config__section--quest">
            <h3 className="config__section-name">Quest choices</h3>
            <Banner kind="info">
              Bandit and pantheon are not part of a character import — the official API only
              returns them to a logged-in client. Set them to match your character.
            </Banner>
            <div className="config__options">
              {quest.map((o) => (
                <OptionRow
                  key={o.var}
                  session={session}
                  option={o}
                  state={state}
                  onChange={set}
                  onClear={clear}
                />
              ))}
            </div>
          </section>
        )}

        {visible.map((section) => (
          <section key={section.name} className="config__section">
            <h3 className="config__section-name">{section.name}</h3>
            <div className="config__options">
              {section.options.map((o) => (
                <OptionRow
                  key={o.var}
                  session={session}
                  option={o}
                  state={state}
                  onChange={set}
                  onClear={clear}
                />
              ))}
            </div>
          </section>
        ))}

        {/* Last, as in PoB, and only when not searching — it is not an option
            the search can match. */}
        {!query && <CustomMods session={session} />}

        {total === 0 && (
          <p className="config__note">
            {query ? `Nothing matches “${query}”.` : "No options apply to this build."}
          </p>
        )}
      </div>

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete config set"
          message={`Delete the config set “${activeTitle}”? Every option value in it goes with it.`}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void session.deleteConfigSet(state.activeSet);
          }}
        />
      )}
      {dialog && dialog.kind !== "delete" && (
        <PromptDialog
          title={
            dialog.kind === "rename"
              ? "Rename config set"
              : dialog.kind === "copy"
                ? "Copy config set"
                : "New config set"
          }
          label="Name"
          initial={
            dialog.kind === "rename"
              ? activeTitle
              : dialog.kind === "copy"
                ? `${activeTitle} copy`
                : "New Config Set"
          }
          commitLabel={dialog.kind === "rename" ? "Rename" : "Create"}
          onCancel={() => setDialog(null)}
          onCommit={(title) => {
            const kind = dialog.kind;
            setDialog(null);
            if (kind === "rename") void session.renameConfigSet(state.activeSet, title);
            else if (kind === "copy") void session.newConfigSet({ copyFrom: state.activeSet, title });
            // Blank: no `copyFrom`, so the engine seeds the declared defaults.
            else void session.newConfigSet({ title });
          }}
        />
      )}
    </div>
  );
}

/**
 * The sections worth drawing: options the engine says apply, minus the quest
 * choices already promoted to the top, filtered by the search box.
 *
 * A search deliberately looks through the *whole* catalogue rather than only
 * the applicable options, because "why can't I find X" is usually answered by
 * "X does not apply to your build", and that is only visible if X can be found.
 */
function applicable(
  schema: ConfigSection[],
  state: ConfigState,
  query: string,
): ConfigSection[] {
  const q = query.trim().toLowerCase();
  const out: ConfigSection[] = [];
  for (const section of schema) {
    const options = section.options.filter((o) => {
      if (q) return o.label.toLowerCase().includes(q) || o.var.toLowerCase().includes(q);
      return state.shown[o.var] === true && !QUEST_VARS.includes(o.var);
    });
    if (options.length) out.push({ name: section.name, options });
  }
  return out;
}

function questOptions(schema: ConfigSection[]): ConfigOption[] {
  const byVar = new Map<string, ConfigOption>();
  for (const section of schema) {
    for (const o of section.options) if (QUEST_VARS.includes(o.var)) byVar.set(o.var, o);
  }
  // In PoB's own order (`ConfigOptions.lua:136-154`), not the map's.
  return QUEST_VARS.map((v) => byVar.get(v)).filter((o): o is ConfigOption => o != null);
}

function OptionRow({
  session,
  option,
  state,
  onChange,
  onClear,
}: {
  session: EngineSession;
  option: ConfigOption;
  state: ConfigState;
  onChange: (v: string, value: string | number | boolean) => void;
  onClear: (v: string) => void;
}) {
  const value = state.values[option.var];
  // An option found by search but not applicable is still worth showing — that
  // is the answer to "where is it" — but it should not look active.
  const inactive = state.shown[option.var] !== true;
  // Set, and no longer applicable: still affecting the numbers, and the only
  // way to notice is if we say so (`ConfigTab.lua:718-719`).
  const invalid = state.invalid[option.var] === true;
  const modified = state.modified[option.var] === true;

  // What the calculator uses when this is left alone. The live per-set value
  // wins over the declared one, because PoB recomputes some at runtime.
  const placeholder = state.placeholders[option.var] ?? option.placeholder;

  const hint = invalid
    ? "This option is set but no longer applies to this build — it may still be affecting your numbers."
    : (option.tooltip ?? (inactive ? "Does not apply to this build" : undefined));

  return (
    <label
      className={[
        "config__row",
        inactive && !invalid ? "config__row--inactive" : "",
        invalid ? "config__row--invalid" : "",
        modified && !invalid ? "config__row--modified" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...(hint ? { title: hint } : {})}
    >
      <span className="config__row-label">
        {option.label}
        {invalid && <span className="config__stale" aria-hidden="true"> ⚠</span>}
      </span>
      <OptionInput
        session={session}
        option={option}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onClear={onClear}
      />
    </label>
  );
}

function OptionInput({
  session,
  option,
  value,
  placeholder,
  onChange,
  onClear,
}: {
  session: EngineSession;
  option: ConfigOption;
  value: string | number | boolean | undefined;
  /** What the engine uses when this is unset — a hint, never a value. */
  placeholder: number | string | undefined;
  onChange: (v: string, value: string | number | boolean) => void;
  onClear: (v: string) => void;
}) {
  switch (option.type) {
    case "check":
      return (
        // PoB offers this for checkboxes and dropdowns, and deliberately not
        // for numerics — there the value applies as you type, so a comparison
        // would always be against a half-typed number
        // (`ConfigTab.lua:722-724`). Dropdowns need a hoverable list of their
        // own before the same tip can hang off each entry; a native `<select>`
        // gives no per-option hover.
        <CompareTip
          session={session}
          change={{ kind: "config", var: option.var, value: value !== true }}
          header="Toggling this option will give you:"
        >
          <input
            type="checkbox"
            className="config__check"
            checked={value === true}
            onChange={(e) => onChange(option.var, e.target.checked)}
          />
        </CompareTip>
      );

    case "list": {
      // Values are not all strings, so the option list is indexed by position
      // and the original value is sent back untouched.
      const list = option.list ?? [];
      // A dropdown always has a selection: unset means the declared default,
      // which is what the engine is using.
      const effective = value ?? option.default;
      const at = list.findIndex((o) => o.value === effective);
      return (
        <Select
          value={at < 0 ? "" : String(at)}
          onChange={(e) => {
            const picked = list[Number(e.target.value)];
            if (picked) onChange(option.var, picked.value);
          }}
        >
          {at < 0 && <option value="">—</option>}
          {list.map((o, i) => (
            <option key={`${String(o.value)}-${i}`} value={i}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }

    case "text":
      return (
        <NumberOrText
          kind="text"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder != null ? String(placeholder) : undefined}
          onCommit={(v) => (v === "" ? onClear(option.var) : onChange(option.var, v))}
        />
      );

    default:
      return (
        <NumberOrText
          kind="number"
          // Empty when unset. Never `option.default` — an unset numeric is nil
          // in PoB, not 0, and the calculator uses the placeholder instead
          // (`ConfigTab.lua:1090-1092`). Rendering 0 here claimed the build was
          // computing with 0 when it was computing with 15.
          value={typeof value === "number" ? String(value) : ""}
          placeholder={placeholder != null ? String(placeholder) : undefined}
          min={option.min}
          step={option.step}
          onCommit={(v) => {
            if (v.trim() === "") return onClear(option.var);
            const n = Number(v);
            if (Number.isFinite(n)) onChange(option.var, n);
          }}
        />
      );
  }
}

/**
 * Commits on blur or Enter, never per keystroke.
 *
 * Each commit is a full recalculation. Firing on every character would run one
 * per digit, and typing "250" would briefly compute the build at 2, then 25.
 */
function NumberOrText({
  kind,
  value,
  placeholder,
  min,
  step,
  onCommit,
}: {
  kind: "number" | "text";
  value: string;
  placeholder?: string;
  min?: number;
  step?: "any";
  onCommit: (v: string) => void;
}) {
  return (
    <input
      // Replaced rather than reconciled when the engine reports a different
      // value, so an external change does not fight the cursor mid-edit.
      key={value}
      type={kind}
      className="input config__input"
      defaultValue={value}
      {...(placeholder ? { placeholder } : {})}
      {...(min != null ? { min } : {})}
      {...(step ? { step } : {})}
      onBlur={(e) => {
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
