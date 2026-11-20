import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTier,
  normalizeUser,
  ViewerRegistry,
} from "../viewers.js";

test("normalizeUser handles case, whitespace, and leading @", () => {
  assert.equal(normalizeUser("  @Alice_99  "), "alice_99");
  assert.equal(normalizeUser("BOB"), "bob");
  assert.equal(normalizeUser(""), "");
});

test("computeTier transitions across newcomer, regular, heckler, and vip", () => {
  assert.equal(computeTier(0, 0), "newcomer");
  assert.equal(computeTier(4, 0, undefined, 5), "newcomer");
  assert.equal(computeTier(5, 0, undefined, 5), "regular");
  assert.equal(computeTier(20, -20), "heckler");
  assert.equal(computeTier(1, 0, "vip"), "vip");
});

test("ViewerRegistry creates, records, adjusts affinity, and attaches notes", () => {
  const reg = new ViewerRegistry({ regularThreshold: 3 });

  // Initially absent
  assert.equal(reg.get("alice"), null);

  // First message
  const p1 = reg.recordMessage("Alice", "hello circe!");
  assert.equal(p1.user, "alice");
  assert.equal(p1.messageCount, 1);
  assert.equal(p1.tier, "newcomer");
  assert.equal(p1.affinity, 0);

  // Two more messages promote to regular
  reg.recordMessage("alice");
  const p3 = reg.recordMessage("alice");
  assert.equal(p3.messageCount, 3);
  assert.equal(p3.tier, "regular");

  // Adjust affinity
  reg.adjustAffinity("alice", 25, "friendly greeting");
  assert.equal(reg.get("alice")?.affinity, 25);

  // Add notes (deduplicated)
  reg.addNote("alice", "loves moon magic");
  reg.addNote("alice", "loves moon magic"); // duplicate
  reg.addNote("alice", "asked about Malenia");
  assert.deepEqual(reg.get("alice")?.notes, ["loves moon magic", "asked about Malenia"]);

  // Render prompt
  const prompt = reg.renderPrompt("alice");
  assert.match(prompt, /\[VIEWER CONTEXT: alice\]/);
  assert.match(prompt, /regular/);
  assert.match(prompt, /\+25/);
  assert.match(prompt, /loves moon magic/);
});

test("ViewerRegistry turns hostile chatters into hecklers when affinity plunges", () => {
  const reg = new ViewerRegistry();
  reg.recordMessage("troll", "you smell");
  reg.adjustAffinity("troll", -30, "rude comment");
  const p = reg.get("troll");
  assert.equal(p?.tier, "heckler");
  assert.match(reg.renderPrompt("troll"), /Treat with razor-sharp wit/);
});

test("ViewerRegistry supports sorting, filtering, and persona overrides", () => {
  const reg = new ViewerRegistry();
  reg.recordMessage("alice");
  reg.recordMessage("alice");
  reg.recordMessage("bob");
  reg.setTier("bob", "vip");
  reg.setPersona("bob", "evil-neuro");

  assert.equal(reg.get("bob")?.personaId, "evil-neuro");
  assert.equal(reg.renderPrompt("bob").includes("royal favor"), true);

  const vips = reg.all({ tier: "vip" });
  assert.equal(vips.length, 1);
  assert.equal(vips[0].user, "bob");

  const byMessages = reg.all({ sort: "messages" });
  assert.equal(byMessages[0].user, "alice");
});

test("ViewerRegistry persists to and reloads from JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "circe-viewers-test-"));
  const file = join(dir, "viewers.jsonl");

  try {
    const reg1 = new ViewerRegistry({ file, regularThreshold: 2 });
    reg1.recordMessage("alice", "hi");
    reg1.recordMessage("alice", "second");
    reg1.adjustAffinity("alice", 15);
    reg1.addNote("alice", "alchemist");
    reg1.setPersona("alice", "evil-neuro");

    assert.equal(existsSync(file), true);

    // Load in fresh registry instance
    const reg2 = new ViewerRegistry({ file });
    const loaded = reg2.get("alice");
    assert.ok(loaded);
    assert.equal(loaded.user, "alice");
    assert.equal(loaded.messageCount, 2);
    assert.equal(loaded.tier, "regular");
    assert.equal(loaded.affinity, 15);
    assert.deepEqual(loaded.notes, ["alchemist"]);
    assert.equal(loaded.personaId, "evil-neuro");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
