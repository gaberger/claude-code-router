import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isKitCliCommand, runKitCli } from "@ccr/core/profiles/kits/kit-cli.ts";

function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-kit-cli-"));
  const lines = [];
  const profiles = { work: ["base"], bare: [] };
  const settings = { work: { model: "m", permissions: { allow: ["Read"] } }, bare: {} };
  const edited = [];
  const host = {
    claudeSettings: (ref) => { if (!(ref in settings)) throw new Error(`Profile not found: ${ref}`); return settings[ref]; },
    setClaudeSettings: async (ref, next) => { settings[ref] = next; },
    editFile: async (file) => { edited.push(file); },
    out: (line) => lines.push(line),
    profileKits: (ref) => { if (!(ref in profiles)) throw new Error(`Profile not found: ${ref}`); return [...profiles[ref]]; },
    root,
    setProfileKits: async (ref, kits) => { profiles[ref] = kits; },
    soleProfile: () => undefined
  };
  const run = (...argv) => runKitCli(argv, host);
  return { edited, host, lines, profiles, root, run, settings, done: () => rmSync(root, { force: true, recursive: true }) };
}
const write = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

test("only library, kit and loads are kit commands", () => {
  for (const word of ["library", "kit", "loads", "permissions", "perms", "doctor"]) assert.equal(isKitCliCommand(word), true);
  for (const word of ["start", "work", undefined]) assert.equal(isKitCliCommand(word), false);
});

test("library add/list/mkdir/mv/rm drive the store and report which kits a delete affects", async () => {
  const t = harness();
  try {
    write(path.join(t.root, "incoming", "find", "SKILL.md"));
    await t.run("library", "mkdir", "skills/net");
    await t.run("library", "add", path.join(t.root, "incoming", "find"), "--in", "net");
    await t.run("library", "list");
    assert.ok(t.lines.includes("Added skills/find"));
    assert.ok(t.lines.includes("skills/net/find"));

    await t.run("kit", "new", "k");
    await t.run("kit", "use", "k", "skills/find");
    t.lines.length = 0;
    await t.run("library", "rm", "skills/find");
    assert.deepEqual(t.lines, ["Moved skills/find to the trash.", "Kits that used it: k. They now warn about the missing entry."]);
  } finally { t.done(); }
});

test("library add/update: a source that is neither a path nor a repo is explained, and update says when nothing came from git", async () => {
  const t = harness();
  try {
    await assert.rejects(t.run("library", "add", "nothing-here"), /Not found: nothing-here/);
    await assert.rejects(t.run("library", "edit", "skills/x"), /not built yet/);
    t.lines.length = 0;
    await t.run("library", "update");
    assert.deepEqual(t.lines, ["No plugins were added from git, so there is nothing to update."]);
    await assert.rejects(t.run("library", "update", "plugins/ghost"), /no plugins\/ghost/);
  } finally { t.done(); }
});

test("kit show and loads print each line with its items, totals and warnings", async () => {
  const t = harness();
  try {
    write(path.join(t.root, "library", "skills", "net", "a", "SKILL.md"));
    write(path.join(t.root, "library", "skills", "net", "b", "SKILL.md"));
    write(path.join(t.root, "library", "agents", "rev.md"));
    write(path.join(t.root, "library", "plugins", "egm", ".claude-plugin", "plugin.json"), '{"name":"egm"}');
    await t.run("kit", "new", "base");
    await t.run("kit", "use", "base", "skills/net/", "agents/rev", "plugins/egm", "skills/ghost");
    write(path.join(t.root, "kits", "base", "CLAUDE.md"), "hi");

    t.lines.length = 0;
    await t.run("loads", "work");
    assert.deepEqual(t.lines, [
      "work loads 1 kit: base",
      "",
      "kit base",
      "  instructions (CLAUDE.md)",
      "  skills/net/  folder · 2 skills",
      "    a",
      "    b",
      "  agents/rev  agent",
      "  plugins/egm  plugin",
      "  skills/ghost  missing from the library",
      "",
      "total: 2 skills, 1 agents, 1 plugins",
      "warning: Kit base: the library no longer has skills/ghost."
    ]);
  } finally { t.done(); }
});

test("kit attach and detach edit the profile's kits, keep order, and say when nothing changed", async () => {
  const t = harness();
  try {
    await t.run("kit", "new", "net");
    await t.run("kit", "attach", "net", "work");
    assert.deepEqual(t.profiles.work, ["base", "net"]);
    t.lines.length = 0;
    await t.run("kit", "attach", "net", "work");
    assert.deepEqual(t.lines, ["work already has kit net."]);
    await t.run("kit", "detach", "net", "work");
    assert.deepEqual(t.profiles.work, ["base"]);
    await assert.rejects(t.run("kit", "attach", "nope", "work"), /No kit named nope/);
    await assert.rejects(t.run("kit", "attach", "net", "ghost"), /Profile not found: ghost/);
    await t.run("loads", "bare");
    assert.equal(t.lines.at(-1), "bare loads no kits.");
  } finally { t.done(); }
});

test("kit edit creates the instructions file and hands it to the editor; bad usage is explained", async () => {
  const t = harness();
  try {
    await t.run("kit", "new", "net");
    await t.run("kit", "edit", "net");
    assert.deepEqual(t.edited, [path.join(t.root, "kits", "net", "CLAUDE.md")]);
    assert.ok(existsSync(t.edited[0]));
    await assert.rejects(t.run("kit", "edit", "ghost"), /No kit named ghost/);
    await assert.rejects(t.run("kit", "new"), /Usage: ccr kit new <name>/);
    await assert.rejects(t.run("kit", "use", "net"), /Usage: ccr kit use/);
    await assert.rejects(t.run("kit", "wat"), /Usage: ccr kit list/);
    await assert.rejects(t.run("loads"), /Usage: ccr loads <profile>/);
  } finally { t.done(); }
});

test("ccr permissions edits the named profile, accepts the perms alias, and defaults to the only profile", async () => {
  const t = harness();
  try {
    await t.run("permissions", "work", "add", "Glob");
    assert.deepEqual(t.settings.work.permissions.allow, ["Read", "Glob"]);
    assert.equal(t.settings.work.model, "m");
    t.lines.length = 0;
    await t.run("perms", "work", "mode", "plan");
    assert.equal(t.settings.work.permissions.defaultMode, "plan");
    assert.deepEqual(t.lines, ["Mode is plan."]);

    t.lines.length = 0;
    await t.run("permissions", "work");
    assert.deepEqual(t.lines, ["mode: plan", "allow (2):", "  Read", "  Glob"]);

    // nothing to change: the profile is not rewritten
    const before = t.settings.work;
    await t.run("permissions", "work", "rm", "Nope");
    assert.equal(t.settings.work, before);

    await assert.rejects(t.run("permissions", "ghost", "show"), /Profile not found: ghost/);
    await assert.rejects(t.run("permissions", "add", "Read"), /Usage: ccr permissions/);
    t.host.soleProfile = () => "work";
    await t.run("permissions", "add", "Grep");
    assert.deepEqual(t.settings.work.permissions.allow, ["Read", "Glob", "Grep"]);
  } finally { t.done(); }
});

test("ccr doctor reports ok/warn/FAIL and fails the run only on a failure", async () => {
  const t = harness();
  try {
    write(path.join(t.root, "library", "skills", "real", "SKILL.md"));
    write(path.join(t.root, "library", "plugins", "bare-plugin", "x.txt"));
    await t.run("kit", "new", "base");
    await t.run("kit", "use", "base", "skills/real", "skills/gone");

    t.lines.length = 0;
    await t.run("doctor", "work");
    assert.deepEqual(t.lines, [
      "warn  plugins/bare-plugin has no .claude-plugin/plugin.json, so it is named after its folder.",
      "warn  Kit base: the library no longer has skills/gone.",
      "ok    Library: 1 skills, 0 agents, 1 plugins; 1 kit.",
      "ok    work: kit base exists.",
      "ok    work: 1 permission rule, mode default."
    ]);

    t.profiles.work = ["base", "ghost"];
    t.settings.work = { permissions: "yes" };
    t.lines.length = 0;
    await assert.rejects(t.run("doctor", "work"), /2 problems found\./);
    assert.ok(t.lines.some((line) => line.startsWith("FAIL  work: kit ghost does not exist. Remove it with: ccr kit detach ghost work")));
    assert.ok(t.lines.some((line) => /^FAIL  work: `permissions`.*not an object/.test(line)));

    // a kit named like a library plugin clashes
    write(path.join(t.root, "library", "plugins", "egm", ".claude-plugin", "plugin.json"), '{"name":"egm"}');
    write(path.join(t.root, "kits", "egm", "uses"), "");
    t.lines.length = 0;
    await assert.rejects(t.run("doctor"), /problem/);
    assert.ok(t.lines.some((line) => /FAIL  Kit egm has the name of a library plugin/.test(line)));
  } finally { t.done(); }
});
