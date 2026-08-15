/**
 * Gear.
 *
 * PoB shows one slot at a time behind a dropdown (`ItemsTab.lua:136-180`). This
 * shows every equipment slot at once with an editor beside the selected one,
 * because "what am I wearing" is most of what the tab is for and it should not
 * cost eleven clicks.
 *
 * Two things the engine's slot list forces on the layout:
 *
 *   - **Jewel sockets are slots too**, one per allocated socket node, and a
 *     real build has dozens — 57 on the sample character. They cannot sit in
 *     the same flat list as the eleven equipment slots, so they get their own
 *     collapsible section.
 *   - **`shown` is not decoration.** Abyssal sockets appear and disappear with
 *     the item that grants them (`ItemSlotControl.lua:98-110`), and a hidden
 *     slot must not render as an empty row.
 *
 * `label` is not unique — "Weapon 1" and "Weapon 1 Swap" share it — so `name`
 * is the key and `weaponSet` is what tells the pair apart.
 */

import { useMemo, useState } from "react";
import type { Item, ItemSlot } from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { CompareTip } from "./CompareTip";
import { ItemEditor } from "./ItemEditor";
import { ItemSummary, rarityClass } from "./ItemTooltip";
import { Button, ConfirmDialog, PromptDialog, Select, TextArea } from "./primitives";

export function ItemsPanel({ session }: { session: EngineSession }) {
  const { items, pending } = useStore(session.store, (s) => ({
    items: s.items,
    pending: s.statsPending,
  }));
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "copy" | "blank" | "rename" } | { kind: "delete-set" } | null
  >(null);
  const [pasting, setPasting] = useState(false);

  const byId = useMemo(
    () => new Map((items?.items ?? []).map((i) => [i.id, i])),
    [items],
  );

  if (!items) {
    return (
      <div className="items items--empty">
        <p className="items__note">Gear is not available for this build.</p>
      </div>
    );
  }

  // Equipment and jewel sockets are different kinds of thing and are listed
  // separately. Hidden slots are dropped entirely rather than greyed: an
  // abyssal socket with no parent item is not a slot you can fill.
  const visible = items.slots.filter((s) => s.shown);
  const equipment = visible.filter((s) => s.nodeId == null);
  const jewels = visible.filter((s) => s.nodeId != null);

  // Swap slots are only meaningful when the swap is in use; showing four weapon
  // rows to someone with one weapon set is noise.
  const equipmentShown = items.useSecondWeaponSet
    ? equipment
    : equipment.filter((s) => s.weaponSet !== 2);

  const activeTitle =
    items.sets.find((s) => s.id === items.activeSet)?.title ?? "Set 1";
  const current = selected ? visible.find((s) => s.name === selected) ?? null : null;
  const currentItem = current?.itemId != null ? byId.get(current.itemId) ?? null : null;

  return (
    <div className="items" aria-busy={pending}>
      <div className="items__head">
        <label className="items__sets">
          <span className="items__sets-label">Set</span>
          <Select
            value={items.activeSet}
            onChange={(e) => void session.activateItemSet(Number(e.target.value))}
          >
            {items.sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "copy" })}>
          + Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "blank" })}>
          + Blank
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "rename" })}>
          Rename
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="btn--danger"
          disabled={items.sets.length <= 1}
          title={
            items.sets.length <= 1
              ? "A build must keep at least one item set"
              : "Delete this set"
          }
          onClick={() => setDialog({ kind: "delete-set" })}
        >
          ✕
        </Button>

        {/* Not cosmetic: it decides which weapons feed the calculation. */}
        <label className="items__swap" title="Calculate with the second weapon set">
          <input
            type="checkbox"
            checked={items.useSecondWeaponSet}
            onChange={(e) => void session.setWeaponSwap(e.target.checked)}
          />
          Weapon swap
        </label>

        <Button size="sm" onClick={() => setPasting(true)}>
          Paste item
        </Button>
      </div>

      <div className="items__body">
        <div className="items__slots">
          {equipmentShown.map((slot) => (
            <SlotRow
              key={slot.name}
              slot={slot}
              item={slot.itemId != null ? byId.get(slot.itemId) ?? null : null}
              selected={slot.name === selected}
              session={session}
              onSelect={() => setSelected(slot.name)}
            />
          ))}

          {jewels.length > 0 && (
            <JewelSockets
              slots={jewels}
              byId={byId}
              selected={selected}
              session={session}
              onSelect={setSelected}
            />
          )}
        </div>

        <div className="items__detail">
          {current ? (
            <ItemEditor
              session={session}
              slot={current}
              item={currentItem}
              pool={items.items}
            />
          ) : (
            <p className="items__note">Choose a slot to see what is in it.</p>
          )}
        </div>
      </div>

      {pasting && <PasteDialog session={session} onClose={() => setPasting(false)} />}

      {dialog?.kind === "delete-set" && (
        <ConfirmDialog
          title="Delete item set"
          message={`Delete the item set “${activeTitle}”? The items stay in the build; only this set's slot assignments go.`}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void session.deleteItemSet(items.activeSet);
          }}
        />
      )}
      {dialog && dialog.kind !== "delete-set" && (
        <PromptDialog
          title={
            dialog.kind === "rename"
              ? "Rename item set"
              : dialog.kind === "copy"
                ? "Copy item set"
                : "New item set"
          }
          label="Name"
          initial={
            dialog.kind === "rename"
              ? activeTitle
              : dialog.kind === "copy"
                ? `${activeTitle} copy`
                : "New Item Set"
          }
          commitLabel={dialog.kind === "rename" ? "Rename" : "Create"}
          onCancel={() => setDialog(null)}
          onCommit={(title) => {
            const kind = dialog.kind;
            setDialog(null);
            if (kind === "rename") void session.renameItemSet(items.activeSet, title);
            else if (kind === "copy")
              void session.newItemSet({ copyFrom: items.activeSet, title });
            else void session.newItemSet({ title });
          }}
        />
      )}
    </div>
  );
}

function SlotRow({
  slot,
  item,
  selected,
  session,
  onSelect,
}: {
  slot: ItemSlot;
  item: Item | null;
  selected: boolean;
  session: EngineSession;
  onSelect: () => void;
}) {
  const row = (
    <button
      type="button"
      className={`slot ${selected ? "slot--on" : ""} ${item ? "" : "slot--empty"}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="slot__name">
        {slot.label}
        {/* The swap pair shares a label, so the set has to be on the row. */}
        {slot.weaponSet === 2 && <span className="slot__swap"> swap</span>}
      </span>
      {item ? (
        <ItemSummary item={item} />
      ) : (
        <span className="slot__vacant">—</span>
      )}
    </button>
  );

  // Nothing equipped means nothing to take off, so no tip.
  if (!item) return row;

  // A flask is toggled rather than unequipped, so the question it answers is
  // "what if I stopped using this?" — which is a different sentence.
  const flask = item.type === "Flask";
  return (
    <CompareTip
      session={session}
      change={
        flask
          ? { kind: "item", slot: slot.name, item: item.id }
          : { kind: "item", slot: slot.name }
      }
      header={
        flask
          ? `Not using ${item.title ?? item.baseName} would give you:`
          : `Removing ${item.title ?? item.baseName} would give you:`
      }
    >
      {row}
    </CompareTip>
  );
}

/**
 * Jewel sockets, collapsed by default.
 *
 * One slot per allocated socket node — the sample character has 57. Listed flat
 * they would bury the eleven slots that matter, so the filled ones are shown
 * and the empty ones hide behind a count.
 */
function JewelSockets({
  slots,
  byId,
  selected,
  session,
  onSelect,
}: {
  slots: ItemSlot[];
  byId: Map<number, Item>;
  selected: string | null;
  session: EngineSession;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const filled = slots.filter((s) => s.itemId != null);
  const empty = slots.length - filled.length;
  const shown = open ? slots : filled;

  return (
    <div className="jewels">
      <div className="jewels__head">
        <span className="jewels__title">Jewel sockets</span>
        <span className="jewels__count">
          {filled.length} of {slots.length} filled
        </span>
      </div>
      {shown.map((slot) => (
        <SlotRow
          key={slot.name}
          slot={{ ...slot, label: slot.itemId != null ? "Socket" : "Empty socket" }}
          item={slot.itemId != null ? byId.get(slot.itemId) ?? null : null}
          selected={slot.name === selected}
          session={session}
          onSelect={() => onSelect(slot.name)}
        />
      ))}
      {empty > 0 && (
        <Button size="sm" variant="ghost" block onClick={() => setOpen(!open)}>
          {open ? "Hide empty sockets" : `Show ${empty} empty socket${empty === 1 ? "" : "s"}`}
        </Button>
      )}
    </div>
  );
}

/**
 * Paste an item.
 *
 * A failure here is the one item action a user triggers by accident — a stray
 * Ctrl+V — so it has to say so rather than appear to do nothing. The engine
 * answers with the reason; we keep the text on screen so it can be fixed.
 */
function PasteDialog({
  session,
  onClose,
}: {
  session: EngineSession;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const commit = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await session.pasteItem(text);
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Paste an item">
      <div className="modal modal--wide">
        <h2 className="modal__title">Paste an item</h2>
        <p className="modal__body">
          Copy an item in game with Ctrl+C, or from a trade site, and paste it here.
        </p>
        <TextArea
          autoFocus
          rows={12}
          className="items__paste"
          spellCheck={false}
          value={text}
          placeholder={"Rarity: RARE\nDoom Nails\nSteel Ring\n--------\n+40 to Dexterity"}
          onChange={(e) => setText(e.target.value)}
        />
        {failed && (
          <p className="items__paste-error">
            The engine could not read that as an item. Paste the whole thing, including
            the <code>Rarity:</code> line.
          </p>
        )}
        <div className="modal__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!text.trim()}
            onClick={() => void commit()}
          >
            Add item
          </Button>
        </div>
      </div>
    </div>
  );
}

export { rarityClass };
