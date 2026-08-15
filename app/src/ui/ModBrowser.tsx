/**
 * The crafting bench, and the mod browser, which are the same component.
 *
 * PoB has nine crafting features and they all do one thing: filter a pool of
 * mods by what this item can legally take, and let you pick one. Which pool is
 * a dropdown. So there is one list here, not nine dialogs.
 *
 * The column that earns its keep is **Supported**. A mod that reads perfectly
 * and does nothing is the failure a planner cannot show you any other way —
 * your item says "5% chance to gain a Frenzy Charge when Hit" and the engine
 * has no idea what that means, so it is not in your numbers. PoB drops such
 * lines silently. Stating it is the whole reason to have a browser rather than
 * just a picker.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, ModCandidate } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { Button, Input, Select, TextArea } from "./primitives";

export function ModBrowser({
  session,
  item,
  onClose,
}: {
  session: EngineSession;
  item: Item;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<Array<{ id: string; label: string }>>([]);
  const [source, setSource] = useState<string>("");
  const [search, setSearch] = useState("");
  const [mods, setMods] = useState<ModCandidate[] | null>(null);
  const [custom, setCustom] = useState("");
  const [onlySupported, setOnlySupported] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void session.modSources(item.id).then((list) => {
      setSources(list);
      setSource((current) => current || list[0]?.id || "");
    });
  }, [session, item.id]);

  // Debounced: the engine filters server-side because a source can hold
  // thousands of entries, and a keystroke should not fetch all of them.
  useEffect(() => {
    if (!source || source === "CUSTOM") {
      setMods(source === "CUSTOM" ? [] : null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setMods(null);
    timer.current = setTimeout(() => {
      void session.modPool({ item: item.id, source, search }).then(setMods);
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [session, item.id, source, search]);

  const shown = useMemo(
    () => (onlySupported ? (mods ?? []).filter((m) => m.supported) : (mods ?? [])),
    [mods, onlySupported],
  );
  const unsupported = (mods ?? []).length - (mods ?? []).filter((m) => m.supported).length;

  const add = async (mod: ModCandidate) => {
    await session.addMod({ item: item.id, source, index: mod.index });
    onClose();
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Add a modifier">
      <div className="modal modal--wide modbrowse">
        <header className="modbrowse__head">
          <h2 className="modal__title">
            Add a modifier to {item.title ?? item.baseName}
          </h2>
          <Select
            className="modbrowse__source"
            value={source}
            aria-label="Modifier source"
            onChange={(e) => setSource(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </header>

        {source === "CUSTOM" ? (
          <>
            <p className="modal__body">
              Any modifier text, applied to this item. Anything the engine cannot read is
              ignored rather than rejected, so check it appears in your stats.
            </p>
            <TextArea
              autoFocus
              rows={4}
              className="items__paste"
              spellCheck={false}
              value={custom}
              placeholder="+100 to maximum Energy Shield"
              onChange={(e) => setCustom(e.target.value)}
            />
            <div className="modal__actions">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!custom.trim()}
                onClick={() => {
                  void session
                    .addMod({ item: item.id, source: "CUSTOM", text: custom })
                    .then(onClose);
                }}
              >
                Add
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="modbrowse__tools">
              <Input
                className="modbrowse__search"
                value={search}
                placeholder="Search modifiers…"
                spellCheck={false}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="modbrowse__filter" title="Hide mods the engine cannot use">
                <input
                  type="checkbox"
                  checked={onlySupported}
                  onChange={(e) => setOnlySupported(e.target.checked)}
                />
                Supported only
              </label>
              <span className="modbrowse__count">
                {mods === null ? "…" : `${shown.length} of ${mods.length}`}
                {unsupported > 0 && !onlySupported && (
                  <span className="modbrowse__warn"> · {unsupported} unsupported</span>
                )}
              </span>
            </div>

            <ul className="modbrowse__list" role="listbox">
              {mods === null && <li className="modbrowse__empty">Loading…</li>}
              {mods !== null && shown.length === 0 && (
                <li className="modbrowse__empty">
                  {search ? `Nothing matches “${search}”.` : "No modifiers from this source."}
                </li>
              )}
              {shown.map((mod) => (
                <li key={`${mod.index}-${mod.label}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={`modrow ${mod.supported ? "" : "modrow--unsupported"}`}
                    onClick={() => void add(mod)}
                  >
                    <span className="modrow__lines">
                      {mod.lines.map((line, i) => (
                        <span key={i} className="modrow__line">
                          {line}
                        </span>
                      ))}
                    </span>
                    {mod.affixType && <span className="modrow__affix">{mod.affixType}</span>}
                    <span
                      className="modrow__support"
                      title={
                        mod.supported
                          ? "The engine models this modifier, so it will be in your stats."
                          : "The engine does not model this modifier. It will sit on the item and do nothing."
                      }
                    >
                      {mod.supported ? "Supported" : "Not supported"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="modal__actions">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
