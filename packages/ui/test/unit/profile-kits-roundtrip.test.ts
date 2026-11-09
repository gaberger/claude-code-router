import assert from "node:assert/strict";
import test from "node:test";
import { createProfileDraft, createProfileDraftFromProfile, normalizeProfileItem, profileConfigFromDraft } from "@ccr/ui/pages/home/shared/profiles.ts";

const claudeProfile = {
  agent: "claude-code",
  enabled: true,
  env: {},
  id: "work",
  kits: ["base", "net"],
  model: "p/m",
  name: "Work",
  scope: "ccr",
  surface: "cli"
} as any;

test("saving a Claude Code profile from the form keeps its kits (they were silently dropped before)", () => {
  const draft = createProfileDraftFromProfile(claudeProfile);
  assert.deepEqual(draft.kits, ["base", "net"]);
  const saved = profileConfigFromDraft(draft, [claudeProfile], claudeProfile);
  assert.deepEqual(saved.kits, ["base", "net"]);
});

test("changing kits in the form changes what is saved, and clearing them removes the field", () => {
  const draft = createProfileDraftFromProfile(claudeProfile);
  assert.deepEqual(profileConfigFromDraft({ ...draft, kits: ["net"] }, [claudeProfile], claudeProfile).kits, ["net"]);
  assert.equal("kits" in profileConfigFromDraft({ ...draft, kits: [] }, [claudeProfile], claudeProfile), false);
});

test("a new profile has no kits, and other agents never gain the field", () => {
  assert.deepEqual(createProfileDraft("claude-code").kits, []);
  const codex = profileConfigFromDraft({ ...createProfileDraft("codex"), kits: ["net"], model: "m" }, []);
  assert.equal("kits" in codex, false);
  assert.deepEqual(normalizeProfileItem(claudeProfile, 0).kits, ["base", "net"]);
});
