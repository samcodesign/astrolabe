/**
 * The build's main sections.
 *
 * PoB puts the tree, skills, items and config behind tabs while keeping the
 * stat box and main-skill selector visible on every one of them
 * (`Modules/Build.lua:473-570`). That split is deliberate and worth copying:
 * the stats are the reason you are looking at any of the tabs, so they must
 * never be the thing you navigated away from.
 *
 * Panels are hidden rather than unmounted. `TreeStage` builds a WebGL renderer
 * on mount and destroys it on unmount (`TreeStage.tsx:139`), so unmounting on
 * every tab switch would re-upload every sprite sheet and throw away pan and
 * zoom. The others hold state a user would expect to survive a glance at
 * another tab — a scrolled config section, a half-pasted item.
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  // The shortcut handler reads these through a ref rather than depending on
  // them. `tabs` carries live JSX, so it is a new array on every render of the
  // parent; depending on it would tear down and re-add a window listener on
  // every keystroke anywhere in the app.
  const latest = useRef({ tabs, onChange });
  latest.current = { tabs, onChange };

  // Ctrl+1..N, as PoB binds them (`Build.lua:1150-1186`). Bound on the window
  // because the tab bar is rarely what holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      const { tabs: list, onChange: pick } = latest.current;
      if (list.length <= 1) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > list.length) return;
      e.preventDefault();
      pick(list[n - 1]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Arrow-key movement within the bar, which the tab role implies and which
  // keyboard users will try before they try Ctrl+N.
  const onBarKey = (e: React.KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === active);
    const next = tabs[(i + delta + tabs.length) % tabs.length]!;
    onChange(next.id);
    // Follow the selection, since the roving tabindex moves with it.
    barRef.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  // One section is not a set of tabs. Until the other three exist there is
  // nothing to choose between, and a lone tab is just a label taking up a row.
  const showBar = tabs.length > 1;

  return (
    <>
      {showBar && (
        <div
          className="tabbar"
          role="tablist"
          aria-label="Build sections"
          ref={barRef}
          onKeyDown={onBarKey}
        >
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              className="tabbar__tab"
              aria-selected={tab.id === active}
              aria-controls={`panel-${tab.id}`}
              id={`tab-${tab.id}`}
              tabIndex={tab.id === active ? 0 : -1}
              title={`${tab.label} (Ctrl+${i + 1})`}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className="tabpanel"
            role={showBar ? "tabpanel" : undefined}
            id={`panel-${tab.id}`}
            aria-labelledby={showBar ? `tab-${tab.id}` : undefined}
            // `hidden` alone is overridden by the panel's own `display`, so the
            // style carries it and `hidden` stays for assistive tech.
            hidden={!selected}
            style={selected ? undefined : { display: "none" }}
          >
            {tab.content}
          </div>
        );
      })}
    </>
  );
}
