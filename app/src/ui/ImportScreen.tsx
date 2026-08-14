/**
 * Import: the three ways a build gets into the app.
 *
 *   1. paste a PoB share code
 *   2. open a PoB XML file
 *   3. fetch a live character from pathofexile.com
 *
 * Route 3 is the one with sharp edges — private profiles and rate limits — so
 * its failures get real sentences and a route out, not a red toast.
 */

import { useRef, useState } from "react";
import type { EngineSession } from "../engine/session";
import { useStore } from "../state/store";
import {
  describeImportError,
  fetchCharacter,
  fetchCharacterList,
  normaliseAccountName,
  type CharacterListEntry,
  type ImportMessage,
  type Realm,
} from "../poe-api/character";
import { isTauri } from "../rpc/tauri-transport";
import { looksLikeBuildLink } from "../poe-api/build-link";
import { openTextFile } from "../platform/files";
import { Banner, Button, Field, Input, Select, Spinner, TextArea } from "./primitives";

type Route = "code" | "file" | "character";

const ROUTES: Array<{ id: Route; name: string; desc: string }> = [
  { id: "code", name: "Paste a build code", desc: "A pobb.in or Path of Building share code." },
  { id: "file", name: "Open a file", desc: "A PoB .xml build, or a saved plan." },
  { id: "character", name: "Fetch a character", desc: "Live from your Path of Exile profile." },
];

export function ImportScreen({
  session,
  onCancel,
}: {
  session: EngineSession;
  /** Present only when there is already a build to go back to. */
  onCancel?: () => void;
}) {
  const [route, setRoute] = useState<Route>("code");
  const state = useStore(session.store, (s) => ({
    pending: s.importPending,
    error: s.importError,
  }));

  return (
    <div className="import">
      <div className="import__inner">
        <header className="import__head">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <h1 className="import__title">Start a build</h1>
            <div style={{ flex: 1 }} />
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                ← Back to build
              </Button>
            )}
          </div>
          <p className="import__lede">
            Everything is computed by Path of Building's own engine, so the numbers match
            what you would see there — including the parts nothing else reproduces.
          </p>
        </header>

        <div className="import__tabs">
          {ROUTES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="route"
              aria-pressed={route === r.id}
              onClick={() => setRoute(r.id)}
            >
              <span className="route__name">{r.name}</span>
              <span className="route__desc">{r.desc}</span>
            </button>
          ))}
        </div>

        {state.error && <Banner kind="error">{state.error}</Banner>}

        {route === "code" && <CodeRoute session={session} pending={state.pending} />}
        {route === "file" && <FileRoute session={session} pending={state.pending} />}
        {route === "character" && <CharacterRoute session={session} pending={state.pending} />}

        <div className="panel" style={{ padding: 20 }}>
          <div className="panel__actions">
            <div>
              <div style={{ fontSize: 14, fontWeight: 550 }}>Start from nothing</div>
              <div className="field__hint">A level 1 character with an empty tree.</div>
            </div>
            <div className="spacer" />
            <Button onClick={() => void session.loadEmpty()} disabled={state.pending}>
              New build
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodeRoute({ session, pending }: { session: EngineSession; pending: boolean }) {
  const [code, setCode] = useState("");
  const clean = code.trim();
  const isLink = looksLikeBuildLink(clean);

  return (
    <div className="panel">
      <Field
        label="Build code or link"
        hint={
          isLink
            ? "Link detected — the code will be fetched from the site."
            : "Paste the code, or a link from pobb.in, pob.codes, Maxroll, poe.ninja, Pastebin, Rentry or poedb.tw. A link is safer for a geared build: the code runs to tens of thousands of characters and truncates easily."
        }
      >
        <TextArea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="eNrtWk1v2zgQvfdXCD4XsiRbjg-2gTZpsQtsgSDpYo-FLNGxUElUSSqO99fvkPqwKFGyLNlpsm2AILY0nHnzhpwZ0lp82IeB8YgpiwhezhzTnhkYe8SP8MNy9vXus7mYfVi9WcQ4WMy-mB6JCX3vaR8…"
          rows={7}
        />
      </Field>
      <div className="panel__actions">
        <span className="field__hint">
          {clean ? (isLink ? "link" : `${clean.length.toLocaleString()} characters`) : ""}
        </span>
        <div className="spacer" />
        <Button
          variant="primary"
          busy={pending}
          disabled={!clean}
          onClick={() => void session.loadCodeOrLink(clean)}
        >
          {isLink ? "Fetch and import" : "Import build"}
        </Button>
      </div>
    </div>
  );
}

function FileRoute({ session, pending }: { session: EngineSession; pending: boolean }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fallbackInput = useRef<HTMLInputElement>(null);

  const load = async (text: string, fileName: string) => {
    setName(fileName);
    const looksLikePlan = text.trimStart().startsWith("{");
    const ok = looksLikePlan ? await session.openPlan(text) : await session.loadXml(text);
    if (!ok) setError("The file could not be read as a build.");
  };

  const pick = async () => {
    setError(null);
    if (!isTauri()) {
      fallbackInput.current?.click();
      return;
    }
    try {
      const picked = await openTextFile({
        title: "Open a build",
        filters: [
          { name: "Builds and plans", extensions: ["xml", "poeplan", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (!picked) return;
      await load(picked.contents, picked.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="panel">
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 550, marginBottom: 6 }}>
          Open a Path of Building XML, or a plan saved here
        </div>
        <div className="field__hint">
          In PoB this is <code>Import/Export build → Export to File</code>. Saved plans keep
          every tree variant; a raw PoB XML keeps only the tree it was saved with.
        </div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="panel__actions">
        <span className="field__hint">{name ?? ""}</span>
        <div className="spacer" />
        <Button variant="primary" busy={pending} onClick={() => void pick()}>
          Choose file…
        </Button>
      </div>
      <input
        ref={fallbackInput}
        type="file"
        accept=".xml,.poeplan,.json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          await load(await f.text(), f.name);
        }}
      />
    </div>
  );
}

function CharacterRoute({ session, pending }: { session: EngineSession; pending: boolean }) {
  const [account, setAccount] = useState("");
  const [character, setCharacter] = useState("");
  const [realm, setRealm] = useState<Realm>("pc");
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState<ImportMessage | null>(null);
  const [listing, setListing] = useState(false);
  const [chars, setChars] = useState<CharacterListEntry[] | null>(null);

  const query = () => ({
    account,
    character,
    realm,
    ...(sessionId.trim() ? { sessionId } : {}),
  });

  const listCharacters = async () => {
    setMessage(null);
    setListing(true);
    try {
      const list = await fetchCharacterList({
        account,
        realm,
        ...(sessionId.trim() ? { sessionId } : {}),
      });
      setChars(list);
      if (list.length === 0) {
        setMessage({
          title: "That account has no visible characters.",
          hint: "The characters tab may be hidden even when the profile is public.",
          retryable: true,
        });
      }
    } catch (e) {
      setMessage(describeImportError(e));
      setChars(null);
    } finally {
      setListing(false);
    }
  };

  const importCharacter = async (name?: string) => {
    const charName = name ?? character;
    if (!charName.trim()) {
      setMessage({ title: "Pick a character first.", retryable: false });
      return;
    }
    setMessage(null);
    setCharacter(charName);
    try {
      const payload = await fetchCharacter({ ...query(), character: charName });
      // PoB's own network path is dead headless, so the JSON goes over the wire
      // to `build.load { character }` rather than being fetched by the engine.
      await session.loadCharacter(payload, `${payload.account} / ${payload.character}`);
    } catch (e) {
      setMessage(describeImportError(e));
    }
  };

  if (!isTauri()) {
    return (
      <div className="panel">
        <Banner kind="warn">
          Fetching a live character needs the desktop app — a browser cannot call
          pathofexile.com directly. Use a build code or a file here.
        </Banner>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel__row panel__row--3">
        <Field label="Account name">
          <Input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            onBlur={() => setAccount((a) => normaliseAccountName(a))}
            placeholder="Exile#1234"
            autoComplete="off"
          />
        </Field>
        <Field label="Character">
          <Input
            value={character}
            onChange={(e) => setCharacter(e.target.value)}
            placeholder="MySpectacularArcher"
            autoComplete="off"
          />
        </Field>
        <Field label="Realm">
          <Select value={realm} onChange={(e) => setRealm(e.target.value as Realm)}>
            <option value="pc">PC</option>
            <option value="xbox">Xbox</option>
            <option value="sony">PlayStation</option>
          </Select>
        </Field>
      </div>

      {message && (
        <Banner kind="error">
          <div>{message.title}</div>
          {message.hint && (
            <div style={{ marginTop: 4, opacity: 0.85, fontSize: 13 }}>{message.hint}</div>
          )}
        </Banner>
      )}

      {chars && chars.length > 0 && (
        <div className="char-list">
          {chars.map((c) => (
            <button
              key={c.name}
              type="button"
              className="char-row"
              aria-pressed={c.name === character}
              onClick={() => void importCharacter(c.name)}
            >
              <span className="char-row__name">{c.name}</span>
              <span className="char-row__meta">
                {c.class} · {c.level}
                {c.league ? ` · ${c.league}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <details className="disclosure">
        <summary>Private profile? Use a session cookie</summary>
        <div className="disclosure__body">
          <Field
            label="POESESSID"
            hint="Only needed for a private profile. It stays in memory for this session, is never written to disk, and is sent to pathofexile.com and nowhere else. Copy it from your browser's cookies for pathofexile.com."
          >
            <Input
              type="password"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="32-character hex value"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
      </details>

      <div className="panel__actions">
        <Button onClick={() => void listCharacters()} busy={listing} disabled={!account.trim()}>
          List characters
        </Button>
        {listing && <Spinner />}
        <div className="spacer" />
        <Button
          variant="primary"
          busy={pending}
          disabled={!account.trim() || !character.trim()}
          onClick={() => void importCharacter()}
        >
          Import character
        </Button>
      </div>
    </div>
  );
}
