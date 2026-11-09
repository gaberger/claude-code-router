/**
 * `ccr permissions`: what a Claude Code profile's sessions may do without
 * asking. Pure functions over the profile's `claudeSettings`, which CCR merges
 * into the settings.json it generates for the profile.
 *
 * Existing rules keep their order and are never repeated; every other key is
 * left exactly as it was. Only `permissions.allow` and `permissions.defaultMode`
 * are edited (deny/ask lists are not).
 */

export const permissionModes = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] as const;
export type PermissionMode = (typeof permissionModes)[number];

type Settings = Record<string, unknown>;

/** The `dev` preset: a broad read/build/inspect rule set, and mode acceptEdits. */
export const devPermissionPreset: { mode: PermissionMode; rules: string[] } = {
  mode: "acceptEdits",
  rules: [
    "Bash(git:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(grep:*)", "Bash(rg:*)",
    "Bash(find:*)", "Bash(sed -n:*)", "Bash(diff:*)", "Bash(jq:*)", "Bash(stat:*)", "Bash(which:*)", "Bash(ps:*)", "Bash(ss:*)",
    "Bash(df:*)", "Bash(du:*)", "Bash(free:*)", "Bash(journalctl:*)", "Bash(systemctl status:*)", "Bash(curl:*)", "Bash(docker:*)",
    "Bash(tt-smi:*)", "Bash(tt-toplike:*)", "Bash(weave:*)", "Bash(herdr:*)", "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)",
    "Bash(uv:*)", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(make:*)", "Bash(cargo:*)", "Bash(go:*)", "Bash(pytest:*)",
    "Bash(mkdir:*)", "Bash(touch:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(echo:*)", "Bash(gh:*)", "Read", "Glob", "Grep", "WebFetch",
    "WebSearch"
  ]
};

export function permissionPreset(name: string): { mode: PermissionMode; rules: string[] } | undefined {
  return name === "dev" ? devPermissionPreset : undefined;
}

/** A rule Claude Code can read: `Tool` or `Tool(specifier)`, on one line. */
export function checkPermissionRule(rule: string): void {
  const bad = (why: string) => new Error(`'${JSON.stringify(rule).slice(1, -1)}' is not a permission rule: ${why} (like Read, or Bash(git:*))`);
  if (rule === "" || rule.trim() !== rule) throw bad("empty, or spaces at an end");
  if (/[\u0000-\u001f\u007f]/.test(rule)) throw bad("a control character");
  if (!/^[A-Za-z]/.test(rule)) throw bad("it starts with a tool name");
  if (rule.includes("(") !== rule.endsWith(")")) throw bad("unbalanced parentheses");
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (permissionModes as readonly string[]).includes(value);
}

export type PermissionsResult = { changed: boolean; lines: string[]; settings: Settings };

export const permissionsUsage =
  "ccr permissions [<profile>] [show | add <rule>… | add --preset dev | rm <rule>… | mode <default|acceptEdits|plan|dontAsk|bypassPermissions>]";

export function readPermissions(settings: Settings): { allow: string[]; mode?: string } {
  const permissions = settings.permissions;
  if (permissions === undefined) return { allow: [] };
  if (!isRecord(permissions)) {
    throw new Error("`permissions` in this profile's settings is not an object, so it was left alone. Fix it first.");
  }
  const allow = permissions.allow;
  if (allow !== undefined && !(Array.isArray(allow) && allow.every((rule) => typeof rule === "string"))) {
    throw new Error("`permissions.allow` in this profile's settings is not a list of rules, so it was left alone. Fix it first.");
  }
  const mode = permissions.defaultMode;
  return { allow: (allow as string[] | undefined) ?? [], ...(typeof mode === "string" ? { mode } : {}) };
}

/** Apply `show | add | rm | mode` (args after the profile name) to a profile's settings. */
export function runPermissions(settings: Settings, args: string[]): PermissionsResult {
  const current = readPermissions(settings);
  const [action = "show", ...rest] = args;

  if (action === "show" && rest.length === 0) {
    return {
      changed: false,
      lines: [
        `mode: ${current.mode ?? "default"}`,
        current.allow.length === 0 ? "allow: (none)" : `allow (${current.allow.length}):`,
        ...current.allow.map((rule) => `  ${rule}`)
      ],
      settings
    };
  }

  if (action === "add") {
    const presetIndex = rest.indexOf("--preset");
    let rules = rest;
    let mode: PermissionMode | undefined;
    if (presetIndex >= 0) {
      const name = rest[presetIndex + 1];
      const preset = name ? permissionPreset(name) : undefined;
      if (!preset) throw new Error(`No preset '${name ?? ""}'; there is: dev`);
      rules = [...rest.slice(0, presetIndex), ...rest.slice(presetIndex + 2), ...preset.rules];
      mode = preset.mode;
    }
    if (rules.length === 0) throw new Error(`Usage: ${permissionsUsage}`);
    rules.forEach(checkPermissionRule);
    const allow = withRules(current.allow, rules);
    const added = allow.length - current.allow.length;
    const next = setPermissions(settings, { allow, ...(mode ? { defaultMode: mode } : {}) });
    const modeChanged = mode !== undefined && mode !== current.mode;
    return {
      changed: added > 0 || modeChanged,
      lines: [`Added ${added} rule${added === 1 ? "" : "s"}${modeChanged ? `; mode ${mode}` : ""}.`],
      settings: next
    };
  }

  if (action === "rm") {
    if (rest.length === 0) throw new Error(`Usage: ${permissionsUsage}`);
    const allow = current.allow.filter((rule) => !rest.includes(rule));
    const removed = current.allow.length - allow.length;
    return {
      changed: removed > 0,
      lines: [`Removed ${removed} rule${removed === 1 ? "" : "s"}.`],
      settings: removed > 0 ? setPermissions(settings, { allow }) : settings
    };
  }

  if (action === "mode") {
    const [mode] = rest;
    if (!mode) throw new Error(`Usage: ${permissionsUsage}`);
    if (!isPermissionMode(mode)) throw new Error(`'${mode}' is not a mode: ${permissionModes.join(", ")}`);
    return {
      changed: mode !== current.mode,
      lines: [`Mode is ${mode}.`],
      settings: mode !== current.mode ? setPermissions(settings, { defaultMode: mode }) : settings
    };
  }

  throw new Error(`Usage: ${permissionsUsage}`);
}

/** `rules` appended to `have`: existing order kept, nothing twice. */
export function withRules(have: string[], rules: string[]): string[] {
  const out = [...have];
  for (const rule of rules) if (!out.includes(rule)) out.push(rule);
  return out;
}

/** Merge into `permissions`, keeping every other key, and its position, as it was. */
function setPermissions(settings: Settings, patch: { allow?: string[]; defaultMode?: string }): Settings {
  const existing = isRecord(settings.permissions) ? settings.permissions : {};
  return { ...settings, permissions: { ...existing, ...patch } };
}

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
