import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addToLibraryFromSource, gitSourceUrl, updateLibraryPlugins } from "@ccr/core/profiles/kits/library-git.ts";
import { createKit, scanLibrary } from "@ccr/core/profiles/kits/kit-store.ts";

const gitEnv = { ...process.env, GIT_AUTHOR_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_NAME: "t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });
const write = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

function withDirs(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccr-git-"));
  const root = path.join(dir, "store");
  try { return run({ dir, root }); } finally { rmSync(dir, { force: true, recursive: true }); }
}
function makeRepo(dir, name, manifest = { name }) {
  const repo = path.join(dir, `${name}-repo`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  if (manifest) write(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  write(path.join(repo, "skills", "hello", "SKILL.md"), "---\nname: hello\n---\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  return repo;
}

test("gitSourceUrl reads owner/repo, URLs and scp-style sources, and refuses anything that could be an option", () => {
  assert.equal(gitSourceUrl("google/elephant-goldfish-model"), "https://github.com/google/elephant-goldfish-model.git");
  assert.equal(gitSourceUrl("gaberger/ccs.git"), "https://github.com/gaberger/ccs.git");
  for (const url of ["https://example.com/a/b.git", "ssh://git@host/a/b", "git@github.com:a/b.git", "file:///tmp/x"]) assert.equal(gitSourceUrl(url), url);
  for (const bad of ["", "--upload-pack=evil", "-x/y", "just-a-name", "a/b/c"]) assert.equal(gitSourceUrl(bad), undefined, bad);
});

test("adding a plugin repo keeps its manifest name and its git clone, and refuses a second add", () => withDirs(({ dir, root }) => {
  const repo = makeRepo(dir, "egm-source", { name: "egm" });
  assert.equal(addToLibraryFromSource(root, `file://${repo}`), "plugins/egm");
  assert.ok(existsSync(path.join(root, "library", "plugins", "egm", ".git")), "kept as a clone so update can pull");
  assert.deepEqual(scanLibrary(root).map((i) => `${i.kind}/${i.name}`), ["plugins/egm"]);
  assert.throws(() => addToLibraryFromSource(root, `file://${repo}`), /already has plugins\/egm/);
  assert.deepEqual(readdirSync(path.join(root, ".build")), [], "no clone is left behind");
}));

test("a repo that is not a plugin, a clash with a kit, and an unusable name all leave the library untouched", () => withDirs(({ dir, root }) => {
  const noManifest = makeRepo(dir, "plain", null);
  assert.throws(() => addToLibraryFromSource(root, `file://${noManifest}`), /not a plugin.*marketplace/s);

  const clash = makeRepo(dir, "net-source", { name: "net" });
  createKit(root, "net");
  assert.throws(() => addToLibraryFromSource(root, `file://${clash}`), /A kit is named net/);

  const evil = makeRepo(dir, "evil-source", { name: "../evil" });
  assert.throws(() => addToLibraryFromSource(root, `file://${evil}`), /not usable as a folder name/);

  assert.throws(() => addToLibraryFromSource(root, `file://${path.join(dir, "no-such-repo")}`), /git clone failed/);
  assert.deepEqual(scanLibrary(root), []);
  assert.deepEqual(readdirSync(path.join(root, ".build")), []);
  assert.equal(existsSync(path.join(dir, "evil")), false);
}));

test("a local path wins over reading the source as owner/repo, and a missing path says so", () => withDirs(({ dir, root }) => {
  const skill = path.join(dir, "a", "b");
  write(path.join(skill, "SKILL.md"), "---\n---\n");
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(addToLibraryFromSource(root, "a/b"), "skills/b");
    assert.throws(() => addToLibraryFromSource(root, "nothing-here"), /Not found: nothing-here/);
  } finally {
    process.chdir(originalCwd); // the temp dir is removed after the test; later tests must not run from inside it
  }
}));

test("update pulls new commits, reports unchanged ones, skips folder plugins, and isolates failures", () => withDirs(({ dir, root }) => {
  const repo = makeRepo(dir, "egm-source", { name: "egm" });
  addToLibraryFromSource(root, `file://${repo}`);
  const folderPlugin = path.join(dir, "folder-plugin");
  write(path.join(folderPlugin, ".claude-plugin", "plugin.json"), '{"name":"folder-only"}');
  addToLibraryFromSource(root, folderPlugin);

  assert.deepEqual(updateLibraryPlugins(root), { failed: [], unchanged: ["plugins/egm"], updated: [] });

  write(path.join(repo, "skills", "second", "SKILL.md"), "---\nname: second\n---\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "more");
  assert.deepEqual(updateLibraryPlugins(root, "plugins/egm"), { failed: [], unchanged: [], updated: ["plugins/egm"] });
  assert.ok(existsSync(path.join(root, "library", "plugins", "egm", "skills", "second", "SKILL.md")));

  rmSync(repo, { force: true, recursive: true });
  const broken = updateLibraryPlugins(root);
  assert.equal(broken.failed.length, 1);
  assert.match(broken.failed[0].message, /git pull failed/);
  assert.throws(() => updateLibraryPlugins(root, "plugins/ghost"), /no plugins\/ghost/);
}));
