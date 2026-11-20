import { test } from "node:test";
import assert from "node:assert/strict";
import { ManaPool, ManaSnapshot } from "../manametry.js";

test("setContext stores token usage; gpu disabled yields null", async () => {
  const pool = new ManaPool({ gpu: false });
  pool.setContext(1234, 6600);
  const snap = await pool.snapshot();
  assert.equal(snap.gpu, null);
  assert.equal(snap.context?.used, 1234);
  assert.equal(snap.context?.total, 6600);
  assert.ok(snap.cpu.cores >= 1);
  assert.ok(snap.cpu.load >= 0 && snap.cpu.load <= 1);
  assert.ok(snap.memory.total > 0);
  assert.ok(snap.memory.used <= snap.memory.total);
});

test("rejects malformed context samples", async () => {
  const pool = new ManaPool({ gpu: false });
  pool.setContext(NaN, 100);
  pool.setContext(-5, 100);
  pool.setContext(10, Number.POSITIVE_INFINITY);
  const snap = await pool.snapshot();
  assert.equal(snap.context, null);
});

const SNAPSHOT: ManaSnapshot = {
  ts: 0,
  cpu: { load: 0.34, cores: 16 },
  memory: { used: 11.2 * 1024 ** 3, total: 31.9 * 1024 ** 3 },
  gpu: { name: "NVIDIA GeForce RTX 4090", usedMB: 1843, totalMB: 8192, util: 45 },
  context: { used: 1234, total: 6600 },
};

test("render formats the cyber-sorcery block", () => {
  const pool = new ManaPool({ gpu: false });
  const text = pool.render(SNAPSHOT);
  assert.match(text, /\[CYBER-SORCERY\]/);
  assert.match(text, /Memory pool: 1234\/6600 tokens/);
  assert.match(text, /19% full/);
  assert.match(text, /Spell lattice: 34% load across 16 cores/);
  assert.match(text, /Mana reserves: 1\.8\/8\.0 GB on NVIDIA GeForce RTX 4090/);
  assert.match(text, /45% draw/);
  assert.match(text, /System spirits: 11\.2\/31\.9 GB/);
});

test("render handles missing context and gpu", () => {
  const pool = new ManaPool({ gpu: false });
  const text = pool.render({ ...SNAPSHOT, gpu: null, context: null });
  assert.match(text, /Memory pool: unattuned/);
  assert.match(text, /no NVIDIA crystal/);
});
