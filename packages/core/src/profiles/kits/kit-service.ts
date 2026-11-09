/**
 * What the Kits page reads and does. One state snapshot and one action call,
 * so the Electron IPC and the web RPC stay two methods wide.
 */
import {
  addToLibrary, createKit, dropEntries, listKits, planLoads, readInstructions, readUses, removeFromLibrary,
  removeKit, scanLibrary, useEntries, usesEntries, writeInstructions,
  type LibraryKind, type LoadsKit
} from "@ccr/core/profiles/kits/kit-store";
import { kitStoreRoot } from "@ccr/core/profiles/kits/launch-args";

export type KitsLibraryEntry = { folder: string; kind: LibraryKind; name: string };
export type KitsKitState = { instructions: string; loads: LoadsKit; name: string; uses: string[] };
export type KitsState = { kits: KitsKitState[]; library: KitsLibraryEntry[]; warnings: string[] };

export type KitsAction =
  | { type: "createKit"; name: string }
  | { type: "removeKit"; name: string }
  | { entries: string[]; kit: string; type: "use" }
  | { entries: string[]; kit: string; type: "drop" }
  | { kit: string; text: string; type: "setInstructions" }
  | { folder?: string; source: string; type: "libraryAdd" }
  | { entry: string; type: "libraryRemove" };

export function getKitsState(root: string = kitStoreRoot()): KitsState {
  const names = listKits(root);
  const plan = planLoads(root, names);
  return {
    kits: names.map((name, index) => ({
      instructions: readInstructions(root, name) ?? "",
      loads: plan.kits[index]!,
      name,
      uses: usesEntries(readUses(root, name))
    })),
    library: scanLibrary(root).map(({ folder, kind, name }) => ({ folder, kind, name })),
    warnings: plan.warnings
  };
}

/** Apply one change and return the new state. Throws a readable Error on misuse. */
export function applyKitsAction(action: KitsAction, root: string = kitStoreRoot()): KitsState {
  switch (action.type) {
    case "createKit": createKit(root, action.name.trim()); break;
    case "removeKit": removeKit(root, action.name); break;
    case "use": useEntries(root, action.kit, action.entries); break;
    case "drop": dropEntries(root, action.kit, action.entries); break;
    case "setInstructions": writeInstructions(root, action.kit, action.text); break;
    case "libraryAdd": addToLibrary(root, action.source.trim(), action.folder ? { folder: action.folder } : {}); break;
    case "libraryRemove": removeFromLibrary(root, action.entry); break;
    default: throw new Error("Unknown kits action.");
  }
  return getKitsState(root);
}
