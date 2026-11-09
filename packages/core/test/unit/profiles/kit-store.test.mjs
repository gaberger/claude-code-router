import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addToLibrary, addTreeToLibrary, buildLaunchPlan, createKit, dropEntries, isValidKitName, listKits, makeLibraryFolder,
  moveInLibrary, planLoads, readUses, removeFromLibrary, removeKit, renameLibraryFolder, scanLibrary,
  useEntries, writeInstructions
} from "@ccr/core/profiles/kits/kit-store.ts";

function withRoot(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-kits-"));
  try { return run(root); } finally { rmSync(root, { force: true, recursive: true }); }
}
const write = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const skill = (root, rel) => write(path.join(root, "library", "skills", rel, "SKILL.md"), "---\nname: s\n---\n");
const agent = (root, rel) => write(path.join(root, "library", "agents", `${rel}.md`), "agent");
const plugin = (root, dir, name) => write(path.join(root, "library", "plugins", dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));

test("scanLibrary finds skills and agents in nested folders and plugins by manifest name", () => withRoot((root) => {
  skill(root, "net/nqe/find-nqe-query");
  skill(root, "top-skill");
  agent(root, "dev/reviewer");
  plugin(root, "egm-repo", "egm");
  const items = scanLibrary(root).map((i) => `${i.kind}:${i.name}:${i.folder}`);
  assert.deepEqual(items, [
    "agents:reviewer:dev", "plugins:egm:", "skills:find-nqe-query:net/nqe", "skills:top-skill:"
  ]);
}));

test("kit names follow the ccs rule and cannot clash with a library plugin", () => withRoot((root) => {
  assert.equal(isValidKitName("net"), true);
  assert.equal(isValidKitName("Net"), false);
  assert.equal(isValidKitName("-x"), false);
  plugin(root, "egm", "egm");
  assert.throws(() => createKit(root, "egm"), /library plugin/);
  createKit(root, "net");
  assert.throws(() => createKit(root, "net"), /already exists/);
  assert.deepEqual(listKits(root), ["net"]);
}));

test("uses edits keep comments and order, never repeat a line, and drop only what is named", () => withRoot((root) => {
  createKit(root, "dev");
  writeFileSync(path.join(root, "kits", "dev", "uses"), "# my kit\nskills/a\n\nagents/b\n");
  useEntries(root, "dev", ["skills/a", "skills/c"]);
  assert.equal(readUses(root, "dev"), "# my kit\nskills/a\n\nagents/b\nskills/c\n");
  dropEntries(root, "dev", ["agents/b"]);
  assert.equal(readUses(root, "dev"), "# my kit\nskills/a\n\nskills/c\n");
  assert.throws(() => useEntries(root, "dev", ["nonsense"]), /not a library entry/);
}));

test("a folder entry loads everything under it, including what is added later", () => withRoot((root) => {
  skill(root, "net/one"); skill(root, "net/deep/two"); skill(root, "other/three");
  createKit(root, "net");
  useEntries(root, "net", ["skills/net/"]);
  assert.deepEqual(planLoads(root, ["net"]).kits[0].lines[0].items.map((i) => i.name), ["one", "two"]);
  skill(root, "net/late");
  assert.equal(planLoads(root, ["net"]).kits[0].lines[0].items.length, 3);
}));

test("loads warns about entries the library lost and agents that share a name, and builds nothing", () => withRoot((root) => {
  agent(root, "a/twin"); agent(root, "b/twin"); skill(root, "real");
  createKit(root, "k");
  useEntries(root, "k", ["skills/real", "skills/gone", "agents/twin"]);
  const plan = planLoads(root, ["k", "ghost"]);
  assert.ok(plan.warnings.some((w) => /no longer has skills\/gone/.test(w)));
  assert.ok(plan.warnings.some((w) => /Kit ghost does not exist/.test(w)));
  assert.ok(plan.warnings.some((w) => /agents\/twin more than once/.test(w)));
  assert.equal(existsSync(path.join(root, ".build")), false, "planLoads must not build");
}));

test("launch plan builds each kit as a plugin: skills linked, agents copied, plugins loaded once, instructions combined", () => withRoot((root) => {
  skill(root, "net/find"); agent(root, "dev/rev"); plugin(root, "egm", "egm");
  write(path.join(root, "library", "agents", "dev", "rev.md"), "agent body");
  createKit(root, "net"); createKit(root, "dev");
  useEntries(root, "net", ["skills/net/", "plugins/egm"]);
  useEntries(root, "dev", ["agents/rev", "plugins/egm"]);
  writeInstructions(root, "net", "Use the net tools.\n");

  const plan = buildLaunchPlan(root, ["net", "dev"]);
  const net = path.join(root, ".build", "net");
  const dev = path.join(root, ".build", "dev");
  assert.deepEqual(plan.pluginDirs, [net, dev, path.join(root, "library", "plugins", "egm")]);
  assert.equal(JSON.parse(readFileSync(path.join(net, ".claude-plugin", "plugin.json"), "utf8")).name, "net");
  assert.equal(lstatSync(path.join(net, "skills", "find")).isSymbolicLink(), true);
  assert.equal(lstatSync(path.join(dev, "agents", "rev.md")).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(dev, "agents", "rev.md"), "utf8"), "agent body");
  assert.match(readFileSync(plan.instructionsFile, "utf8"), /<!-- kit: net -->\nUse the net tools\./);
  // a rebuild after the library changes replaces, not accumulates
  skill(root, "net/second");
  buildLaunchPlan(root, ["net", "dev"]);
  assert.deepEqual(readdirSync(path.join(net, "skills")).sort(), ["find", "second"]);
}));

test("a kit with only plugins builds no empty plugin of its own", () => withRoot((root) => {
  plugin(root, "egm", "egm");
  createKit(root, "p"); useEntries(root, "p", ["plugins/egm"]);
  const plan = buildLaunchPlan(root, ["p"]);
  assert.deepEqual(plan.pluginDirs, [path.join(root, "library", "plugins", "egm")]);
  assert.equal(plan.instructionsFile, undefined);
}));

test("add, move, rename and remove keep the library and its kits consistent", () => withRoot((root) => {
  const src = path.join(root, "incoming", "find-it"); write(path.join(src, "SKILL.md"));
  makeLibraryFolder(root, "skills/net");
  assert.equal(addToLibrary(root, src, { folder: "net" }), "skills/find-it");
  assert.throws(() => addToLibrary(root, src), /already has skills\/find-it/);
  createKit(root, "k"); useEntries(root, "k", ["skills/net/", "skills/find-it"]);

  renameLibraryFolder(root, "skills/net/", "network");
  assert.equal(readUses(root, "k"), "skills/network/\nskills/find-it\n");
  assert.equal(scanLibrary(root)[0].folder, "network");

  moveInLibrary(root, "skills/find-it", "/");
  assert.equal(scanLibrary(root)[0].folder, "");

  assert.deepEqual(removeFromLibrary(root, "skills/find-it"), { kits: ["k"] });
  assert.equal(scanLibrary(root).length, 0);
  assert.ok(readdirSync(path.join(root, ".trash")).length === 1);
  removeKit(root, "k");
  assert.deepEqual(listKits(root), []);
}));

test("paths that escape the library are refused", () => withRoot((root) => {
  assert.throws(() => makeLibraryFolder(root, "skills/../outside"), /not a library path/);
}));

test("adding a tree of skills keeps its folder structure, skips names the library has, and follows links", () => withRoot((root) => {
  const src = path.join(root, "incoming", "network");
  for (const rel of ["inspect/bgp", "inspect/edge", "plan/triage", "top"]) write(path.join(src, rel, "SKILL.md"), "---\n---\n");
  write(path.join(src, "notes", "README.md"), "not a skill");
  skill(root, "elsewhere/top"); // the library already has a skill named "top"

  const result = addTreeToLibrary(root, src, { folder: "work" });
  assert.deepEqual(result.added, ["skills/bgp", "skills/edge", "skills/triage"]);
  assert.deepEqual(result.skipped, [{ entry: "skills/top", reason: "the library already has that name" }]);
  assert.deepEqual(
    scanLibrary(root).filter((i) => i.name !== "top").map((i) => `${i.name}:${i.folder}`),
    ["bgp:work/network/inspect", "edge:work/network/inspect", "triage:work/network/plan"]
  );
  // a second run adds nothing and fails nothing
  assert.deepEqual(addTreeToLibrary(root, src, { folder: "work" }).added, []);
  assert.throws(() => addTreeToLibrary(root, path.join(root, "incoming", "network", "notes")), /No skills .*--agents/);
  assert.throws(() => addTreeToLibrary(root, path.join(root, "nope")), /Not a folder/);
}));

test("adding a tree of agents takes every .md file and keeps folders", () => withRoot((root) => {
  const src = path.join(root, "incoming", "dev");
  write(path.join(src, "reviewer.md"), "a"); write(path.join(src, "deep", "tester.md"), "b"); write(path.join(src, "notes.txt"), "no");
  const result = addTreeToLibrary(root, src, { kind: "agents" });
  assert.deepEqual([...result.added].sort(), ["agents/reviewer", "agents/tester"]);
  assert.deepEqual(scanLibrary(root).map((i) => `${i.name}:${i.folder}`), ["reviewer:dev", "tester:dev/deep"]);
  assert.throws(() => addTreeToLibrary(root, path.join(root, "incoming", "dev", "deep", ".."), { kind: "agents", folder: "../x" }), /not a library path/);
}));
