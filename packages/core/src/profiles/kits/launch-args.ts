import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIGDIR } from "@ccr/core/config/constants";
import { buildDir, buildLaunchPlan } from "@ccr/core/profiles/kits/kit-store";

export const kitLaunchArgsFileEnv = "CCR_CLAUDE_CODE_KIT_ARGS_FILE";

/** Where the library, kits and built kit plugins live (same layout as a ccs home). */
export function kitStoreRoot(): string {
  return path.join(CONFIGDIR, "claude-kits");
}

function launchArgsFile(root: string, profileKey: string): string {
  const slug = profileKey.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return path.join(buildDir(root), "_launch", `${slug}.json`);
}

/**
 * Rebuild the profile's kits and write the Claude Code flags a launch needs
 * (`--plugin-dir` for each kit and library plugin, `--append-system-prompt-file`
 * for instructions) to a JSON file the wrapper's runtime reads at launch.
 * A file, not an env value, so shell and cmd wrappers need no quoting.
 * Returns undefined, and removes any stale file, when the profile has no kits.
 */
export function writeKitLaunchArgs(
  profileKey: string,
  kits: string[] | undefined,
  root: string = kitStoreRoot()
): { file?: string; warnings: string[] } {
  const file = launchArgsFile(root, profileKey);
  if (!kits || kits.length === 0) {
    rmSync(file, { force: true });
    return { warnings: [] };
  }
  const plan = buildLaunchPlan(root, kits);
  const args = [
    ...plan.pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
    ...(plan.instructionsFile ? ["--append-system-prompt-file", plan.instructionsFile] : [])
  ];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(args)}\n`);
  return { file, warnings: plan.warnings };
}
