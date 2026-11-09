import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyKitsAction, getKitsState } from "@ccr/core/profiles/kits/kit-service.ts";

test("kits state and actions drive the whole page: create, add to library, use, instructions, drop, remove", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-kit-service-"));
  try {
    assert.deepEqual(getKitsState(root), { kits: [], library: [], warnings: [] });

    const skill = path.join(root, "incoming", "find");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\n---\n");

    applyKitsAction({ type: "createKit", name: " net " }, root);
    applyKitsAction({ source: skill, type: "libraryAdd" }, root);
    applyKitsAction({ entries: ["skills/find", "skills/gone"], kit: "net", type: "use" }, root);
    let state = applyKitsAction({ kit: "net", text: "Be terse.", type: "setInstructions" }, root);

    assert.deepEqual(state.library, [{ folder: "", kind: "skills", name: "find" }]);
    assert.deepEqual(state.kits[0].uses, ["skills/find", "skills/gone"]);
    assert.equal(state.kits[0].instructions, "Be terse.");
    assert.equal(state.kits[0].loads.instructions, true);
    assert.deepEqual(state.warnings, ["Kit net: the library no longer has skills/gone."]);

    state = applyKitsAction({ entries: ["skills/gone"], kit: "net", type: "drop" }, root);
    assert.deepEqual(state.warnings, []);

    assert.throws(() => applyKitsAction({ name: "Bad Name", type: "createKit" }, root), /not a kit name/);
    assert.deepEqual(applyKitsAction({ entry: "skills/find", type: "libraryRemove" }, root).library, []);
    assert.deepEqual(applyKitsAction({ name: "net", type: "removeKit" }, root).kits, []);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
