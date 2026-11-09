/**
 * Plugins from git. A whole Claude Code plugin can live in the library so a kit
 * can bring it to every profile. The clone stays a git repository, so
 * `update` is a fast-forward pull. The repository root must be the plugin (a
 * marketplace whose plugins live in subfolders is not supported), and it keeps
 * its manifest name and skill prefix.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { addToLibrary, buildDir, isValidKitName, kitsDir, libraryDir, scanLibrary } from "@ccr/core/profiles/kits/kit-store";

const pluginNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The URL to clone for a source, or undefined when it does not look like a git source. */
export function gitSourceUrl(source: string): string | undefined {
  const value = source.trim();
  if (!value || value.startsWith("-")) return undefined;
  if (/^(https?|ssh|git|file):\/\/\S+$/.test(value) || /^[\w.-]+@[\w.-]+:\S+$/.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/, "")}.git`;
  return undefined;
}

/**
 * Add to the library from a local path or from git. A path that exists wins
 * over reading the source as `owner/repo`. Returns the new entry.
 */
export function addToLibraryFromSource(root: string, source: string, options: { folder?: string } = {}): string {
  if (existsSync(path.resolve(source.trim()))) return addToLibrary(root, source.trim(), options);
  const url = gitSourceUrl(source);
  if (!url) return addToLibrary(root, source.trim(), options); // throws "Not found: …"
  return addPluginFromGit(root, url);
}

export function addPluginFromGit(root: string, url: string): string {
  mkdirSync(buildDir(root), { recursive: true });
  // Clone beside the library so the final move is a rename, not a copy across filesystems.
  const staging = path.join(buildDir(root), `_clone-${process.pid}-${Date.now()}`);
  try {
    runGit(["clone", "--depth", "1", "--", url, staging], "git clone");
    const name = manifestName(staging);
    if (!name) {
      throw new Error("The repository root is not a plugin: it has no .claude-plugin/plugin.json. A marketplace whose plugins live in subfolders is not supported yet.");
    }
    if (!pluginNamePattern.test(name)) throw new Error(`The plugin name "${name}" is not usable as a folder name.`);
    if (scanLibrary(root).some((item) => item.kind === "plugins" && item.name === name)) {
      throw new Error(`The library already has plugins/${name}.`);
    }
    if (isValidKitName(name) && existsSync(path.join(kitsDir(root), name))) {
      throw new Error(`A kit is named ${name}; a kit and a plugin cannot share a name.`);
    }
    const target = path.join(libraryDir(root), "plugins", name);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(staging, target);
    return `plugins/${name}`;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

export type PluginUpdateResult = { failed: Array<{ entry: string; message: string }>; unchanged: string[]; updated: string[] };

/** `git pull --ff-only` every plugin that is a git clone (or only `plugins/<name>`). Plugins added from a folder are skipped. */
export function updateLibraryPlugins(root: string, entry?: string): PluginUpdateResult {
  const result: PluginUpdateResult = { failed: [], unchanged: [], updated: [] };
  const plugins = scanLibrary(root).filter((item) => item.kind === "plugins");
  const wanted = entry ? plugins.filter((item) => `plugins/${item.name}` === entry) : plugins;
  if (entry && wanted.length === 0) throw new Error(`The library has no ${entry}.`);
  for (const plugin of wanted) {
    const label = `plugins/${plugin.name}`;
    if (!existsSync(path.join(plugin.dir, ".git"))) continue;
    try {
      const before = runGit(["rev-parse", "HEAD"], "git", plugin.dir).trim();
      runGit(["pull", "--ff-only", "--quiet"], "git pull", plugin.dir);
      const after = runGit(["rev-parse", "HEAD"], "git", plugin.dir).trim();
      (after === before ? result.unchanged : result.updated).push(label);
    } catch (error) {
      result.failed.push({ entry: label, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function manifestName(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function runGit(args: string[], what: string, cwd?: string): string {
  try {
    return execFileSync("git", args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new Error("git is not installed, so plugins cannot be added or updated from git.");
    const stderr = String(failure.stderr ?? failure.message);
    // GitHub answers a repository that does not exist (or is private) by asking for a login, which is switched off here.
    if (/terminal prompts disabled|could not read Username|Repository not found/i.test(stderr)) {
      throw new Error(`${what} failed: the repository does not exist, or it is private and needs credentials (git cannot ask for them here).`);
    }
    const detail = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    throw new Error(`${what} failed: ${detail}`);
  }
}
