/**
 * The selected slot: what is in it, what could be, and what can be changed.
 *
 * Three edits live here, and each has a rule worth stating:
 *
 *   - **Equipping** offers only the legal destinations. `items.slotsFor` asks
 *     PoB, which knows a quiver needs a bow in the other hand and that two
 *     wands pair but a wand and a sceptre do not. Offering everything and
 *     failing on commit would be worse than offering less.
 *   - **Roll sliders** commit a full recalculation each, so they are debounced
 *     while dragging and only rendered for lines the engine marked with a range.
 *   - **Variants** are per axis. A unique can offer up to six independent
 *     choices; one selector would silently drop five of them.
 *
 * Deleting is the loud one. `DeleteItem` reaches past the item pool into every
 * item set and every tree spec's jewel sockets, and deleting a socketed cluster
 * jewel deallocates the nodes that depended on it — a tree edit, from the items
 * tab, which the confirmation has to say out loud.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, ItemMod, ItemSlot } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { CompareTip } from "./CompareTip";
import { ModBrowser } from "./ModBrowser";
import { ItemSummary, ItemTooltip, rarityClass } from "./ItemTooltip";
import { Button, ConfirmDialog, Select } from "./primitives";

export function ItemEditor({
  session,
  slot,
  item,
  pool,
}: {
  session: EngineSession;
  slot: ItemSlot;
  item: Item | null;
  pool: Item[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [crafting, setCrafting] = useState(false);

  // Which of the build's items could go here. Asked of the engine per slot
  // rather than filtered on `type`, because the real rules depend on what is
  // in the *other* hand.
  const [legal, setLegal] = useState<Set<number> | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const results = await Promise.all(
        pool.map(async (candidate) => ({
          id: candidate.id,
          slots: await session.slotsForItem(candidate.id),
        })),
      );
      if (live) {
        setLegal(new Set(results.filter((r) => r.slots.includes(slot.name)).map((r) => r.id)));
      }
    })();
    return () => {
      live = false;
    };
  }, [session, slot.name, pool]);

  const candidates = useMemo(
    () => (legal ? pool.filter((i) => legal.has(i.id)) : []),
    [pool, legal],
  );

  const isCluster = item?.baseName?.includes("Cluster Jewel") ?? false;

  return (
    <div className="iedit">
      <header className="iedit__head">
        <span className="iedit__slot">
          {slot.label}
          {slot.weaponSet === 2 && " (swap)"}
        </span>
        {legal === null && <span className="iedit__checking">checking…</span>}
      </header>

      {/* A list rather than a `<select>`, because a native `<option>` cannot be
          hovered — and hovering a candidate to see what it would do is the
          whole point. Same reason the gem picker is a list. */}
      <ul className="iedit__options" role="listbox" aria-label={`Item in ${slot.label}`}>
        <li>
          <button
            type="button"
            role="option"
            aria-selected={!item}
            className={`iopt ${!item ? "iopt--on" : ""}`}
            onClick={() => void session.equipItem(slot.name, false)}
          >
            <span className="iopt__empty">Empty</span>
          </button>
        </li>
        {candidates.map((c) => (
          <li key={c.id}>
            <CompareTip
              session={session}
              // Already equipped: swapping it for itself changes nothing, and
              // the engine would correctly answer with an empty list. Only a
              // flask is different, and its row in the slot list already
              // carries that question.
              change={c.id === item?.id ? null : { kind: "item", slot: slot.name, item: c.id }}
              header={`Equipping ${c.title ?? c.baseName} would give you:`}
            >
              <button
                type="button"
                role="option"
                aria-selected={c.id === item?.id}
                className={`iopt ${c.id === item?.id ? "iopt--on" : ""}`}
                onClick={() => void session.equipItem(slot.name, c.id)}
              >
                <ItemSummary item={c} />
              </button>
            </CompareTip>
          </li>
        ))}
      </ul>

      {!item ? (
        <p className="items__note">
          Nothing equipped.
          {candidates.length === 0 && legal !== null
            ? " No item in this build fits here."
            : " Choose one above, or paste a new item."}
        </p>
      ) : (
        <>
          <ItemTooltip item={item} />

          {item.variants && (
            <section className="iedit__section">
              <h4 className="iedit__section-name">Variant</h4>
              {item.variants.axes.map((axis, i) => (
                <label key={axis.key} className="iedit__variant">
                  {/* Only worth numbering when there is more than one. */}
                  {item.variants!.axes.length > 1 && (
                    <span className="iedit__variant-n">{i + 1}</span>
                  )}
                  <Select
                    value={axis.selected}
                    onChange={(e) =>
                      void session.setItemVariant({
                        item: item.id,
                        key: axis.key,
                        index: Number(e.target.value),
                      })
                    }
                  >
                    {item.variants!.options.map((o) => (
                      <option key={o.index} value={o.index}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </section>
          )}

          <RollSliders session={session} item={item} />
          <AddedMods session={session} item={item} />

          <footer className="iedit__foot">
            <Button size="sm" onClick={() => setCrafting(true)}>
              Add modifier
            </Button>
            {/* Only for something with sockets to rearrange. Rewrites the
                item's colours and links to match the socket groups assigned to
                this slot; gems past the base's limit are dropped, which is a
                real outcome rather than an error. */}
            {item.sockets && item.sockets.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                title="Recolour and relink this item to fit the socket groups assigned to it"
                onClick={() => void session.optimiseSockets(slot.name)}
              >
                Optimise sockets
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="btn--danger"
              onClick={() => setConfirming(true)}
            >
              Delete item
            </Button>
          </footer>
        </>
      )}

      {crafting && item && (
        <ModBrowser session={session} item={item} onClose={() => setCrafting(false)} />
      )}

      {confirming && item && (
        <ConfirmDialog
          title="Delete item"
          message={
            isCluster
              ? `Delete “${item.title ?? item.baseName}”? It is a cluster jewel, so this also unallocates every passive it granted — your tree will change.`
              : `Delete “${item.title ?? item.baseName}”? It is removed from the build entirely, including from any other item set using it.`
          }
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void session.deleteItem(item.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Mods you added, with a way to take them off again.
 *
 * Only crafted and custom lines: a rolled explicit mod is part of the item and
 * removing it would be editing history rather than the build. PoB draws the
 * same distinction — a crafted line is an explicit line carrying a flag.
 */
function AddedMods({ session, item }: { session: EngineSession; item: Item }) {
  const rows = (item.mods?.explicit ?? []).filter((m) => m.crafted);
  if (rows.length === 0) return null;
  return (
    <section className="iedit__section">
      <h4 className="iedit__section-name">Added</h4>
      {rows.map((mod) => (
        <div key={mod.index} className="addedmod">
          <span className="addedmod__line">{mod.line}</span>
          <Button
            variant="ghost"
            size="sm"
            className="btn--danger"
            aria-label={`Remove ${mod.line}`}
            onClick={() =>
              void session.removeMod({ item: item.id, list: "explicit", index: mod.index })
            }
          >
            ✕
          </Button>
        </div>
      ))}
    </section>
  );
}

/** Every modifier on the item that has a roll to move. */
function RollSliders({ session, item }: { session: EngineSession; item: Item }) {
  const lists = ["implicit", "explicit", "enchant", "crucible"] as const;
  const rows = lists.flatMap((list) =>
    (item.mods?.[list] ?? [])
      .filter((m) => m.range != null)
      .map((mod) => ({ list, mod })),
  );
  if (rows.length === 0) return null;

  return (
    <section className="iedit__section">
      <h4 className="iedit__section-name">Rolls</h4>
      {rows.map(({ list, mod }) => (
        <Roll key={`${list}-${mod.index}`} session={session} item={item} list={list} mod={mod} />
      ))}
    </section>
  );
}

function Roll({
  session,
  item,
  list,
  mod,
}: {
  session: EngineSession;
  item: Item;
  list: "implicit" | "explicit" | "enchant" | "crucible";
  mod: ItemMod;
}) {
  const [value, setValue] = useState(mod.range ?? 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the engine when it changes underneath — switching item set replaces
  // the pool — but not while this slider is the thing doing the changing.
  useEffect(() => setValue(mod.range ?? 0), [mod.range]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Each commit is a full recalculation, so dragging cannot send one per pixel.
  const onDrag = (next: number) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void session.setItemModRange({ item: item.id, list, index: mod.index, range: next });
    }, 120);
  };

  const lo = mod.rangeMin ?? 0;
  const hi = mod.rangeMax ?? 1;
  const rolled = lo + (hi - lo) * value;

  return (
    <label className="roll">
      <span className="roll__line">{mod.line}</span>
      <input
        className="roll__slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onDrag(Number(e.target.value))}
      />
      <span className="roll__value">
        {Number.isInteger(rolled) ? rolled : rolled.toFixed(1)}
      </span>
    </label>
  );
}

export { rarityClass };
