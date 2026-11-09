import assert from "node:assert/strict";
import test from "node:test";
import { checkPermissionRule, devPermissionPreset, runPermissions, withRules } from "@ccr/core/profiles/kits/permissions.ts";

const rules = (settings) => settings.permissions?.allow;

test("add appends once, keeps order, and leaves every other key where it was", () => {
  const settings = { model: "m", permissions: { allow: ["Read", "Bash(ls:*)"], defaultMode: "plan" }, theme: "dark" };
  const result = runPermissions(settings, ["add", "Bash(make:*)", "Read", "Glob"]);
  assert.deepEqual(rules(result.settings), ["Read", "Bash(ls:*)", "Bash(make:*)", "Glob"]);
  assert.deepEqual(Object.keys(result.settings), ["model", "permissions", "theme"]);
  assert.equal(result.settings.permissions.defaultMode, "plan", "plain add leaves the mode alone");
  assert.equal(result.changed, true);
  assert.deepEqual(result.lines, ["Added 2 rules."]);
  assert.deepEqual(settings.permissions.allow, ["Read", "Bash(ls:*)"], "the input is not mutated");
});

test("the dev preset adds its rules and sets its mode, and a second run adds nothing", () => {
  const first = runPermissions({}, ["add", "--preset", "dev"]);
  assert.equal(first.settings.permissions.defaultMode, "acceptEdits");
  assert.deepEqual(rules(first.settings), devPermissionPreset.rules);
  assert.ok(first.settings.permissions.allow.includes("Bash(herdr:*)"));
  const again = runPermissions(first.settings, ["add", "--preset", "dev"]);
  assert.equal(again.changed, false);
  assert.deepEqual(again.lines, ["Added 0 rules."]);
  assert.throws(() => runPermissions({}, ["add", "--preset", "nope"]), /No preset 'nope'; there is: dev/);
});

test("rm, mode and show", () => {
  const settings = { permissions: { allow: ["Read", "Glob"] } };
  const removed = runPermissions(settings, ["rm", "Read", "Missing"]);
  assert.deepEqual(rules(removed.settings), ["Glob"]);
  assert.deepEqual(removed.lines, ["Removed 1 rule."]);
  assert.equal(runPermissions(settings, ["rm", "Nope"]).changed, false);

  assert.equal(runPermissions(settings, ["mode", "plan"]).settings.permissions.defaultMode, "plan");
  assert.throws(() => runPermissions(settings, ["mode", "yolo"]), /'yolo' is not a mode: default, acceptEdits/);

  assert.deepEqual(runPermissions(settings, []).lines, ["mode: default", "allow (2):", "  Read", "  Glob"]);
  assert.deepEqual(runPermissions({}, ["show"]).lines, ["mode: default", "allow: (none)"]);
});

test("rules are checked before anything is written", () => {
  for (const bad of ["", " Read", "Read ", "1Bash", "Bash(git:*", "Bash)git(", "Re\nad"]) {
    assert.throws(() => checkPermissionRule(bad), /not a permission rule/, JSON.stringify(bad));
  }
  for (const good of ["Read", "Bash(git:*)", "mcp__server__tool", "WebFetch(domain:example.com)"]) {
    assert.doesNotThrow(() => checkPermissionRule(good));
  }
  assert.throws(() => runPermissions({ permissions: { allow: ["Read"] } }, ["add", "Read", "bad rule("]), /unbalanced/);
});

test("settings that are not shaped like permissions are refused, never replaced", () => {
  assert.throws(() => runPermissions({ permissions: "yes" }, ["add", "Read"]), /not an object.*left alone/);
  assert.throws(() => runPermissions({ permissions: { allow: "Read" } }, ["rm", "Read"]), /not a list of rules/);
  assert.deepEqual(withRules(["a", "b"], ["b", "c", "c"]), ["a", "b", "c"]);
});
