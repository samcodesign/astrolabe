/**
 * Tree variants.
 *
 * Tabs, because that is what they are: parallel versions of the same build's
 * tree. Right-click (or the chevron) opens the per-variant actions; the "vs"
 * marker picks the one the stat panel compares against.
 *
 * See `engine/specs.ts` for why this is frontend state — the RPC schema has no
 * spec methods.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import { Button } from "./primitives";

export function SpecBar({ session }: { session: EngineSession }) {
  const { specs, pending } = useStore(session.store, (s) => ({
    specs: s.specs,
    pending: s.statsPending,
  }));
  // The trigger's on-screen box travels with the open menu, because the menu is
  // portalled out of this bar and has nothing to anchor to otherwise.
  const [menuFor, setMenuFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const openMenu = (id: string, target: Element | null) => {
    const anchor = (target?.closest(".spec-tab") ?? target)?.getBoundingClientRect();
    if (anchor) setMenuFor({ id, anchor });
  };

  return (
    <div className="specbar" role="tablist" aria-label="Tree variants">
      {specs.specs.map((spec) => {
        const active = spec.id === specs.activeId;
        const isCompare = spec.id === specs.compareId;
        return (
          <div key={spec.id} className="spec-tab-group">
            <button
              type="button"
              role="tab"
              className="spec-tab"
              aria-selected={active}
              onClick={() => {
                if (!active) void session.selectSpec(spec.id);
              }}
              onDoubleClick={() => setRenaming(spec.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(spec.id, e.currentTarget);
              }}
              disabled={pending && !active}
            >
              {renaming === spec.id ? (
                <RenameInput
                  initial={spec.title}
                  onCommit={(title) => {
                    session.renameSpec(spec.id, title);
                    setRenaming(null);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <>
                  <span>{spec.title}</span>
                  <span className="spec-tab__points">{spec.pointsUsed}</span>
                  {isCompare && <span className="spec-tab__compare">VS</span>}
                </>
              )}
            </button>

            {/* A sibling, not a child of the tab.
                Interactive elements may not nest: a `<button>` inside a
                `<button>` is invalid HTML, browsers disagree about which one
                receives the click, and screen readers announce a button inside
                a button. It was rendered as `<span role="button">` inside the
                tab, which has all the same problems and merely hides them from
                the validator. */}
            {renaming !== spec.id && (
              <button
                type="button"
                className="spec-tab__menu"
                aria-label={`Actions for ${spec.title}`}
                aria-haspopup="menu"
                aria-expanded={menuFor?.id === spec.id}
                onClick={(e) => {
                  e.stopPropagation();
                  openMenu(spec.id, e.currentTarget);
                }}
              >
                ⌄
              </button>
            )}

            {menuFor?.id === spec.id && (
              <SpecMenu
                anchor={menuFor.anchor}
                onClose={() => setMenuFor(null)}
                items={[
                  { label: "Rename", run: () => setRenaming(spec.id) },
                  { label: "Duplicate", run: () => session.duplicateSpec(spec.id) },
                  {
                    label: isCompare ? "Stop comparing" : "Compare against this",
                    run: () => session.setCompare(isCompare ? null : spec.id),
                    disabled: !isCompare && spec.id === specs.activeId,
                  },
                  {
                    label: "Delete",
                    run: () => session.deleteSpec(spec.id),
                    danger: true,
                    disabled: specs.specs.length <= 1,
                  },
                ]}
              />
            )}
          </div>
        );
      })}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => session.newSpec({ fromCurrent: true })}
        title="Add a variant that starts as a copy of the current tree"
      >
        + Variant
      </Button>
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="spec-tab__input"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

const MENU_WIDTH = 200;

/**
 * Rendered into `document.body`, not next to its tab.
 *
 * `.specbar` scrolls horizontally so a row of variants stays reachable, and CSS
 * will not let one axis scroll while the other overflows visibly — asking for
 * `overflow-x: auto` silently clips the vertical axis too. An absolutely
 * positioned menu inside the bar is therefore cut off at the bar's own edge,
 * which is a few pixels below the tab: the menu was open, focusable and
 * keyboard-navigable, and drew nothing at all.
 *
 * A portal escapes the clip, and fixed positioning against the trigger's box
 * keeps it under the tab it belongs to.
 */
function SpecMenu({
  items,
  anchor,
  onClose,
}: {
  items: MenuItem[];
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Deferred so the click that opened the menu does not immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Kept on screen: a variant scrolled to the right edge would otherwise open a
  // menu half outside the window.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        top: anchor.bottom + 6,
        left,
        zIndex: 30,
        minWidth: MENU_WIDTH,
        background: "var(--surface-2)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-2)",
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={`btn btn--ghost btn--sm ${item.danger ? "btn--danger" : ""}`}
          style={{ justifyContent: "flex-start", height: 30 }}
          onClick={() => {
            item.run();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
