/**
 * Custom modifiers.
 *
 * Arbitrary mod text applied to the build, in named groups you can toggle
 * individually. It is the one place a user types something the engine has to
 * *understand*, so the whole design question is what happens when it doesn't.
 *
 * PoB's answer is to colour each line blue or red in the box, and only while
 * the box is unfocused (`EditControl.lua:293-301`) — so while you are typing,
 * the thing you most need is hidden. Ours lists the lines it could not use,
 * underneath, with the reason. The engine drops a bad line silently either way;
 * the difference is whether the user finds out.
 */

import { useEffect, useRef, useState } from "react";
import type { CustomModBlock, CustomModLine } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { Button, ConfirmDialog, Input, TextArea } from "./primitives";

export function CustomMods({ session }: { session: EngineSession }) {
  const blocks = useStore(session.store, (s) => s.customMods);
  if (!blocks) return null;

  return (
    <section className="config__section">
      <h3 className="config__section-name">Custom modifiers</h3>
      <p className="custommods__intro">
        Mod text applied to the whole build, exactly as if an item granted it. One line per
        modifier.
      </p>
      <div className="custommods">
        {blocks.map((block) => (
          <ModBlock key={block.index} block={block} session={session} />
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void session.addCustomMod({})}
        >
          + Mod group
        </Button>
      </div>
    </section>
  );
}

const REASON: Record<NonNullable<CustomModLine["reason"]>, string> = {
  unrecognised: "not a modifier the engine recognises",
  partial: "only partly understood, so none of it is applied",
  unsupported: "recognised, but not implemented by the engine",
  unparsed: "could not be read",
};

function ModBlock({
  block,
  session,
}: {
  block: CustomModBlock;
  session: EngineSession;
}) {
  const [text, setText] = useState(block.text);
  const [live, setLive] = useState<CustomModLine[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dirty = text !== block.text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the engine when it changes underneath — switching config set
  // replaces the blocks wholesale — but never while there are unsaved edits.
  useEffect(() => {
    setText(block.text);
    setLive(null);
  }, [block.text]);

  /**
   * Validate as you type, debounced.
   *
   * Committing per keystroke would run a full recalculation per character, and
   * a half-typed modifier is invalid by definition — you would be told you are
   * wrong the entire time you are typing it. Validation is cheap and read-only,
   * so it can run while the commit waits for blur.
   */
  const onType = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void session.validateMods(value).then(setLive);
    }, 400);
  };

  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    if (dirty) void session.setCustomMod({ index: block.index, text });
  };

  // While editing, the live check wins; otherwise the engine's own report on
  // what it actually applied.
  const lines = (dirty ? live : block.lines) ?? block.lines;
  const bad = lines.filter((l) => !l.ok);
  const good = lines.length - bad.length;

  return (
    <div className={`custommod ${block.enabled ? "" : "custommod--off"}`}>
      <header className="custommod__head">
        <input
          type="checkbox"
          checked={block.enabled}
          title="Apply this group"
          onChange={(e) =>
            void session.setCustomMod({ index: block.index, enabled: e.target.checked })
          }
        />
        <Input
          key={block.title}
          className="custommod__title"
          defaultValue={block.title}
          placeholder="Group name"
          onBlur={(e) => {
            if (e.target.value !== block.title) {
              void session.setCustomMod({ index: block.index, title: e.target.value });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <span className="custommod__count">
          {good} applied
          {bad.length > 0 && <span className="custommod__bad"> · {bad.length} not</span>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="btn--danger"
          aria-label={`Delete ${block.title}`}
          onClick={() => (block.text.trim() ? setConfirming(true) : void session.deleteCustomMod(block.index))}
        >
          ✕
        </Button>
      </header>

      <TextArea
        className="custommod__text"
        value={text}
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        placeholder={"+100 to Strength\n10% increased Attack Speed"}
        onChange={(e) => onType(e.target.value)}
        onBlur={commit}
      />

      {dirty && (
        <p className="custommod__dirty">Not applied yet — click away or press Tab to apply.</p>
      )}

      {bad.length > 0 && (
        <ul className="custommod__errors">
          {bad.map((l) => (
            <li key={l.line}>
              <span className="custommod__line">Line {l.line}</span>
              <code>{l.text}</code>
              <span className="custommod__why">
                {l.reason ? REASON[l.reason] : "not applied"}
                {l.leftover ? ` — “${l.leftover}”` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete mod group"
          message={`Delete “${block.title}” and the ${block.lines.length} modifier${block.lines.length === 1 ? "" : "s"} in it?`}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void session.deleteCustomMod(block.index);
          }}
        />
      )}
    </div>
  );
}
