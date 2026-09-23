
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../../src/server");
const { runMigrations } = require("../../src/db");

// 测试用固定时间线（ISO 8601 带偏移量）
const T = {
  windowStart: "2026-09-24T06:00:00+08:00",
  windowEnd: "2026-09-24T20:00:00+08:00",
  dispatchStart: "2026-09-24T07:00:00+08:00",
  dispatchEnd: "2026-09-24T08:00:00+08:00",
  transshipStart: "2026-09-24T09:00:00+08:00",
  transshipEnd: "2026-09-24T10:00:00+08:00",
  hoistStart: "2026-09-24T11:00:00+08:00",
  hoistEnd: "2026-09-24T12:00:00+08:00",
  installStart: "2026-09-24T12:30:00+08:00",
  installEnd: "2026-09-24T13:30:00+08:00",
};

async function startHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const server = createServer({ database: db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(method, route, body, actor = "CTRL-ROOM") {
    const headers = { "content-type": "application/json" };
    // 操作者以不含真实身份的引用编号传递（HTTP 头仅接受 Latin-1）
    if (actor) headers["x-actor"] = String(actor);
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    return { status: response.status, body: json };
  }

  const post = (route, body, actor) => call("POST", route, body, actor);
  const get = (route) => call("GET", route, undefined);

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { db, base, call, post, get, stop };
}

// 标准场景：n 个节段、1 个水位窗口、1 船、1 缆索吊、两岸、2 个航道点
async function seedScenario(h, options = {}) {
  const count = options.segmentCount ?? 2;
  const segments = [];
  for (let i = 1; i <= count; i += 1) {
    const ref = `SEG-${String(i).padStart(2, "0")}`;
    const result = await h.post("/admin/segments", {
      segment_ref: ref,
      install_order: i,
      name: `节段${i}`,
      revision: 1,
      weight: 120,
      length_m: 12,
    });
    segments.push(result.body);
    for (const kind of ["fabrication_acceptance", "preassembly_acceptance"]) {
      await h.post("/admin/evidence", {
        segment_ref: ref,
        revision: 1,
        kind,
        result: "pass",
        ref: `DOC-${ref}-${kind}`,
        sha256: `sha256:${ref}-${kind}`,
      });
    }
    await h.post("/admin/loadings", {
      vessel_ref: "V-1",
      segment_ref: ref,
      revision: 1,
      load: 150,
      draft: 2.0,
    });
  }

  await h.post("/admin/windows", {
    window_ref: "WIN-1",
    starts_at: T.windowStart,
    ends_at: T.windowEnd,
    level_min: 218.0,
    level_max: 222.0,
    source: "水电站调度",
  });
  await h.post("/admin/vessels", { vessel_ref: "V-1", max_load: 500, max_draft: 2.5 });
  await h.post("/admin/hoists", { hoist_ref: "H-1", capacity: 600 });
  await h.post("/admin/banks", { bank_ref: "B-N", side: "north", ready: true });
  await h.post("/admin/banks", { bank_ref: "B-S", side: "south", ready: true });
  await h.post("/admin/channel-readings", { point_ref: "P-1", depth: 6.0 });
  await h.post("/admin/channel-readings", { point_ref: "P-2", depth: 5.5 });
  return { segments };
}

function dispatchBody(segmentRef, overrides = {}) {
  return {
    request_ref: `REQ-${segmentRef}-DISPATCH`,
    segment_ref: segmentRef,
    revision: 1,
    action: "dispatch",
    vessel_ref: "V-1",
    window_ref: "WIN-1",
    scheduled_start: T.dispatchStart,
    scheduled_end: T.dispatchEnd,
    detail: { point_refs: ["P-1", "P-2"], draft_margin: 0.3 },
    requester: "运输组",
    ...overrides,
  };
}

function transshipBody(segmentRef, overrides = {}) {
  return {
    request_ref: `REQ-${segmentRef}-TRANSSHIP`,
    segment_ref: segmentRef,
    revision: 1,
    action: "transship",
    vessel_ref: "V-1",
    window_ref: "WIN-1",
    scheduled_start: T.transshipStart,
    scheduled_end: T.transshipEnd,
    detail: { point_refs: ["P-2"], draft_margin: 0.3 },
    requester: "驳运组",
    ...overrides,
  };
}

function hoistBody(segmentRef, overrides = {}) {
  return {
    request_ref: `REQ-${segmentRef}-HOIST`,
    segment_ref: segmentRef,
    revision: 1,
    action: "hoist",
    hoist_ref: "H-1",
    window_ref: "WIN-1",
    scheduled_start: T.hoistStart,
    scheduled_end: T.hoistEnd,
    requester: "吊装组",
    ...overrides,
  };
}

function installBody(segmentRef, overrides = {}) {
  return {
    request_ref: `REQ-${segmentRef}-INSTALL`,
    segment_ref: segmentRef,
    revision: 1,
    action: "install",
    hoist_ref: "H-1",
    window_ref: "WIN-1",
    scheduled_start: T.installStart,
    scheduled_end: T.installEnd,
    detail: { bank_refs: ["B-N", "B-S"] },
    requester: "安装组",
    ...overrides,
  };
}

// 跑通：发运→倒驳（含交接证据）→起吊→安装
async function fullChain(h, segmentRef) {
  const steps = [];
  for (const [bodyFactory, kind, evidenceKind] of [
    [dispatchBody, "dispatch", null],
    [transshipBody, "transship", "transfer_handover"],
    [hoistBody, "hoist", null],
    [installBody, "install", null],
  ]) {
    if (evidenceKind) {
      // 倒驳交接证据必须在签发前成立（hoist 依赖 transfer_handover）
      await h.post("/admin/evidence", {
        segment_ref: segmentRef,
        revision: 1,
        kind: evidenceKind,
        result: "pass",
        ref: `DOC-${segmentRef}-${evidenceKind}`,
      });
    }
    const created = await h.post("/requests", bodyFactory(segmentRef));
    if (created.status !== 201) throw new Error(`${kind} 申请失败：${JSON.stringify(created.body)}`);
    const issued = await h.post(`/requests/${created.body.request_ref}/issue`, {});
    if (issued.status !== 200) throw new Error(`${kind} 签发失败：${JSON.stringify(issued.body)}`);
    const completed = await h.post(`/requests/${created.body.request_ref}/complete`, {});
    if (completed.status !== 200) throw new Error(`${kind} 完成失败：${JSON.stringify(completed.body)}`);
    steps.push(created.body.request_ref);
  }
  return steps;
}

module.exports = { T, startHarness, seedScenario, dispatchBody, transshipBody, hoistBody, installBody, fullChain };
