
const assert = require("node:assert/strict");
const test = require("node:test");
const dom = require("../src/domain");
const { newDb } = require("./helpers");

const iso = (ms) => new Date(Date.now() + ms).toISOString();

function baseSetup() {
  const db = newDb();
  dom.registerSegment(db, { segment_ref: "SEG-01", weight_t: 120, install_order: 1 });
  dom.registerSegment(db, { segment_ref: "SEG-02", weight_t: 120, install_order: 2 });
  dom.upsertVessel(db, { vessel_ref: "VESSEL-A", capacity_t: 300, draft_m: 1.6 });
  dom.upsertHoist(db, { hoist_ref: "HOIST-C1", capacity_t: 260 });
  dom.setBankReady(db, "NORTH", true);
  dom.setBankReady(db, "SOUTH", true);
  dom.publishWaterWindow(db, {
    window_ref: "WIN-1", channel_ref: "CH-1", min_depth_m: 2.0,
    starts_at: iso(-3600e3), ends_at: iso(3600e3),
  });
  return db;
}

test("缺少前序证据时提前起吊被拒", () => {
  const db = baseSetup();
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "fabricated" });
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted" });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "hoist", resource_ref: "HOIST-C1", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "precedence_transferred");
});

test("合龙顺序未到：前序节段未安装时起吊被拒", () => {
  const db = baseSetup();
  for (const s of ["SEG-01", "SEG-02"]) {
    for (const stage of ["fabricated", "accepted", "transported", "transferred"]) {
      dom.appendEvent(db, { segment_ref: s, stage });
    }
  }
  const gate = dom.computeGate(db, { segment_ref: "SEG-02", action: "hoist", resource_ref: "HOIST-C1", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "predecessor_installed");
});

test("缆索吊能力不足被拒", () => {
  const db = newDb();
  dom.registerSegment(db, { segment_ref: "SEG-H", weight_t: 300, install_order: 1 });
  dom.upsertHoist(db, { hoist_ref: "HOIST-X", capacity_t: 200 });
  dom.setBankReady(db, "NORTH", true);
  dom.setBankReady(db, "SOUTH", true);
  dom.publishWaterWindow(db, { window_ref: "WIN-1", channel_ref: "CH-1", min_depth_m: 2, starts_at: iso(-1000), ends_at: iso(3600e3) });
  for (const stage of ["fabricated", "accepted", "transported", "transferred"]) dom.appendEvent(db, { segment_ref: "SEG-H", stage });
  const gate = dom.computeGate(db, { segment_ref: "SEG-H", action: "hoist", resource_ref: "HOIST-X", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "capacity");
});

test("船舶吃水超过航道实测水深被拒", () => {
  const db = baseSetup();
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "fabricated" });
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted" });
  dom.addChannelObservation(db, { channel_ref: "CH-1", depth_m: 1.2, observed_at: iso(-60e3) });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "channel_depth");
});

test("窗口未开启与被取代的窗口均被拒", () => {
  const db = baseSetup();
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "fabricated" });
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted" });
  dom.publishWaterWindow(db, { window_ref: "WIN-2", channel_ref: "CH-1", min_depth_m: 2, starts_at: iso(1800e3), ends_at: iso(7200e3) });
  let gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-2" });
  assert.equal(gate.checks.find((c) => !c.ok).code, "window_open");
  gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.checks.find((c) => !c.ok).code, "window_valid");
});

test("两岸条件不具备时起吊被拒", () => {
  const db = newDb();
  dom.registerSegment(db, { segment_ref: "SEG-01", weight_t: 120, install_order: 1 });
  dom.upsertHoist(db, { hoist_ref: "HOIST-C1", capacity_t: 260 });
  dom.setBankReady(db, "NORTH", true);
  // 南岸未登记/未就绪
  dom.publishWaterWindow(db, { window_ref: "WIN-1", channel_ref: "CH-1", min_depth_m: 2, starts_at: iso(-1000), ends_at: iso(3600e3) });
  for (const stage of ["fabricated", "accepted", "transported", "transferred"]) dom.appendEvent(db, { segment_ref: "SEG-01", stage });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "hoist", resource_ref: "HOIST-C1", window_ref: "WIN-1" });
  assert.equal(gate.checks.find((c) => !c.ok).code, "banks_ready");
});

test("环保禁限时段内的动作被拒", () => {
  const db = baseSetup();
  for (const stage of ["fabricated", "accepted", "transported", "transferred"]) dom.appendEvent(db, { segment_ref: "SEG-01", stage });
  dom.addEnvironmentalBan(db, { ban_ref: "BAN-1", scope: "hoist", starts_at: iso(-60e3), ends_at: iso(3600e3), reason: "禁吊" });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "hoist", resource_ref: "HOIST-C1", window_ref: "WIN-1" });
  assert.equal(gate.checks.find((c) => !c.ok).code, "environmental_ban");
});

test("所有闸门同时成立时通过", () => {
  const db = baseSetup();
  for (const stage of ["fabricated", "accepted", "transported", "transferred"]) dom.appendEvent(db, { segment_ref: "SEG-01", stage });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "hoist", resource_ref: "HOIST-C1", window_ref: "WIN-1" });
  assert.equal(gate.ok, true);
  assert.ok(gate.checks.every((c) => c.ok));
});
