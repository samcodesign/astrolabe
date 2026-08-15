/**
 * Socket groups and gems.
 *
 * PoB's `SkillsTab` edits one group at a time behind a list control; this shows
 * every group at once, because there are rarely more than a dozen and scanning
 * them is most of what the tab is for.
 *
 * The engine owns all resolution — a gem's real name, its natural level, its
 * socket colour, its stat requirements and whether it resolved at all come from
 * `ProcessSocketGroup` (`SkillsTab.lua:1134-1207`). This file renders that and
 * sends edits back; it never decides what a gem *is*.
 */

import { useMemo, useRef, useState } from "react";
import type {
  GemCatalogueEntry,
  GemInstance,
  Item,
  ItemsState,
  SocketGroup,
} from "@schema/rpc";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { CompareTip } from "./CompareTip";
import { Sockets } from "./ItemTooltip";
import { Button, ConfirmDialog, Input, PromptDialog, Select } from "./primitives";

export function SkillsPanel({ session }: { session: EngineSession }) {
  const { skills, catalogue, mainGroup, pending, items } = useStore(session.store, (s) => ({
    skills: s.skills,
    catalogue: s.gemCatalogue,
    mainGroup: s.mainSkill?.groupIndex ?? s.skills?.mainGroup ?? 1,
    pending: s.statsPending,
    items: s.items,
  }));
  const [dialog, setDialog] = useState<
    { kind: "copy" | "blank" | "rename" | "delete" } | null
  >(null);

  if (!skills) {
    return (
      <div className="skills skills--empty">
        <p className="skills__note">Skills are not available for this build.</p>
      </div>
    );
  }

  const activeTitle =
    skills.sets.find((s) => s.id === skills.activeSet)?.title ?? "Default";

  return (
    <div className="skills" aria-busy={pending}>
      <div className="skills__head">
        {/* A whole gem loadout. Switching repoints the group list, so the
            engine also clamps and restores the main-skill pointer. */}
        <label className="skills__sets">
          <span className="skills__sets-label">Set</span>
          <Select
            value={skills.activeSet}
            onChange={(e) => void session.activateSkillSet(Number(e.target.value))}
          >
            {skills.sets.map((s) => (
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
          disabled={skills.sets.length <= 1}
          title={
            skills.sets.length <= 1
              ? "A build must keep at least one skill set"
              : "Delete this set"
          }
          onClick={() => setDialog({ kind: "delete" })}
        >
          ✕
        </Button>

        <span className="skills__count">
          {skills.groups.length} socket {skills.groups.length === 1 ? "group" : "groups"}
        </span>
        <Button size="sm" onClick={() => void session.addSocketGroup()}>
          + Socket group
        </Button>
      </div>

      <div className="skills__body">
        {skills.groups.length === 0 && (
          <p className="skills__note">
            No socket groups yet. Add one, then add a skill gem to it.
          </p>
        )}
        {skills.groups.map((group) => (
          <GroupCard
            key={group.index}
            group={group}
            slots={skills.slots}
            catalogue={catalogue ?? []}
            isMain={group.index === mainGroup}
            session={session}
            equipped={equippedIn(items, group.slot)}
          />
        ))}
      </div>

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete skill set"
          message={`Delete the skill set “${activeTitle}”? Every socket group in it goes with it.`}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void session.deleteSkillSet(skills.activeSet);
          }}
        />
      )}
      {dialog && dialog.kind !== "delete" && (
        <PromptDialog
          title={
            dialog.kind === "rename"
              ? "Rename skill set"
              : dialog.kind === "copy"
                ? "Copy skill set"
                : "New skill set"
          }
          label="Name"
          initial={
            dialog.kind === "rename"
              ? activeTitle
              : dialog.kind === "copy"
                ? `${activeTitle} copy`
                : "New Skill Set"
          }
          commitLabel={dialog.kind === "rename" ? "Rename" : "Create"}
          onCancel={() => setDialog(null)}
          onCommit={(title) => {
            const kind = dialog.kind;
            setDialog(null);
            if (kind === "rename") void session.renameSkillSet(skills.activeSet, title);
            else if (kind === "copy") void session.newSkillSet({ copyFrom: skills.activeSet, title });
            else void session.newSkillSet({ title });
          }}
        />
      )}
    </div>
  );
}

/**
 * The item a socket group is socketed in, if anything.
 *
 * PoB shows the item's sockets beside the group (`ItemsTab.lua:4339-4366`), and
 * it is genuinely diagnostic: six gems in a four-socket chest is a mistake you
 * cannot otherwise see from this tab.
 */
function equippedIn(items: ItemsState | null, slotName: string | undefined): Item | null {
  if (!items || !slotName) return null;
  const slot = items.slots.find((s) => s.name === slotName);
  if (!slot || slot.itemId == null) return null;
  return items.items.find((i) => i.id === slot.itemId) ?? null;
}

function GroupCard({
  group,
  slots,
  catalogue,
  isMain,
  session,
  equipped,
}: {
  group: SocketGroup;
  slots: string[];
  catalogue: GemCatalogueEntry[];
  isMain: boolean;
  session: EngineSession;
  equipped: Item | null;
}) {
  const set = (params: Partial<Parameters<EngineSession["setSocketGroup"]>[0]>) =>
    void session.setSocketGroup({ group: group.index, ...params });
  const [confirming, setConfirming] = useState(false);

  return (
    <section className={`socket-group ${group.enabled ? "" : "socket-group--off"} ${isMain ? "socket-group--main" : ""}`}>
      <header className="socket-group__head">
        <input
          type="checkbox"
          className="socket-group__enable"
          checked={group.enabled}
          title="Enable this socket group"
          onChange={(e) => set({ enabled: e.target.checked })}
        />

        {/* Enabled, but sitting in the weapon set that is not active — so it
            contributes nothing however the checkbox looks. PoB labels this
            `(Disabled)` (`SkillListControl.lua:76-80`); without it the group
            reads as live. */}
        {group.enabled && !group.slotEnabled && (
          <span
            className="socket-group__inert"
            title="This group is socketed in the weapon set that is not currently active, so it is not applying."
          >
            INACTIVE
          </span>
        )}

        {/* `displayLabel` is the engine's — the group's own name if it has one,
            otherwise its active skills joined. Editing sets `label`, so the
            placeholder shows what the engine would call it if left blank. */}
        <input
          key={group.label}
          className="input socket-group__label"
          defaultValue={group.label}
          placeholder={group.displayLabel || "Unnamed group"}
          disabled={group.fromItem}
          onBlur={(e) => {
            if (e.target.value !== group.label) set({ label: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />

        {isMain && <span className="socket-group__main-tag" title="The stat panel reports this group">MAIN</span>}

        <Select
          className="socket-group__slot"
          value={group.slot ?? ""}
          title="Item this group is socketed in"
          disabled={group.fromItem}
          onChange={(e) => set({ slot: e.target.value === "" ? false : e.target.value })}
        >
          <option value="">No slot</option>
          {slots.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>

        {/* What the group is actually socketed in. A group with more gems than
            the item has sockets is not a warning the engine raises — the extra
            gems simply do not apply — so showing the sockets is the only way to
            notice. */}
        {equipped?.sockets && equipped.sockets.length > 0 && (
          <span
            className={`socket-group__sockets ${
              group.gems.length > equipped.sockets.length ? "socket-group__sockets--over" : ""
            }`}
            title={
              group.gems.length > equipped.sockets.length
                ? `${equipped.title ?? equipped.baseName} has ${equipped.sockets.length} sockets but this group has ${group.gems.length} gems — the extra ones are not applying.`
                : `Socketed in ${equipped.title ?? equipped.baseName}`
            }
          >
            <Sockets sockets={equipped.sockets} />
          </span>
        )}

        <label
          className="socket-group__repeat"
          title="How many copies of this group the build has"
        >
          ×
          <input
            key={group.count}
            type="number"
            className="input"
            min={1}
            defaultValue={group.count}
            disabled={group.fromItem}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n !== group.count) set({ count: Math.floor(n) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>

        <label className="socket-group__fulldps" title="Count this group's damage in Full DPS">
          <input
            type="checkbox"
            checked={group.includeInFullDPS}
            onChange={(e) => set({ includeInFullDPS: e.target.checked })}
          />
          Full DPS
        </label>

        {!isMain && (
          <Button
            variant="ghost"
            size="sm"
            title="Report this group's skill in the stat panel"
            onClick={() => void session.setMainSkill({ group: group.index })}
          >
            Show stats
          </Button>
        )}
        {!group.fromItem && (
          <Button
            variant="ghost"
            size="sm"
            className="btn--danger"
            aria-label={`Delete ${group.displayLabel || "group"}`}
            // A group with gems in it is real work; PoB confirms too
            // (`SkillListControl.lua:154-190`). An empty one goes straight
            // away — confirming nothing is just a click tax.
            onClick={() =>
              group.gems.length > 0
                ? setConfirming(true)
                : void session.deleteSocketGroup(group.index)
            }
          >
            ✕
          </Button>
        )}
      </header>

      {group.fromItem && (
        <p className="socket-group__from-item">Granted by an item — edit the item to change it.</p>
      )}

      {/* An imbued support applies to everything in this group's item slot as
          if socketed, without taking a socket. Keyed by slot, so a group with
          no slot has nowhere to put one — and PoB hides it for item-granted
          groups (`SkillsTab.lua:331-334`). */}
      {!group.fromItem && group.slot && (
        <ImbuedSupport group={group} catalogue={catalogue} session={session} />
      )}

      <div className="socket-group__gems">
        {group.gems.map((gem) => (
          <GemRow
            key={gem.index}
            gem={gem}
            group={group}
            catalogue={catalogue}
            session={session}
          />
        ))}
        {!group.fromItem && (
          <GemPicker
            session={session}
            catalogue={catalogue}
            placeholder="Add a gem…"
            // One past the end appends, which is how PoB's trailing empty row
            // works — there is no separate add call, and the same index asks
            // the engine what adding the gem would be worth.
            slot={group.gems.length + 1}
            group={group.index}
            onPick={(id) =>
              void session.setGem({
                group: group.index,
                gem: group.gems.length + 1,
                gemId: id,
              })
            }
          />
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Delete socket group"
          message={`Delete “${group.displayLabel || group.label || "this group"}” and its ${group.gems.length} gem${group.gems.length === 1 ? "" : "s"}?`}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void session.deleteSocketGroup(group.index);
          }}
        />
      )}
    </section>
  );
}

const COLOUR_TITLE = { R: "Strength (red)", G: "Dexterity (green)", B: "Intelligence (blue)" };

/**
 * PoB's `colorCodes.STRENGTH / DEXTERITY / INTELLIGENCE`
 * (`Data/Global.lua:36-38`), which is what it paints a gem name with.
 *
 * Hardcoded rather than read from a CSS variable because it is applied inline
 * — the same way `DisplayStat.colour` is — and because these three are the
 * engine's values, not a theme choice something later might want to override.
 */
const ATTRIBUTE_COLOUR = { R: "#e05030", G: "#70ff70", B: "#7070ff" };

function GemRow({
  gem,
  group,
  catalogue,
  session,
}: {
  gem: GemInstance;
  group: SocketGroup;
  catalogue: GemCatalogueEntry[];
  session: EngineSession;
}) {
  const set = (params: Partial<Parameters<EngineSession["setGem"]>[0]>) =>
    void session.setGem({ group: group.index, gem: gem.index, ...params });

  return (
    <div className={`gem ${gem.enabled ? "" : "gem--off"} ${gem.error ? "gem--error" : ""}`}>
      <CompareTip
        session={session}
        change={
          group.fromItem ? null : { kind: "gemEnabled", group: group.index, gem: gem.index }
        }
        header={gem.enabled ? "Disabling this gem will give you:" : "Enabling this gem will give you:"}
      >
        <input
          type="checkbox"
          checked={gem.enabled}
          title="Enable this gem"
          disabled={group.fromItem}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
      </CompareTip>

      {gem.colour ? (
        <span
          className={`gem__socket gem__socket--${gem.colour}`}
          title={COLOUR_TITLE[gem.colour]}
        />
      ) : (
        <span className="gem__socket gem__socket--none" />
      )}
      {/* A group with no slot has no sockets to match, so the engine sends no
          verdict and there is nothing to warn about. */}
      {gem.matchesSocket === false && (
        <span
          className="gem__mismatch"
          title={`This gem wants a ${COLOUR_TITLE[gem.colour ?? "R"].toLowerCase()} socket, and the one it is in is a different colour.`}
        >
          !
        </span>
      )}

      {/* PoB colours the gem name by its attribute, not a swatch beside it
          (`SkillsTab.lua:1186-1192`) — that is how a link setup is read at a
          glance. An unresolved gem keeps the error colour the class supplies. */}
      <span
        className={`gem__name ${gem.support ? "gem__name--support" : ""}`}
        {...(gem.colour && !gem.error
          ? { style: { color: ATTRIBUTE_COLOUR[gem.colour] } }
          : {})}
      >
        {gem.name ?? gem.nameSpec}
      </span>

      <label className="gem__num" title="Gem level">
        <span>L</span>
        {/* No `max`: `maxLevel` is the gem's *natural* max, but corrupted gems
            are 21 and awakened go higher (`SkillsTab.lua:1105-1114`). The
            engine clamps properly (`CalcTools.lua:42-54`); a browser-side max
            just refused to spin past 20. */}
        <NumberBox
          value={gem.level}
          disabled={group.fromItem}
          onCommit={(n) => set({ level: n })}
        />
      </label>
      {/* PoB asks this one question and only this one — "what about 20?" —
          because 20 is where a gem's quality normally lands
          (`SkillsTab.lua:911-918`). At 20 already there is nothing to ask. */}
      <CompareTip
        session={session}
        change={
          group.fromItem || gem.quality >= 20
            ? null
            : { kind: "gemQuality", group: group.index, gem: gem.index, value: 20 }
        }
        header="Setting to 20 quality will give you:"
      >
        <label
          className={`gem__numlabel gem__num ${gem.quality >= 20 ? "gem__num--maxq" : ""}`}
          title="Quality"
        >
          <span>Q</span>
          <NumberBox
            value={gem.quality}
            min={0}
            disabled={group.fromItem}
            onCommit={(n) => set({ quality: n })}
          />
        </label>
      </CompareTip>
      {/* Only where it means something — the engine decides, because the rule
          depends on the gem's granted effects. */}
      {gem.showCount && (
        <label
          className="gem__num"
          title="Scales this skill's DPS by a scalar — totems, mines, shotgunning projectiles"
        >
          <span>×</span>
          <NumberBox
            value={gem.count}
            disabled={group.fromItem}
            onCommit={(n) => set({ count: n })}
          />
        </label>
      )}

      <div className="gem__actions">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Move up"
          disabled={gem.index === 1 || group.fromItem}
          onClick={() => void session.reorderGem(group.index, gem.index, gem.index - 1)}
        >
          ↑
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Move down"
          disabled={gem.index === group.gems.length || group.fromItem}
          onClick={() => void session.reorderGem(group.index, gem.index, gem.index + 1)}
        >
          ↓
        </Button>
        {!group.fromItem && (
          <Button
            variant="ghost"
            size="sm"
            className="btn--danger"
            aria-label={`Remove ${gem.name ?? gem.nameSpec}`}
            onClick={() => void session.deleteGem(group.index, gem.index)}
          >
            ✕
          </Button>
        )}
      </div>

      {gem.error && <span className="gem__error">{gem.error}</span>}
      {!gem.error && gem.reqLevel != null && (
        <span className="gem__req" title={requirementTitle(gem)}>
          {formatRequirements(gem)}
        </span>
      )}
      {/* Keeps the picker reachable for swapping a gem in place. */}
      {!group.fromItem && (
        <GemPicker
          session={session}
          catalogue={catalogue}
          placeholder="Replace…"
          compact
          group={group.index}
          slot={gem.index}
          onPick={(id) => set({ gemId: id })}
        />
      )}

      {/* A Vaal gem's two halves, each toggled independently. Its own row
          because the labels carry the effect names and are long. */}
      {gem.globalEffects?.length ? (
        <div className="gem__globals">
          {gem.globalEffects.map((effect) => (
            <label key={effect.index} className="gem__global">
              <input
                type="checkbox"
                checked={effect.index === 1 ? gem.enableGlobal1 : gem.enableGlobal2}
                disabled={group.fromItem}
                onChange={(e) =>
                  set(
                    effect.index === 1
                      ? { enableGlobal1: e.target.checked }
                      : { enableGlobal2: e.target.checked },
                  )
                }
              />
              Enable {effect.name}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `req 70 · 155 Int` — level plus whichever attributes the gem actually needs.
 *
 * PoB colours each against the character's own attributes
 * (`SkillsTab.lua:1200-1204`); we do not have the character's here, so this
 * states the requirement and leaves the comparison to the stat panel.
 */
function formatRequirements(gem: GemInstance): string {
  const attrs = [
    [gem.reqStr, "Str"],
    [gem.reqDex, "Dex"],
    [gem.reqInt, "Int"],
  ]
    .filter(([v]) => typeof v === "number" && v > 0)
    .map(([v, name]) => `${v} ${name}`);
  return [`req ${gem.reqLevel}`, ...attrs].join(" · ");
}

function requirementTitle(gem: GemInstance): string {
  return `Requires level ${gem.reqLevel}` + (gem.reqStr || gem.reqDex || gem.reqInt
    ? " and the attributes shown"
    : "");
}

/**
 * A gem combobox over the whole catalogue.
 *
 * Matching is a plain substring on name and tags, which is what makes "cold
 * spell" find Cold Snap. Hovering a result asks the engine what picking it
 * would do. PoB additionally *ranks* the whole list by that same number
 * (`GemSelectControl:sortGemTypeList:66-76`), which is one calculation per
 * candidate and needs the streaming job treatment — not wired up here.
 */
function GemPicker({
  session,
  catalogue,
  placeholder,
  compact,
  group,
  slot,
  onPick,
}: {
  session: EngineSession;
  catalogue: GemCatalogueEntry[];
  placeholder: string;
  compact?: boolean;
  /** Where a picked gem would land, so the hover can ask what that is worth. */
  group: number;
  slot: number;
  onPick: (gemId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // An empty box lists everything so the catalogue can be browsed, as PoB
    // does (`GemSelectControl.lua:238-252`). Returning nothing made the picker
    // look broken until you happened to type.
    const hits = q
      ? catalogue.filter(
          (gem) =>
            gem.name.toLowerCase().includes(q) || gem.tags.toLowerCase().includes(q),
        )
      : catalogue;

    // Rank first, cap second. Capping first meant the prefix-first sort only
    // reordered the first 40 hits found in alphabetical catalogue order — so
    // typing "fire" could bury or omit Fireball behind 40 gems merely tagged
    // fire.
    const ranked = q
      ? [...hits].sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          return ap - bp || a.name.localeCompare(b.name);
        })
      : hits;

    // The list is a dropdown; more than this is not a menu, it is a wall.
    return ranked.slice(0, 40);
  }, [catalogue, query]);

  const pick = (gem: GemCatalogueEntry) => {
    onPick(gem.id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={`gempick ${compact ? "gempick--compact" : ""}`}>
      <Input
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Deferred so a click on a result is not cancelled by the blur.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) pick(matches[0]);
          if (e.key === "Escape") {
            setQuery("");
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="gempick__list" role="listbox">
          {matches.map((gem) => (
            <li key={gem.id}>
              <CompareTip
                session={session}
                change={{ kind: "gem", group, gem: slot, gemId: gem.id }}
                header={`Selecting ${gem.name} will give you:`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="gempick__item"
                  onMouseDown={() => {
                    if (blurTimer.current) clearTimeout(blurTimer.current);
                  }}
                  onClick={() => pick(gem)}
                >
                  <span className={gem.support ? "gempick__name--support" : "gempick__name"}>
                    {gem.name}
                  </span>
                  <span className="gempick__tags">{gem.tags}</span>
                </button>
              </CompareTip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The support imbued into this group's item slot.
 *
 * A narrower list than the gem picker's: only supports that are neither
 * exceptional nor awakened and that do not themselves grant an active skill.
 * The engine applies that filter (`skills.gemCatalogue { imbued: true }`); this
 * mirrors it client-side against the catalogue already in memory, since the
 * catalogue carries both flags.
 */
function ImbuedSupport({
  group,
  catalogue,
  session,
}: {
  group: SocketGroup;
  catalogue: GemCatalogueEntry[];
  session: EngineSession;
}) {
  const eligible = useMemo(
    () => catalogue.filter((g) => g.support && !g.exceptional && !g.legacy),
    [catalogue],
  );

  return (
    <label className="imbued" title="Applies to this item slot as if socketed, without using a socket">
      <span className="imbued__label">Imbued support</span>
      <Select
        className="imbued__pick"
        value={eligible.find((g) => g.name === group.imbuedSupport)?.id ?? ""}
        onChange={(e) =>
          void session.setImbuedSupport(group.index, e.target.value === "" ? false : e.target.value)
        }
      >
        <option value="">None</option>
        {eligible.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Commits on blur or Enter — each commit is a full recalculation. */
function NumberBox({
  value,
  min = 1,
  max,
  disabled,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  return (
    <input
      key={value}
      type="number"
      className="input gem__numbox"
      defaultValue={value}
      min={min}
      {...(max != null ? { max } : {})}
      disabled={disabled}
      onBlur={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n !== value) onCommit(Math.max(min, Math.floor(n)));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
