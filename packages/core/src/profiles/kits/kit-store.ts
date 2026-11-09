/**
 * Library and kits for Claude Code sessions.
 *
 * - The **library** holds every skill, agent and plugin once, in folders you
 *   choose. A name is unique in the library whatever its folder, because Claude
 *   Code knows a skill by name and a kit picks items by name.
 * - A **kit** is a `uses` file listing library entries (`skills/x`, `agents/y`,
 *   `plugins/z`, or a folder such as `skills/net/`) plus optional instructions
 *   (`CLAUDE.md`) and an optional plugin-format `.mcp.json`.
 * - At launch each kit is rebuilt into a Claude Code plugin under `.build/`:
 *   skills are links into the library (edits are live), agents are copies
 *   (Claude Code does not read an agent through a link), instructions are
 *   appended to the system prompt.
 *
 * Every function takes the store `root`, so it is testable against a temp dir.
 * Layout under the root: `library/{skills,agents,plugins}`, `kits/<kit>/`,
 * `.build/`, `.trash/`.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LibraryKind = "skills" | "agents" | "plugins";
export const libraryKinds: readonly LibraryKind[] = ["skills", "agents", "plugins"];

export type LibraryItem = {
  /** Absolute path: the skill directory, the agent .md file, or the plugin directory. */
  dir: string;
  /** Folder under the kind, "" at the top, e.g. "net/nqe". */
  folder: string;
  kind: LibraryKind;
  name: string;
};

export type LoadsLine = {
  entry: string;
  items: Array<{ kind: LibraryKind; name: string }>;
  /** The library no longer has this entry. */
  missing: boolean;
};

export type LoadsKit = { instructions: boolean; lines: LoadsLine[]; name: string; missing: boolean };

export type LoadsPlan = {
  kits: LoadsKit[];
  /** Library plugins the kits pick, each once. */
  plugins: string[];
  totals: { agents: number; plugins: number; skills: number };
  warnings: string[];
};

export type LaunchPlan = {
  /** Value for `--append-system-prompt-file`, when any kit has instructions. */
  instructionsFile?: string;
  loads: LoadsPlan;
  /** One `--plugin-dir` each: the built kits, then the library plugins they pick. */
  pluginDirs: string[];
  warnings: string[];
};

const kitNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const entryPattern = /^(skills|agents|plugins)\/(.+)$/;

export function libraryDir(root: string): string { return path.join(root, "library"); }
export function kitsDir(root: string): string { return path.join(root, "kits"); }
export function buildDir(root: string): string { return path.join(root, ".build"); }
function trashDir(root: string): string { return path.join(root, ".trash"); }

export function isValidKitName(name: string): boolean {
  return kitNamePattern.test(name);
}

// ---------------------------------------------------------------- library --

export function scanLibrary(root: string): LibraryItem[] {
  const items: LibraryItem[] = [];
  walkSkills(path.join(libraryDir(root), "skills"), "", items);
  walkAgents(path.join(libraryDir(root), "agents"), "", items);
  for (const entry of listDirs(path.join(libraryDir(root), "plugins"))) {
    const dir = path.join(libraryDir(root), "plugins", entry);
    items.push({ dir, folder: "", kind: "plugins", name: pluginManifestName(dir) ?? entry });
  }
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Names the library holds more than once, per kind. Adds refuse these; hand edits can create them. */
export function duplicateLibraryNames(items: LibraryItem[]): string[] {
  const seen = new Map<string, number>();
  for (const item of items) {
    const key = `${item.kind}/${item.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
}

function walkSkills(dir: string, folder: string, out: LibraryItem[]): void {
  for (const entry of listDirs(dir)) {
    const full = path.join(dir, entry);
    if (existsSync(path.join(full, "SKILL.md"))) {
      out.push({ dir: full, folder, kind: "skills", name: entry });
    } else {
      walkSkills(full, folder ? `${folder}/${entry}` : entry, out);
    }
  }
}

function walkAgents(dir: string, folder: string, out: LibraryItem[]): void {
  for (const entry of readNames(dir)) {
    const full = path.join(dir, entry);
    if (isDirectory(full)) {
      walkAgents(full, folder ? `${folder}/${entry}` : entry, out);
    } else if (entry.endsWith(".md")) {
      out.push({ dir: full, folder, kind: "agents", name: entry.slice(0, -3) });
    }
  }
}

function pluginManifestName(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Create a library folder such as `skills/writing`. */
export function makeLibraryFolder(root: string, folder: string): void {
  const { kind, rest } = parseEntry(folder);
  if (!rest || kind === "plugins") {
    throw new Error("Folders hold skills or agents: skills/<folder> or agents/<folder>.");
  }
  mkdirSync(path.join(libraryDir(root), kind, safeRelative(rest)), { recursive: true });
}

/** Copy a skill folder or an agent .md file into the library. Returns the new entry. */
export function addToLibrary(root: string, source: string, options: { folder?: string } = {}): string {
  const from = path.resolve(source);
  if (!existsSync(from)) throw new Error(`Not found: ${source}`);
  const folder = options.folder ? safeRelative(options.folder) : "";
  const isAgent = statSync(from).isFile() && from.endsWith(".md");
  const isSkill = statSync(from).isDirectory() && existsSync(path.join(from, "SKILL.md"));
  const isPlugin = statSync(from).isDirectory() && existsSync(path.join(from, ".claude-plugin", "plugin.json"));
  if (!isAgent && !isSkill && !isPlugin) {
    throw new Error("Expected a skill folder (with SKILL.md), an agent .md file, or a plugin folder (with .claude-plugin/plugin.json).");
  }
  const kind: LibraryKind = isAgent ? "agents" : isSkill ? "skills" : "plugins";
  const name = isAgent ? path.basename(from, ".md") : isPlugin ? pluginManifestName(from) ?? path.basename(from) : path.basename(from);
  if (scanLibrary(root).some((item) => item.kind === kind && item.name === name)) {
    throw new Error(`The library already has ${kind}/${name}.`);
  }
  if (kind === "plugins" && isValidKitName(name) && existsSync(path.join(kitsDir(root), name))) {
    throw new Error(`A kit is named ${name}; a kit and a plugin cannot share a name.`);
  }
  const targetDir = path.join(libraryDir(root), kind, kind === "plugins" ? "" : folder);
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, isAgent ? `${name}.md` : kind === "plugins" ? name : path.basename(from));
  cpSync(from, target, { recursive: true });
  return `${kind}/${name}`;
}

export type TreeAddResult = { added: string[]; skipped: Array<{ entry: string; reason: string }> };

/**
 * Add every skill (or, with kind "agents", every .md agent) found under a
 * directory, keeping its folder structure: adding `/x/network` puts a skill at
 * `/x/network/inspect/foo` into the library folder `network/inspect`. Items the
 * library already has by name are skipped and reported, not treated as failures.
 */
export function addTreeToLibrary(root: string, dir: string, options: { folder?: string; kind?: "agents" | "skills" } = {}): TreeAddResult {
  const base = path.resolve(dir);
  if (!isDirectory(base)) throw new Error(`Not a folder: ${dir}`);
  const kind = options.kind ?? "skills";
  const top = [options.folder ? safeRelative(options.folder) : "", path.basename(base)].filter(Boolean).join("/");
  const found: Array<{ name: string; relFolder: string; source: string }> = [];
  const walk = (current: string, relFolder: string) => {
    for (const entry of readNames(current)) {
      const full = path.join(current, entry);
      if (!isDirectory(full)) {
        if (kind === "agents" && entry.endsWith(".md")) found.push({ name: entry.slice(0, -3), relFolder, source: full });
        continue;
      }
      if (kind === "skills" && existsSync(path.join(full, "SKILL.md"))) found.push({ name: entry, relFolder, source: full });
      else walk(full, relFolder ? `${relFolder}/${entry}` : entry);
    }
  };
  walk(base, "");
  if (found.length === 0) {
    throw new Error(kind === "agents" ? `No agent .md files found under ${dir}.` : `No skills (folders with a SKILL.md) found under ${dir}. For agents, add --agents.`);
  }
  const have = new Set(scanLibrary(root).filter((item) => item.kind === kind).map((item) => item.name));
  const result: TreeAddResult = { added: [], skipped: [] };
  for (const item of found) {
    const entry = `${kind}/${item.name}`;
    if (have.has(item.name)) {
      result.skipped.push({ entry, reason: "the library already has that name" });
      continue;
    }
    const targetFolder = path.join(libraryDir(root), kind, top, item.relFolder);
    mkdirSync(targetFolder, { recursive: true });
    cpSync(item.source, path.join(targetFolder, kind === "agents" ? `${item.name}.md` : item.name), { dereference: true, recursive: true });
    have.add(item.name);
    result.added.push(entry);
  }
  return result;
}

/** Move an item or folder into another library folder ("" or "/" is the top). */
export function moveInLibrary(root: string, entry: string, toFolder: string): void {
  const items = scanLibrary(root);
  const found = resolveEntry(root, items, entry);
  if (found.missing || found.items.length === 0 && !entry.endsWith("/")) throw new Error(`The library has no ${entry}.`);
  const { kind } = parseEntry(entry);
  const destination = path.join(libraryDir(root), kind, toFolder === "/" ? "" : safeRelative(toFolder));
  mkdirSync(destination, { recursive: true });
  const source = entry.endsWith("/")
    ? path.join(libraryDir(root), kind, safeRelative(parseEntry(entry).rest.replace(/\/+$/, "")))
    : found.items[0]!.dir;
  renameSync(source, path.join(destination, path.basename(source)));
}

/** Rename a library folder in place. Kits keep working because a kit names folders by path, so callers update them. */
export function renameLibraryFolder(root: string, folderEntry: string, newName: string): void {
  if (!newName || newName.includes("/")) throw new Error("A folder name has no slash.");
  const { kind, rest } = parseEntry(folderEntry);
  const clean = safeRelative(rest.replace(/\/+$/, ""));
  const from = path.join(libraryDir(root), kind, clean);
  if (!isDirectory(from)) throw new Error(`The library has no folder ${folderEntry}.`);
  renameSync(from, path.join(path.dirname(from), newName));
  const oldPrefix = `${kind}/${clean}`;
  const newPrefix = `${kind}/${path.posix.join(path.posix.dirname(clean) === "." ? "" : path.posix.dirname(clean), newName)}`;
  for (const kit of listKits(root)) {
    const text = readUses(root, kit);
    const rewritten = text.split("\n").map((line) => {
      const trimmed = line.trim();
      if (trimmed === `${oldPrefix}/`) return line.replace(trimmed, `${newPrefix}/`);
      if (trimmed.startsWith(`${oldPrefix}/`)) return line.replace(trimmed, `${newPrefix}/${trimmed.slice(oldPrefix.length + 1)}`);
      return line;
    }).join("\n");
    if (rewritten !== text) writeUses(root, kit, rewritten);
  }
}

/** Move an item to the trash. Returns the kits that used it, so the caller can say so. */
export function removeFromLibrary(root: string, entry: string): { kits: string[] } {
  const items = scanLibrary(root);
  const found = resolveEntry(root, items, entry);
  if (found.missing || found.items.length === 0) throw new Error(`The library has no ${entry}.`);
  const kits = kitsUsingAny(root, found.items);
  mkdirSync(trashDir(root), { recursive: true });
  for (const item of found.items) {
    renameSync(item.dir, path.join(trashDir(root), `${Date.now()}-${item.kind}-${item.name}${item.kind === "agents" ? ".md" : ""}`));
  }
  return { kits };
}

// ------------------------------------------------------------------ entry --

function parseEntry(entry: string): { kind: LibraryKind; rest: string } {
  const match = entryPattern.exec(entry.trim());
  if (!match) throw new Error(`"${entry}" is not a library entry: use skills/<name>, agents/<name>, plugins/<name>, or a folder such as skills/net/.`);
  return { kind: match[1] as LibraryKind, rest: match[2]! };
}

export function resolveEntry(root: string, items: LibraryItem[], entry: string): { items: LibraryItem[]; missing: boolean } {
  let parsed: { kind: LibraryKind; rest: string };
  try {
    parsed = parseEntry(entry);
  } catch {
    return { items: [], missing: true };
  }
  const { kind, rest } = parsed;
  if (rest.endsWith("/")) {
    const folder = rest.replace(/\/+$/, "");
    if (kind === "plugins" || !folder || folder.split("/").includes("..")) return { items: [], missing: true };
    const present = isDirectory(path.join(libraryDir(root), kind, folder));
    const inside = items.filter((item) => item.kind === kind && (item.folder === folder || item.folder.startsWith(`${folder}/`)));
    return { items: inside, missing: !present };
  }
  const named = items.filter((item) => item.kind === kind && item.name === rest);
  return { items: named, missing: named.length === 0 };
}

// ------------------------------------------------------------------- kits --

export function listKits(root: string): string[] {
  return listDirs(kitsDir(root)).filter(isValidKitName);
}

export function createKit(root: string, name: string): void {
  if (!isValidKitName(name)) throw new Error(`"${name}" is not a kit name: lowercase letters, digits and dashes, starting with a letter or digit.`);
  if (existsSync(path.join(kitsDir(root), name))) throw new Error(`A kit named ${name} already exists.`);
  if (scanLibrary(root).some((item) => item.kind === "plugins" && item.name === name)) {
    throw new Error(`${name} is a library plugin's name; a kit is built as a plugin of its own name, so two would clash.`);
  }
  mkdirSync(path.join(kitsDir(root), name), { recursive: true });
  writeFileSync(path.join(kitsDir(root), name, "uses"), "");
}

export function removeKit(root: string, name: string): void {
  const dir = path.join(kitsDir(root), name);
  if (!existsSync(dir)) throw new Error(`No kit named ${name}.`);
  mkdirSync(trashDir(root), { recursive: true });
  renameSync(dir, path.join(trashDir(root), `${Date.now()}-kit-${name}`));
}

export function readUses(root: string, kit: string): string {
  try {
    return readFileSync(path.join(kitsDir(root), kit, "uses"), "utf8");
  } catch {
    return "";
  }
}

/** Replace the file whole or not at all, keeping `#` comments and blank lines as written. */
export function writeUses(root: string, kit: string, text: string): void {
  const file = path.join(kitsDir(root), kit, "uses");
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

export function usesEntries(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

export function useEntries(root: string, kit: string, entries: string[]): void {
  for (const entry of entries) parseEntry(entry);
  const text = readUses(root, kit);
  const have = new Set(usesEntries(text));
  const additions = entries.filter((entry, index) => !have.has(entry) && entries.indexOf(entry) === index);
  if (additions.length === 0) return;
  writeUses(root, kit, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${additions.join("\n")}\n`);
}

export function dropEntries(root: string, kit: string, entries: string[]): void {
  const drop = new Set(entries);
  const text = readUses(root, kit);
  const kept = text.split("\n").filter((line) => !drop.has(line.trim()));
  writeUses(root, kit, kept.join("\n"));
}

export function readInstructions(root: string, kit: string): string | undefined {
  try {
    const text = readFileSync(path.join(kitsDir(root), kit, "CLAUDE.md"), "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

export function writeInstructions(root: string, kit: string, text: string): void {
  writeFileSync(path.join(kitsDir(root), kit, "CLAUDE.md"), text);
}

function kitsUsingAny(root: string, targets: LibraryItem[]): string[] {
  const items = scanLibrary(root);
  const wanted = new Set(targets.map((item) => item.dir));
  return listKits(root).filter((kit) =>
    usesEntries(readUses(root, kit)).some((entry) => resolveEntry(root, items, entry).items.some((item) => wanted.has(item.dir)))
  );
}

// ------------------------------------------------------------------ loads --

/** What a launch with these kits loads. Builds nothing. */
export function planLoads(root: string, kitNames: string[]): LoadsPlan {
  const items = scanLibrary(root);
  const warnings: string[] = [];
  for (const duplicate of duplicateLibraryNames(items)) warnings.push(`The library holds ${duplicate} more than once.`);
  const plugins = new Set<string>();
  const totals = { agents: 0, plugins: 0, skills: 0 };
  const kits: LoadsKit[] = kitNames.map((name) => {
    if (!existsSync(path.join(kitsDir(root), name))) {
      warnings.push(`Kit ${name} does not exist.`);
      return { instructions: false, lines: [], missing: true, name };
    }
    const agentNames = new Map<string, string>();
    const lines: LoadsLine[] = usesEntries(readUses(root, name)).map((entry) => {
      const resolved = resolveEntry(root, items, entry);
      if (resolved.missing) warnings.push(`Kit ${name}: the library no longer has ${entry}.`);
      for (const item of resolved.items) {
        if (item.kind === "agents") {
          const clash = agentNames.get(item.name);
          if (clash && clash !== item.dir) warnings.push(`Kit ${name}: two agents are named ${item.name}.`);
          agentNames.set(item.name, item.dir);
        }
      }
      return {
        entry,
        items: resolved.items.map(({ kind, name: itemName }) => ({ kind, name: itemName })),
        missing: resolved.missing
      };
    });
    for (const line of lines) {
      for (const item of line.items) {
        if (item.kind === "plugins") plugins.add(item.name);
      }
    }
    return { instructions: readInstructions(root, name) !== undefined, lines, missing: false, name };
  });
  const seenSkills = new Set<string>();
  const seenAgents = new Set<string>();
  for (const kit of kits) {
    for (const line of kit.lines) {
      for (const item of line.items) {
        if (item.kind === "skills" && !seenSkills.has(`${kit.name}/${item.name}`)) { seenSkills.add(`${kit.name}/${item.name}`); totals.skills += 1; }
        if (item.kind === "agents" && !seenAgents.has(`${kit.name}/${item.name}`)) { seenAgents.add(`${kit.name}/${item.name}`); totals.agents += 1; }
      }
    }
  }
  totals.plugins = plugins.size;
  return { kits, plugins: [...plugins].sort(), totals, warnings };
}

// ----------------------------------------------------------------- launch --

/**
 * Rebuild each kit into `.build/<kit>/` as a Claude Code plugin and work out
 * the flags a launch needs. Nothing is written into a profile's config dir, so
 * one profile can run with different kits in two terminals.
 */
export function buildLaunchPlan(root: string, kitNames: string[]): LaunchPlan {
  const loads = planLoads(root, kitNames);
  const items = scanLibrary(root);
  const pluginDirs: string[] = [];
  const instructions: Array<{ kit: string; text: string }> = [];

  for (const kit of loads.kits) {
    if (kit.missing) continue;
    const picked = usesEntries(readUses(root, kit.name)).flatMap((entry) => resolveEntry(root, items, entry).items);
    const skills = unique(picked.filter((item) => item.kind === "skills"));
    const agents = unique(picked.filter((item) => item.kind === "agents"));
    const mcp = path.join(kitsDir(root), kit.name, ".mcp.json");
    if (skills.length > 0 || agents.length > 0 || existsSync(mcp)) {
      pluginDirs.push(buildKitPlugin(root, kit.name, skills, agents, existsSync(mcp) ? mcp : undefined));
    }
    const text = readInstructions(root, kit.name);
    if (text) instructions.push({ kit: kit.name, text });
  }
  for (const pluginName of loads.plugins) {
    const plugin = items.find((item) => item.kind === "plugins" && item.name === pluginName);
    if (plugin && !pluginDirs.includes(plugin.dir)) pluginDirs.push(plugin.dir);
  }

  let instructionsFile: string | undefined;
  if (instructions.length > 0) {
    const key = createHash("sha1").update(kitNames.join("+")).digest("hex").slice(0, 12);
    instructionsFile = path.join(buildDir(root), "_instructions", `${key}.md`);
    mkdirSync(path.dirname(instructionsFile), { recursive: true });
    writeFileSync(instructionsFile, instructions.map((entry) => `<!-- kit: ${entry.kit} -->\n${entry.text.trimEnd()}\n`).join("\n"));
  }
  return { ...(instructionsFile ? { instructionsFile } : {}), loads, pluginDirs, warnings: loads.warnings };
}

function buildKitPlugin(root: string, kit: string, skills: LibraryItem[], agents: LibraryItem[], mcpFile: string | undefined): string {
  const out = path.join(buildDir(root), kit);
  rmSync(out, { force: true, recursive: true });
  mkdirSync(path.join(out, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(out, ".claude-plugin", "plugin.json"), `${JSON.stringify({ description: `ccr kit ${kit}`, name: kit, version: "0.0.0" }, null, 2)}\n`);
  if (skills.length > 0) {
    mkdirSync(path.join(out, "skills"), { recursive: true });
    for (const skill of skills) symlinkSync(skill.dir, path.join(out, "skills", skill.name), "dir");
  }
  if (agents.length > 0) {
    mkdirSync(path.join(out, "agents"), { recursive: true });
    for (const agent of agents) cpSync(agent.dir, path.join(out, "agents", `${agent.name}.md`));
  }
  if (mcpFile) cpSync(mcpFile, path.join(out, ".mcp.json"));
  return out;
}

// ---------------------------------------------------------------- helpers --

function unique(items: LibraryItem[]): LibraryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.dir) ? false : (seen.add(item.dir), true)));
}

function safeRelative(value: string): string {
  const clean = value.replace(/^\/+|\/+$/g, "");
  if (clean.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`"${value}" is not a library path.`);
  return clean;
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return [];
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  return readNames(dir).filter((name) => isDirectory(path.join(dir, name)));
}
