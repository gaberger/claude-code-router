import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseProfilesForTest } from "@ccr/core/config/config.ts";
import { createKit, useEntries, writeInstructions } from "@ccr/core/profiles/kits/kit-store.ts";
import { writeKitLaunchArgs } from "@ccr/core/profiles/kits/launch-args.ts";

function withRoot(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-kit-launch-"));
  try { return run(root); } finally { rmSync(root, { force: true, recursive: true }); }
}
const write = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

test("kit launch args file lists --plugin-dir per kit and plugin, then the instructions file", () => withRoot((root) => {
  write(path.join(root, "library", "skills", "find", "SKILL.md"));
  write(path.join(root, "library", "plugins", "egm", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "egm" }));
  createKit(root, "net");
  useEntries(root, "net", ["skills/find", "plugins/egm"]);
  writeInstructions(root, "net", "Be terse.\n");

  const { file, warnings } = writeKitLaunchArgs("My Claude Profile", ["net"], root);
  assert.deepEqual(warnings, []);
  assert.match(file, /_launch\/my-claude-profile\.json$/);
  const args = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(args.slice(0, 4), ["--plugin-dir", path.join(root, ".build", "net"), "--plugin-dir", path.join(root, "library", "plugins", "egm")]);
  assert.equal(args[4], "--append-system-prompt-file");
  assert.match(readFileSync(args[5], "utf8"), /Be terse\./);
}));

test("a profile with no kits gets no file and loses a stale one", () => withRoot((root) => {
  write(path.join(root, "library", "skills", "find", "SKILL.md"));
  createKit(root, "net"); useEntries(root, "net", ["skills/find"]);
  const { file } = writeKitLaunchArgs("p", ["net"], root);
  assert.ok(existsSync(file));
  assert.equal(writeKitLaunchArgs("p", [], root).file, undefined);
  assert.equal(existsSync(file), false);
}));

test("a Claude Code profile keeps valid kit names, once each, and drops the rest", () => {
  const [profile] = parseProfilesForTest([{
    agent: "claude-code", enabled: true, id: "p", kits: ["net", "net", "Bad Name", "dev", 7], model: "m", name: "P"
  }]);
  assert.deepEqual(profile.kits, ["net", "dev"]);
  const [plain] = parseProfilesForTest([{ agent: "claude-code", enabled: true, id: "q", model: "m", name: "Q" }]);
  assert.equal("kits" in plain, false);
});

test("permissions kept in a profile's claudeSettings survive the config parser (the store `ccr permissions` writes to)", () => {
  const [profile] = parseProfilesForTest([{
    agent: "claude-code", claudeSettings: { model: "m", permissions: { allow: ["Read", "Bash(git:*)"], defaultMode: "acceptEdits" } },
    enabled: true, id: "p", model: "m", name: "P"
  }]);
  assert.deepEqual(profile.claudeSettings.permissions, { allow: ["Read", "Bash(git:*)"], defaultMode: "acceptEdits" });
  assert.deepEqual(Object.keys(profile.claudeSettings), ["model", "permissions"]);
});
