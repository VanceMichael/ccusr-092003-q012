
const assert = require("node:assert/strict");
const test = require("node:test");
const dom = require("../src/domain");
const { newDb, seededDb, withServer } = require("./helpers");

const iso = (ms) => new Date(Date.now() + ms).toISOString();

function setupTwo(db) {
  dom.registerSegment(db, { segment_ref: "SEG-01", weight_t: 120, install_order: 1 });
  dom.registerSegment(db, { segment_ref: "SEG-02", weight_t: 120, install_order: 2 });
  dom.upsertVessel(db, { vessel_ref: "VESSEL-A", capacity_t: 300, draft_m: 1.6 });
  dom.upsertHoist(db, { hoist_ref: "HOIST-C1", capacity_t: 260 });
  dom.setBankReady(db, "NORTH", true);
  dom.setBankReady(db, "SOUTH", true);
  dom.publishWaterWindow(db, { window_ref: "WIN-1", channel_ref: "CH-1", min_depth_m: 2, starts_at: iso(-1000), ends_at: iso(3600e3) });
  for (const s of ["SEG-01", "SEG-02"]) {
    dom.appendEvent(db, { segment_ref: s, stage: "fabricated" });
    dom.appendEvent(db, { segment_ref: s, stage: "accepted" });
  }
}

test("同一资源并发申请只准一个生效，被拒申请不留许可记录", () => {
  const db = newDb();
  setupTwo(db);
  const a = dom.requestPermit(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  const b = dom.requestPermit(db, { segment_ref: "SEG-02", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(a.granted, true);
  assert.equal(b.status, 409);
  assert.equal(b.conflict.held_by_permit, a.permit.permit_id);
  // 只有一条许可行（冲突申请已回滚，不留残记录）
  const count = db.prepare(`SELECT COUNT(*) AS n FROM permits`).get().n;
  assert.equal(count, 1);
});

test("资源释放后下一申请才可生效", () => {
  const db = newDb();
  setupTwo(db);
  const a = dom.requestPermit(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  dom.completePermit(db, a.permit.permit_id);
  const b = dom.requestPermit(db, { segment_ref: "SEG-02", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(b.granted, true);
  assert.equal(dom.getSegment(db, "SEG-01").status, "transported");
});

test("完成动作写入里程碑证据并与许可关联", () => {
  const db = newDb();
  setupTwo(db);
  const p = dom.requestPermit(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  const done = dom.completePermit(db, p.permit.permit_id, { actor_ref: "CREW-A" });
  assert.equal(done.event.stage, "transported");
  assert.equal(done.event.payload.permit_id, p.permit.permit_id);
  assert.equal(done.permit.status, "completed");
});

test("HTTP 并发请求下同资源仍只准一个生效", async (t) => {
  const db = newDb();
  setupTwo(db);
  const { call } = await withServer(t, db);
  const results = await Promise.all([
    call("/permits", { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" }),
    call("/permits", { segment_ref: "SEG-02", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" }),
  ]);
  const granted = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(granted.length, 1);
  assert.equal(conflicts.length, 1);
});

test("水位窗口变化立即吊销生效许可并释放资源", () => {
  const db = newDb();
  setupTwo(db);
  const p = dom.requestPermit(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  const { impact } = dom.publishWaterWindow(db, {
    window_ref: "WIN-2", channel_ref: "CH-1", min_depth_m: 2.0,
    starts_at: iso(-60e3), ends_at: iso(1800e3), source: "临时调度",
  });
  assert.ok(impact.voided_permit_ids.includes(p.permit.permit_id));
  assert.equal(dom.getPermit(db, p.permit.permit_id).status, "voided");
  // 资源已释放，可再签发
  const again = dom.requestPermit(db, { segment_ref: "SEG-02", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-2" });
  assert.equal(again.granted, true);
});

test("设备停用立即吊销其生效许可", () => {
  const db = newDb();
  setupTwo(db);
  const p = dom.requestPermit(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  const impact = dom.setDeviceStatus(db, "vessel", "VESSEL-A", "out_of_service", "舵机故障");
  assert.ok(impact.voided_permit_ids.includes(p.permit.permit_id));
  const gate = dom.computeGate(db, { segment_ref: "SEG-02", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "resource_status");
});

test("复检失败阻断后续动作并标记其后节段；复检通过恢复", () => {
  const db = newDb();
  setupTwo(db);
  const accepted = db.prepare(
    `SELECT event_id FROM evidence_events WHERE segment_ref='SEG-01' AND stage='accepted' AND event_type!='recheck'`
  ).get().event_id;
  const { impact } = dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted", event_type: "recheck", disposition: "fail", supersedes_event: accepted });
  assert.deepEqual(impact.affected_segments.map((a) => a.segment_ref).sort(), ["SEG-01", "SEG-02"]);
  let gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.checks.find((c) => !c.ok).code, "recheck_accepted");
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted", event_type: "recheck", disposition: "pass", supersedes_event: accepted });
  gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.ok, true);
});

test("构件升版后旧版本证据不再满足闸门", () => {
  const db = newDb();
  setupTwo(db);
  dom.bumpSegmentRevision(db, { segment_ref: "SEG-01", weight_t: 125, note: "制造变更" });
  const gate = dom.computeGate(db, { segment_ref: "SEG-01", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-1" });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.find((c) => !c.ok).code, "precedence_fabricated");
});

test("合龙前缺节段被拒；全部按序安装后合龙并保留全部证据", () => {
  const db = seededDb();
  assert.throws(() => dom.closeClosure(db), /closure_incomplete/);

  // 利用种子：01..06 已安装，07 在倒驳点，08..15 已验收，其余待制造验收
  const window = "WIN-NAV-01";
  const run = (ref, action, resource) => {
    const r = dom.requestPermit(db, { segment_ref: ref, action, resource_ref: resource, window_ref: window });
    assert.equal(r.granted, true, `${ref} ${action}: ${JSON.stringify(r.gate?.checks.find((c) => !c.ok))}`);
    dom.completePermit(db, r.permit.permit_id);
  };
  for (let i = 7; i <= 37; i += 1) {
    const ref = `SEGMENT-${String(i).padStart(2, "0")}`;
    if (i >= 16) {
      dom.appendEvent(db, { segment_ref: ref, stage: "fabricated" });
      dom.appendEvent(db, { segment_ref: ref, stage: "accepted" });
    }
    if (i >= 8) {
      run(ref, "transport", "VESSEL-A");
      dom.appendEvent(db, { segment_ref: ref, stage: "transferred" });
    }
    run(ref, "hoist", "HOIST-N1");
  }
  const closure = dom.closeClosure(db);
  assert.equal(closure.total_segments, 37);
  assert.ok(closure.evidence_count > 37 * 3);

  const trace = dom.traceSegment(db, "SEGMENT-07");
  const stagesWithEvidence = trace.stages.filter((s) => s.events.some((e) => e.event_type !== "recheck")).map((s) => s.stage);
  assert.deepEqual(stagesWithEvidence, ["fabricated", "accepted", "transported", "transferred", "installed"]);
  // 许可留痕包含被水位/设备吊销之外的完整记录
  assert.ok(trace.permits.some((p) => p.action === "hoist" && p.status === "completed"));
});

test("证据只追加：历史复检事件不被覆盖", () => {
  const db = newDb();
  setupTwo(db);
  const accepted = db.prepare(
    `SELECT event_id FROM evidence_events WHERE segment_ref='SEG-01' AND stage='accepted' AND event_type!='recheck'`
  ).get().event_id;
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted", event_type: "recheck", disposition: "fail", supersedes_event: accepted });
  dom.appendEvent(db, { segment_ref: "SEG-01", stage: "accepted", event_type: "recheck", disposition: "pass", supersedes_event: accepted });
  const events = dom.eventsOf(db, "SEG-01").filter((e) => e.event_type === "recheck");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.disposition), ["fail", "pass"]);
});
