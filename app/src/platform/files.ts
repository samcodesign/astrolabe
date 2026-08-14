/**
 * Native file dialogs, with a browser fallback.
 *
 * Reads and writes go through our own Rust commands rather than the fs plugin:
 * the path always comes from a dialog the user just interacted with, so no
 * scope configuration is needed and nothing else on disk is reachable.
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../rpc/tauri-transport";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  path: string;
  name: string;
  contents: string;
}

export async function openTextFile(opts: {
  title?: string;
  filters?: FileFilter[];
}): Promise<PickedFile | null> {
  if (!isTauri()) throw new Error("file dialogs need the desktop app");

  const picked = await open({
    multiple: false,
    directory: false,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.filters ? { filters: opts.filters } : {}),
  });
  if (typeof picked !== "string") return null;

  const contents = await invoke<string>("read_text_file", { path: picked });
  return { path: picked, name: basename(picked), contents };
}

export async function saveTextFile(opts: {
  contents: string;
  defaultName?: string;
  title?: string;
  filters?: FileFilter[];
}): Promise<string | null> {
  if (!isTauri()) {
    // Browser fallback: hand it to the download machinery.
    const blob = new Blob([opts.contents], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = opts.defaultName ?? "build.txt";
    a.click();
    URL.revokeObjectURL(url);
    return a.download;
  }

  const path = await save({
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.defaultName ? { defaultPath: opts.defaultName } : {}),
    ...(opts.filters ? { filters: opts.filters } : {}),
  });
  if (!path) return null;
  await invoke("write_text_file", { path, contents: opts.contents });
  return path;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
