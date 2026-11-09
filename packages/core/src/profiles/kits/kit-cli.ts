/**
 * `ccr library …`, `ccr kit …` and `ccr loads`: the command line over the
 * kit store. Everything that touches the outside world comes in through
 * `KitCliHost`, so the commands are testable without a config, an editor or a
 * terminal.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPermissions, runPermissions, permissionsUsage } from "@ccr/core/profiles/kits/permissions";
import {
  addToLibrary, createKit, dropEntries, kitsDir, listKits, makeLibraryFolder, moveInLibrary, planLoads,
  readUses, removeFromLibrary, removeKit, renameLibraryFolder, resolveEntry, scanLibrary, useEntries,
  usesEntries, libraryKinds, type LibraryKind, type LoadsKit, type LoadsPlan
} from "@ccr/core/profiles/kits/kit-store";

export type KitCliHost = {
  /** Open a file in the user's editor and wait. */
  editFile(file: string): Promise<void>;
  out(line: string): void;
  /** A Claude Code profile's own settings (merged into its generated settings.json). Throws when the profile is unknown. */
  claudeSettings(profileRef: string): Record<string, unknown>;
  /** Kits attached to a Claude Code profile (name or id). Throws when the profile is unknown. */
  profileKits(profileRef: string): string[];
  /** Name of the profile `loads` uses when none is given, if there is exactly one. */
  soleProfile(): string | undefined;
  root: string;
  setClaudeSettings(profileRef: string, settings: Record<string, unknown>): Promise<void>;
  setProfileKits(profileRef: string, kits: string[]): Promise<void>;
};

export const kitCliCommands = ["library", "kit", "loads", "permissions", "perms", "doctor"] as const;

export function isKitCliCommand(word: string | undefined): boolean {
  return (kitCliCommands as readonly string[]).includes(word ?? "");
}

export async function runKitCli(argv: string[], host: KitCliHost): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "library") return runLibrary(rest, host);
  if (command === "kit") return runKit(rest, host);
  if (command === "loads") return runLoads(rest, host);
  if (command === "permissions" || command === "perms") return runPermissionsCommand(rest, host);
  if (command === "doctor") return runDoctor(rest, host);
  throw new Error(`Unknown command: ${command ?? ""}`);
}

export function kitCliHelp(): string {
  return [
    "ccr library list [skills|agents|plugins]",
    "            add <path> [--in <folder>]    a skill folder, an agent .md file, or a plugin folder",
    "            mkdir skills/<folder> | mv <entry> <folder|/> | rename skills/<folder>/ <name>",
    "            rm <entry> | show <entry>",
    "ccr kit     list | new <k> | rm <k> | show <k> | edit <k>",
    "            use <k> <entry>… | drop <k> <entry>…",
    "            attach <k> <profile> | detach <k> <profile>",
    "ccr loads [<profile>]                    what a launch loads, kit by kit; builds nothing",
    "ccr doctor [<profile>]                   check the library, kits and a profile; exits 1 on a failure",
    `${permissionsUsage}`,
    "                                         what a profile's claude may do without asking",
    "ccr <profile> +<kit>… [args…]            start the profile with these kits for this run only",
    "",
    "An entry is skills/<name>, agents/<name>, plugins/<name>, or a folder such as skills/net/."
  ].join("\n");
}

// ---------------------------------------------------------------- library --

async function runLibrary(args: string[], host: KitCliHost): Promise<void> {
  const [action, ...rest] = args;
  const { root, out } = host;
  switch (action) {
    case "list": {
      const filter = rest[0] as LibraryKind | undefined;
      if (filter && !libraryKinds.includes(filter)) throw new Error("Usage: ccr library list [skills|agents|plugins]");
      const items = scanLibrary(root).filter((item) => !filter || item.kind === filter);
      if (items.length === 0) out("The library is empty. Add to it with: ccr library add <path>");
      for (const item of items) out(`${item.kind}/${item.folder ? `${item.folder}/` : ""}${item.name}`);
      return;
    }
    case "add": {
      const inIndex = rest.indexOf("--in");
      const folder = inIndex >= 0 ? rest[inIndex + 1] : undefined;
      if (inIndex >= 0 && !folder) throw new Error("--in needs a folder name.");
      const positional = inIndex >= 0 ? rest.filter((_, index) => index !== inIndex && index !== inIndex + 1) : rest;
      const source = positional[0];
      if (!source) throw new Error("Usage: ccr library add <path> [--in <folder>]");
      if (/^[\w.-]+\/[\w.-]+$/.test(source) && !existsSync(source)) {
        throw new Error("Adding from GitHub or a git URL is not built yet. Clone it and add the folder: ccr library add <path>");
      }
      out(`Added ${addToLibrary(root, source, folder ? { folder } : {})}`);
      return;
    }
    case "mkdir": {
      if (!rest[0]) throw new Error("Usage: ccr library mkdir skills/<folder>");
      makeLibraryFolder(root, rest[0]);
      out(`Made ${rest[0]}`);
      return;
    }
    case "mv": {
      if (rest.length !== 2) throw new Error("Usage: ccr library mv <entry> <folder|/>");
      moveInLibrary(root, rest[0]!, rest[1]!);
      out(`Moved ${rest[0]} to ${rest[1]}`);
      return;
    }
    case "rename": {
      if (rest.length !== 2) throw new Error("Usage: ccr library rename skills/<folder>/ <name>");
      renameLibraryFolder(root, rest[0]!, rest[1]!);
      out(`Renamed ${rest[0]} to ${rest[1]}; kits that used it follow.`);
      return;
    }
    case "rm": {
      if (!rest[0]) throw new Error("Usage: ccr library rm <entry>");
      const { kits } = removeFromLibrary(root, rest[0]);
      out(`Moved ${rest[0]} to the trash.`);
      if (kits.length > 0) out(`Kits that used it: ${kits.join(", ")}. They now warn about the missing entry.`);
      return;
    }
    case "show": {
      if (!rest[0]) throw new Error("Usage: ccr library show <entry>");
      const found = resolveEntry(root, scanLibrary(root), rest[0]);
      if (found.missing) throw new Error(`The library has no ${rest[0]}.`);
      for (const item of found.items) out(`${item.kind}/${item.folder ? `${item.folder}/` : ""}${item.name}  ${item.dir}`);
      return;
    }
    case "edit":
    case "update":
      throw new Error(`ccr library ${action} is not built yet.`);
    default:
      throw new Error(`Usage: ccr library list | add | mkdir | mv | rename | rm | show\n\n${kitCliHelp()}`);
  }
}

// -------------------------------------------------------------------- kit --

async function runKit(args: string[], host: KitCliHost): Promise<void> {
  const [action, name, ...rest] = args;
  const { root, out } = host;
  switch (action) {
    case "list": {
      const kits = listKits(root);
      if (kits.length === 0) out("No kits. Make one with: ccr kit new <name>");
      for (const kit of kits) out(`${kit}  (${usesEntries(readUses(root, kit)).length} lines)`);
      return;
    }
    case "new": {
      requireName(name, "ccr kit new <name>");
      createKit(root, name!);
      out(`Made kit ${name}. Add to it with: ccr kit use ${name} <entry>…`);
      return;
    }
    case "rm": {
      requireName(name, "ccr kit rm <name>");
      removeKit(root, name!);
      out(`Moved kit ${name} to the trash.`);
      return;
    }
    case "show": {
      requireName(name, "ccr kit show <name>");
      printLoads(planLoads(root, [name!]), out, { header: false });
      return;
    }
    case "edit": {
      requireName(name, "ccr kit edit <name>");
      if (!existsSync(path.join(kitsDir(root), name!))) throw new Error(`No kit named ${name}.`);
      const file = path.join(kitsDir(root), name!, "CLAUDE.md");
      if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "");
      }
      await host.editFile(file);
      return;
    }
    case "use": {
      requireName(name, "ccr kit use <name> <entry>…");
      if (rest.length === 0) throw new Error("Usage: ccr kit use <name> <entry>…");
      useEntries(root, name!, rest);
      out(`Kit ${name} now uses: ${rest.join(" ")}`);
      return;
    }
    case "drop": {
      requireName(name, "ccr kit drop <name> <entry>…");
      if (rest.length === 0) throw new Error("Usage: ccr kit drop <name> <entry>…");
      dropEntries(root, name!, rest);
      out(`Kit ${name} no longer uses: ${rest.join(" ")}`);
      return;
    }
    case "attach":
    case "detach": {
      const [profile] = rest;
      if (!name || !profile) throw new Error(`Usage: ccr kit ${action} <kit> <profile>`);
      if (!listKits(root).includes(name)) throw new Error(`No kit named ${name}.`);
      const current = host.profileKits(profile);
      const next = action === "attach"
        ? current.includes(name) ? current : [...current, name]
        : current.filter((kit) => kit !== name);
      if (next.join() === current.join()) {
        out(`${profile} already ${action === "attach" ? "has" : "lacks"} kit ${name}.`);
        return;
      }
      await host.setProfileKits(profile, next);
      out(`${profile} now loads: ${next.length > 0 ? next.map((kit) => `+${kit}`).join(" ") : "no kits"}`);
      return;
    }
    default:
      throw new Error(`Usage: ccr kit list | new | rm | show | edit | use | drop | attach | detach\n\n${kitCliHelp()}`);
  }
}

function requireName(name: string | undefined, usage: string): void {
  if (!name) throw new Error(`Usage: ${usage}`);
}

// ------------------------------------------------------------------ loads --

async function runLoads(args: string[], host: KitCliHost): Promise<void> {
  const ref = args[0] ?? host.soleProfile();
  if (!ref) throw new Error("Usage: ccr loads <profile>  (there is more than one Claude Code profile, or none)");
  const kits = host.profileKits(ref);
  const plan = planLoads(host.root, kits);
  host.out(kits.length === 0
    ? `${ref} loads no kits.`
    : `${ref} loads ${kits.length} kit${kits.length === 1 ? "" : "s"}: ${kits.join(" ")}`);
  printLoads(plan, host.out, { header: true });
}

export function printLoads(plan: LoadsPlan, out: (line: string) => void, options: { header: boolean }): void {
  for (const kit of plan.kits) {
    if (options.header) out("");
    out(`kit ${kit.name}${kit.missing ? "  (does not exist)" : ""}`);
    printKit(kit, out);
  }
  if (options.header && plan.kits.length > 0) {
    out("");
    out(`total: ${plan.totals.skills} skills, ${plan.totals.agents} agents, ${plan.totals.plugins} plugins`);
  }
  for (const warning of plan.warnings) out(`warning: ${warning}`);
}

function printKit(kit: LoadsKit, out: (line: string) => void): void {
  if (kit.instructions) out("  instructions (CLAUDE.md)");
  for (const line of kit.lines) {
    if (line.missing) {
      out(`  ${line.entry}  missing from the library`);
      continue;
    }
    const folder = line.entry.endsWith("/");
    const kind = line.items[0]?.kind;
    const label = folder
      ? `folder · ${line.items.length} ${kind === "agents" ? "agent" : "skill"}${line.items.length === 1 ? "" : "s"}`
      : kind === "plugins" ? "plugin" : kind === "agents" ? "agent" : "skill";
    out(`  ${line.entry}  ${label}`);
    if (folder) for (const item of line.items) out(`    ${item.name}`);
  }
}

// ------------------------------------------------------------ permissions --

const permissionActions = ["show", "add", "rm", "mode"];

async function runPermissionsCommand(args: string[], host: KitCliHost): Promise<void> {
  const hasProfile = args.length > 0 && !permissionActions.includes(args[0]!);
  const ref = hasProfile ? args[0] : host.soleProfile();
  if (!ref) throw new Error(`Usage: ${permissionsUsage}  (there is more than one Claude Code profile, or none)`);
  const result = runPermissions(host.claudeSettings(ref), hasProfile ? args.slice(1) : args);
  if (result.changed) await host.setClaudeSettings(ref, result.settings);
  for (const line of result.lines) host.out(line);
}

// ----------------------------------------------------------------- doctor --

type Check = { level: "fail" | "ok" | "warn"; text: string };

async function runDoctor(args: string[], host: KitCliHost): Promise<void> {
  const { root } = host;
  const checks: Check[] = [];
  const items = scanLibrary(root);
  const kits = listKits(root);
  const plan = planLoads(root, kits);

  for (const plugin of items.filter((item) => item.kind === "plugins")) {
    if (!existsSync(path.join(plugin.dir, ".claude-plugin", "plugin.json"))) {
      checks.push({ level: "warn", text: `plugins/${plugin.name} has no .claude-plugin/plugin.json, so it is named after its folder.` });
    }
  }
  for (const kit of kits) {
    if (items.some((item) => item.kind === "plugins" && item.name === kit)) {
      checks.push({ level: "fail", text: `Kit ${kit} has the name of a library plugin; both are built as a plugin of that name.` });
    }
  }
  for (const warning of plan.warnings) checks.push({ level: "warn", text: warning });
  checks.push({
    level: "ok",
    text: `Library: ${items.filter((i) => i.kind === "skills").length} skills, ${items.filter((i) => i.kind === "agents").length} agents, ${items.filter((i) => i.kind === "plugins").length} plugins; ${kits.length} kit${kits.length === 1 ? "" : "s"}.`
  });

  const ref = args[0] ?? host.soleProfile();
  if (ref) {
    const attached = host.profileKits(ref);
    for (const kit of attached) {
      checks.push(kits.includes(kit)
        ? { level: "ok", text: `${ref}: kit ${kit} exists.` }
        : { level: "fail", text: `${ref}: kit ${kit} does not exist. Remove it with: ccr kit detach ${kit} ${ref}` });
    }
    try {
      const { allow, mode } = readPermissions(host.claudeSettings(ref));
      checks.push({ level: "ok", text: `${ref}: ${allow.length} permission rule${allow.length === 1 ? "" : "s"}, mode ${mode ?? "default"}.` });
    } catch (error) {
      checks.push({ level: "fail", text: `${ref}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  const label = { fail: "FAIL", ok: "ok  ", warn: "warn" } as const;
  for (const check of checks) host.out(`${label[check.level]}  ${check.text}`);
  const failures = checks.filter((check) => check.level === "fail").length;
  if (failures > 0) throw new Error(`${failures} problem${failures === 1 ? "" : "s"} found.`);
}
