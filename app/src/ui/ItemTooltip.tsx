/**
 * How an item reads.
 *
 * Path of Exile encodes almost everything in colour — rarity, socket, mod
 * source — and a PoE player reads gear by that before reading a word of it.
 * The tokens come from PoB's own table (`Data/Global.lua:7`) and are already in
 * `styles.css`, so nothing here picks a colour; it picks a class.
 *
 * The six mod lists are kept separate and rendered in PoB's order — enchant,
 * implicit, explicit, crucible — because that order is how the game itself
 * lays an item out, and flattening them loses which line is which.
 */

import type { Item, ItemMod, ItemSocket } from "@schema/rpc";

/** PoB's rarity colours, as a class rather than an inline value. */
export function rarityClass(rarity: Item["rarity"]): string {
  switch (rarity) {
    case "UNIQUE":
      return "rarity--unique";
    case "RARE":
      return "rarity--rare";
    case "MAGIC":
      return "rarity--magic";
    case "RELIC":
      return "rarity--relic";
    default:
      return "rarity--normal";
  }
}

/** One line in the slot list: the name, plus what tells it apart at a glance. */
export function ItemSummary({ item }: { item: Item }) {
  return (
    <span className="isum">
      <span className={`isum__name ${rarityClass(item.rarity)}`}>
        {item.title ?? item.baseName}
      </span>
      {item.sockets && item.sockets.length > 0 && <Sockets sockets={item.sockets} />}
      {item.corrupted && (
        <span className="isum__corrupt" title="Corrupted">
          ⊘
        </span>
      )}
    </span>
  );
}

/**
 * Sockets and links.
 *
 * `group` is what makes a six-link a six-link: sockets sharing a group are
 * linked to each other. Rendered as connected pips so the link structure is
 * visible rather than merely stated.
 */
export function Sockets({ sockets }: { sockets: ItemSocket[] }) {
  return (
    <span className="socks" title={describeLinks(sockets)}>
      {sockets.map((s, i) => {
        const linked = i > 0 && sockets[i - 1]!.group === s.group;
        return (
          <span key={s.index} className="socks__cell">
            {linked && <span className="socks__link" />}
            <span
              className={`socks__pip socks__pip--${s.colour ?? "none"}`}
              title={s.colour ? SOCKET_TITLE[s.colour] : undefined}
            />
          </span>
        );
      })}
    </span>
  );
}

/** PoB's own names for the socket colours (`ItemsTab.lua:4351-4362`). */
const SOCKET_TITLE: Record<string, string> = {
  R: "Red — strength",
  G: "Green — dexterity",
  B: "Blue — intelligence",
  W: "White — any gem",
  A: "Abyssal — abyss jewel only",
};

function describeLinks(sockets: ItemSocket[]): string {
  const groups = new Map<number, string[]>();
  for (const s of sockets) {
    const list = groups.get(s.group) ?? [];
    list.push(s.colour ?? "?");
    groups.set(s.group, list);
  }
  return [...groups.values()].map((g) => g.join("-")).join("  ");
}

/** The full item, as the game would show it. */
export function ItemTooltip({ item }: { item: Item }) {
  const mods = item.mods ?? {};
  const req = item.requires;
  const hasReq = req && (req.level || req.str || req.dex || req.int);

  return (
    <div className={`itip ${rarityClass(item.rarity)}`}>
      <header className="itip__head">
        <span className="itip__name">{item.title ?? item.baseName}</span>
        {item.title && <span className="itip__base">{item.baseName}</span>}
      </header>

      {(item.influences?.length || item.corrupted || item.mirrored) && (
        <div className="itip__flags">
          {item.influences?.map((inf) => (
            <span key={inf} className="itip__flag">
              {inf}
            </span>
          ))}
          {item.corrupted && <span className="itip__flag itip__flag--bad">Corrupted</span>}
          {item.mirrored && <span className="itip__flag">Mirrored</span>}
        </div>
      )}

      {item.defences && (
        <dl className="itip__stats">
          {item.defences.armour != null && <Stat label="Armour" v={item.defences.armour} tone="armour" />}
          {item.defences.evasion != null && <Stat label="Evasion" v={item.defences.evasion} tone="evasion" />}
          {item.defences.energyShield != null && (
            <Stat label="Energy Shield" v={item.defences.energyShield} tone="es" />
          )}
          {item.defences.ward != null && <Stat label="Ward" v={item.defences.ward} tone="ward" />}
        </dl>
      )}

      <div className="itip__meta">
        {item.quality ? <span>Quality +{item.quality}%</span> : null}
        {item.itemLevel ? <span>Item level {item.itemLevel}</span> : null}
        {hasReq && (
          <span>
            Requires{" "}
            {[
              req.level ? `level ${req.level}` : null,
              req.str ? `${req.str} Str` : null,
              req.dex ? `${req.dex} Dex` : null,
              req.int ? `${req.int} Int` : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        )}
      </div>

      {item.sockets && item.sockets.length > 0 && (
        <div className="itip__sockets">
          <Sockets sockets={item.sockets} />
        </div>
      )}

      {/* PoB's own order. Buff and scourge lines are rarer but real. */}
      <ModBlock title="Enchant" mods={mods.enchant} kind="enchant" />
      <ModBlock title="Implicit" mods={mods.implicit} kind="implicit" />
      <ModBlock mods={mods.explicit} kind="explicit" />
      <ModBlock title="Crucible" mods={mods.crucible} kind="crucible" />
      <ModBlock title="Scourge" mods={mods.scourge} kind="scourge" />
      <ModBlock title="Grants" mods={mods.buff} kind="buff" />
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: number; tone: string }) {
  return (
    <div className="itip__stat">
      <dt>{label}</dt>
      <dd className={`itip__stat-v itip__stat-v--${tone}`}>{v}</dd>
    </div>
  );
}

function ModBlock({
  title,
  mods,
  kind,
}: {
  title?: string;
  mods?: ItemMod[];
  kind: string;
}) {
  if (!mods || mods.length === 0) return null;
  return (
    <div className={`itip__mods itip__mods--${kind}`}>
      {title && <span className="itip__mods-label">{title}</span>}
      {mods.map((m) => (
        <p
          key={m.index}
          className={[
            "itip__mod",
            m.crafted ? "itip__mod--crafted" : "",
            m.fractured ? "itip__mod--fractured" : "",
            // A line the engine read but could not turn into modifiers is not
            // affecting your numbers. PoB dims these; saying nothing would let
            // a user believe a mod is counted when it is not.
            m.unparsed ? "itip__mod--unsupported" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          {...(m.unparsed
            ? { title: "The engine does not model this modifier, so it is not affecting your stats." }
            : {})}
        >
          {m.line}
        </p>
      ))}
    </div>
  );
}
