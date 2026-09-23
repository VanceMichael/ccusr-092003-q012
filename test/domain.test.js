
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  startHarness,
  seedScenario,
  dispatchBody,
  transshipBody,
  hoistBody,
  installBody,
  fullChain,
} = require("./helpers/harness");

function codes(responseBody) {
  return (responseBody.detail?.blockers || []).map((item) => item.code);
}

test("现场提前起吊：前序未完成且窗口不覆盖时被拒绝签发", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  // 现场申请 05:00 起吊（水位窗口 06:00 才开始，且发运/倒驳均未完成）
  const early = await h.post(
    "/requests",
    hoistBody("SEG-01", {
      request_ref: "REQ-EARLY-HOIST",
      scheduled_start: "2026-09-24T05:00:00+08:00",
      scheduled_end: "2026-09-24T05:30:00+08:00",
    }),
    "SITE-FOREMAN"
  );
  assert.equal(early.status, 201);
  assert.equal(early.body.gate_snapshot.ok, false);

  const denied = await h.post("/requests/REQ-EARLY-HOIST/issue", {});
  assert.equal(denied.status, 412);
  assert.ok(codes(denied.body).includes("window_not_covered"));
  assert.ok(codes(denied.body).includes("previous_action_incomplete"));
});

test("正常链路：发运→倒驳→起吊→安装全部签发并完成", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  await fullChain(h, "SEG-01");

  const closure = await h.get("/closure");
  assert.equal(closure.body.total_segments, 2);
  assert.equal(closure.body.installed_segments, 1);
  assert.equal(closure.body.next_pending, "SEG-02");

  const trace = await h.get("/segments/SEG-01/trace");
  assert.equal(trace.body.segment.current_revision, 1);
  const kinds = trace.body.evidence.map((item) => item.kind);
  assert.ok(kinds.includes("fabrication_acceptance"));
  assert.ok(kinds.includes("preassembly_acceptance"));
  assert.ok(kinds.includes("transfer_handover"));
  for (const action of ["dispatch", "transship", "hoist", "install"]) {
    assert.equal(trace.body.actions[action][0].status, "completed");
    const events = trace.body.actions[action][0].events.map((event) => event.event);
    assert.deepEqual(events, ["created", "issued", "completed"]);
  }
});

test("安装序列：SEG-02 不能抢在 SEG-01 之前安装", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  // 直接为 SEG-02 申请安装（SEG-01 尚未安装）
  await h.post("/requests", installBody("SEG-02"));
  const denied = await h.post("/requests/REQ-SEG-02-INSTALL/issue", {});
  assert.equal(denied.status, 412);
  assert.ok(codes(denied.body).includes("install_sequence_blocked"));
  assert.deepEqual(denied.body.detail.blockers.find((b) => b.code === "install_sequence_blocked").detail.waiting, ["SEG-01"]);
});

test("同一船舶的并发申请只准一个生效，取消后资源释放", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  await h.post("/requests", dispatchBody("SEG-01"));
  const first = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(first.status, 200);

  // 第二份申请时段 07:30-08:30 与第一份 07:00-08:00 相交
  await h.post(
    "/requests",
    dispatchBody("SEG-02", {
      request_ref: "REQ-SEG-02-DISPATCH",
      scheduled_start: "2026-09-24T07:30:00+08:00",
      scheduled_end: "2026-09-24T08:30:00+08:00",
    })
  );
  const conflict = await h.post("/requests/REQ-SEG-02-DISPATCH/issue", {});
  assert.equal(conflict.status, 412);
  assert.ok(codes(conflict.body).includes("vessel_lease_conflict"));

  // 第一份取消并释放船舶
  const cancelled = await h.post("/requests/REQ-SEG-01-DISPATCH/cancel", { note: "调度调整" });
  assert.equal(cancelled.status, 200);
  const second = await h.post("/requests/REQ-SEG-02-DISPATCH/issue", {});
  assert.equal(second.status, 200);
});

test("水电站改变水位窗口：已签发许可立即挂起，按新窗口重新申请才可签发", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  await h.post("/requests", dispatchBody("SEG-01"));
  const issued = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(issued.status, 200);

  const change = await h.post("/changes", {
    change_ref: "CHG-WATER-1",
    type: "water",
    summary: "上游水电站临时调整水位窗口",
    cancel_windows: ["WIN-1"],
    new_windows: [
      {
        window_ref: "WIN-2",
        starts_at: "2026-09-24T10:00:00+08:00",
        ends_at: "2026-09-24T18:00:00+08:00",
        level_min: 219.5,
        level_max: 221.0,
        source: "水电站调度（更新）",
      },
    ],
  });
  assert.equal(change.status, 201);
  const impacted = change.body.impacts.find((item) => item.request_ref === "REQ-SEG-01-DISPATCH");
  assert.equal(impacted.before_status, "issued");
  assert.equal(impacted.after_status, "suspended");
  assert.ok(impacted.blockers.some((b) => b.code === "window_not_covered"));

  // 挂起状态直接重新签发仍然被拒
  const retryOld = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(retryOld.status, 412);

  // 旧许可的船舶租约已释放
  const suspendedList = await h.get("/requests?status=suspended");
  assert.equal(suspendedList.body.requests.length, 1);

  // 按新窗口重新申请
  await h.post(
    "/requests",
    dispatchBody("SEG-01", {
      request_ref: "REQ-SEG-01-DISPATCH-R2",
      window_ref: "WIN-2",
      scheduled_start: "2026-09-24T11:00:00+08:00",
      scheduled_end: "2026-09-24T12:00:00+08:00",
    })
  );
  const reissued = await h.post("/requests/REQ-SEG-01-DISPATCH-R2/issue", {});
  assert.equal(reissued.status, 200);

  // 反查可见变化影响，而不只是最终状态
  const trace = await h.get("/segments/SEG-01/trace");
  const dispatchHistory = trace.body.actions.dispatch;
  const oldOne = dispatchHistory.find((item) => item.request_ref === "REQ-SEG-01-DISPATCH");
  assert.equal(oldOne.change_impacts[0].change_ref, "CHG-WATER-1");
  assert.ok(trace.body.timeline.some((item) => item.type === "request.suspended"));
});

test("缆索吊故障挂起许可，复检失败继续阻断，复检通过后恢复签发", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  // 先完成发运与倒驳
  await h.post("/requests", dispatchBody("SEG-01"));
  await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  await h.post("/requests/REQ-SEG-01-DISPATCH/complete", {});
  await h.post("/admin/evidence", {
    segment_ref: "SEG-01",
    revision: 1,
    kind: "transfer_handover",
    result: "pass",
    ref: "DOC-SEG-01-HANDOVER",
  });
  await h.post("/requests", transshipBody("SEG-01"));
  await h.post("/requests/REQ-SEG-01-TRANSSHIP/issue", {});
  await h.post("/requests/REQ-SEG-01-TRANSSHIP/complete", {});

  await h.post("/requests", hoistBody("SEG-01"));
  const issued = await h.post("/requests/REQ-SEG-01-HOIST/issue", {});
  assert.equal(issued.status, 200);

  // 设备故障
  const failure = await h.post("/changes", {
    change_ref: "CHG-EQ-1",
    type: "equipment",
    summary: "缆索吊制动系统异常",
    hoists: [{ hoist_ref: "H-1", status: "out_of_service" }],
  });
  assert.equal(failure.status, 201);
  const impact = failure.body.impacts.find((item) => item.request_ref === "REQ-SEG-01-HOIST");
  assert.equal(impact.after_status, "suspended");
  assert.ok(impact.blockers.some((b) => b.code === "hoist_unavailable"));

  // 修复后复检不合格
  await h.post("/changes", {
    change_ref: "CHG-RI-1",
    type: "reinspection",
    rechecks: [
      { resource_type: "hoist", resource_ref: "H-1", result: "fail", note: "限位仍有偏差" },
    ],
  });
  const stillBlocked = await h.post("/requests/REQ-SEG-01-HOIST/issue", {});
  assert.equal(stillBlocked.status, 412);
  assert.ok(codes(stillBlocked.body).includes("hoist_recheck_failed"));

  // 设备恢复可用且复检通过：签发成功
  await h.post("/changes", {
    change_ref: "CHG-EQ-2",
    type: "equipment",
    summary: "缆索吊修复",
    hoists: [{ hoist_ref: "H-1", status: "available" }],
  });
  await h.post("/changes", {
    change_ref: "CHG-RI-2",
    type: "reinspection",
    rechecks: [
      { resource_type: "hoist", resource_ref: "H-1", result: "pass", note: "复检合格" },
    ],
  });
  const reissued = await h.post("/requests/REQ-SEG-01-HOIST/issue", {});
  assert.equal(reissued.status, 200);
  const completed = await h.post("/requests/REQ-SEG-01-HOIST/complete", {});
  assert.equal(completed.status, 200);
});

test("环保禁限时段：禁止时段不可豁免，限制时段凭豁免签发", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  // SEG-01 发运 07:00-08:00 落在禁止时段
  await h.post("/admin/restrictions", {
    starts_at: "2026-09-24T06:30:00+08:00",
    ends_at: "2026-09-24T07:30:00+08:00",
    kind: "鱼类洄游",
    level: "prohibit",
  });
  await h.post("/requests", dispatchBody("SEG-01"));
  const prohibited = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(prohibited.status, 412);
  assert.ok(codes(prohibited.body).includes("environmental_prohibited"));

  // SEG-02 发运 14:00-14:30 落在限制时段：先缺豁免，补全局豁免后放行
  await h.post("/admin/restrictions", {
    starts_at: "2026-09-24T13:30:00+08:00",
    ends_at: "2026-09-24T15:30:00+08:00",
    kind: "噪声管控",
    level: "restrict",
  });
  await h.post(
    "/requests",
    dispatchBody("SEG-02", {
      scheduled_start: "2026-09-24T14:00:00+08:00",
      scheduled_end: "2026-09-24T14:30:00+08:00",
    })
  );
  const noWaiver = await h.post("/requests/REQ-SEG-02-DISPATCH/issue", {});
  assert.equal(noWaiver.status, 412);
  assert.ok(codes(noWaiver.body).includes("environmental_waiver_missing"));

  await h.post("/admin/evidence", {
    kind: "environmental_waiver",
    result: "pass",
    ref: "WAIVER-NOISE-0924",
    valid_from: "2026-09-24T13:00:00+08:00",
    valid_until: "2026-09-24T16:00:00+08:00",
    recorded_by: "环保监理",
  });
  const waived = await h.post("/requests/REQ-SEG-02-DISPATCH/issue", {});
  assert.equal(waived.status, 200);
});

test("构件版本升级：旧申请作废，必须按新版本重新取证、重新申报", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  await h.post("/requests", dispatchBody("SEG-01"));
  const issued = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(issued.status, 200);

  // 制造厂发布第 2 版（几何修正，重量变化）
  const upgraded = await h.post("/admin/segments/revision", {
    segment_ref: "SEG-01",
    revision: 2,
    weight: 126,
    detail: { change_note: "匹配件几何修正" },
  });
  assert.equal(upgraded.status, 201);
  assert.equal(upgraded.body.current_revision, 2);

  // 旧版本申请已作废，租约释放
  const oldOne = await h.get("/requests/REQ-SEG-01-DISPATCH");
  assert.equal(oldOne.body.status, "cancelled");

  // 按旧版本重新申报：版本失配
  await h.post("/requests", dispatchBody("SEG-01", { request_ref: "REQ-OLD-REV" }));
  const mismatch = await h.post("/requests/REQ-OLD-REV/issue", {});
  assert.equal(mismatch.status, 412);
  assert.ok(codes(mismatch.body).includes("revision_mismatch"));

  // 按新版本申报但证据/配载缺失
  await h.post(
    "/requests",
    dispatchBody("SEG-01", {
      request_ref: "REQ-NEW-REV",
      revision: 2,
    })
  );
  const missing = await h.post("/requests/REQ-NEW-REV/issue", {});
  assert.equal(missing.status, 412);
  assert.ok(codes(missing.body).includes("evidence_missing"));
  assert.ok(codes(missing.body).includes("loading_not_recorded"));

  for (const kind of ["fabrication_acceptance", "preassembly_acceptance"]) {
    await h.post("/admin/evidence", {
      segment_ref: "SEG-01",
      revision: 2,
      kind,
      result: "pass",
      ref: `DOC-SEG-01-R2-${kind}`,
    });
  }
  await h.post("/admin/loadings", {
    vessel_ref: "V-1",
    segment_ref: "SEG-01",
    revision: 2,
    load: 160,
    draft: 2.1,
  });
  const ok = await h.post("/requests/REQ-NEW-REV/issue", {});
  assert.equal(ok.status, 200);
});

test("船舶超载/吃水超限、航道水深不足、缆索吊超能力均被拦截", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h, { segmentCount: 1 });

  // 超载
  await h.post("/admin/loadings", {
    vessel_ref: "V-1",
    segment_ref: "SEG-01",
    revision: 1,
    load: 520,
    draft: 2.0,
  });
  await h.post("/requests", dispatchBody("SEG-01"));
  let denied = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.ok(codes(denied.body).includes("vessel_overloaded"));

  // 吃水超过船舶限值
  await h.post("/admin/loadings", {
    vessel_ref: "V-1",
    segment_ref: "SEG-01",
    revision: 1,
    load: 150,
    draft: 2.8,
  });
  denied = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.ok(codes(denied.body).includes("vessel_draft_exceeds"));

  // 航道变浅
  await h.post("/admin/loadings", {
    vessel_ref: "V-1",
    segment_ref: "SEG-01",
    revision: 1,
    load: 150,
    draft: 2.0,
  });
  await h.post("/admin/channel-readings", { point_ref: "P-1", depth: 1.5 });
  denied = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.ok(codes(denied.body).includes("channel_too_shallow"));

  // 恢复水深后发运通过
  await h.post("/admin/channel-readings", { point_ref: "P-1", depth: 6.0 });
  const passed = await h.post("/requests/REQ-SEG-01-DISPATCH/issue", {});
  assert.equal(passed.status, 200);

  // 缆索吊能力不足
  await h.post("/admin/hoists", { hoist_ref: "H-1", capacity: 100 });
  await h.post("/requests", hoistBody("SEG-01"));
  denied = await h.post("/requests/REQ-SEG-01-HOIST/issue", {});
  assert.ok(codes(denied.body).includes("hoist_capacity_exceeded"));
});

test("同时到达的并发签发：同一缆索吊只有一个申请生效", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h);

  // 两节段各自完成发运与倒驳（时间错开，不占用同一时段的船）
  const slots = {
    "SEG-01": ["2026-09-24T07:00:00+08:00", "2026-09-24T08:00:00+08:00"],
    "SEG-02": ["2026-09-24T08:00:00+08:00", "2026-09-24T09:00:00+08:00"],
  };
  for (const ref of ["SEG-01", "SEG-02"]) {
    const [start, end] = slots[ref];
    await h.post("/requests", dispatchBody(ref, { scheduled_start: start, scheduled_end: end }));
    await h.post(`/requests/REQ-${ref}-DISPATCH/issue`, {});
    await h.post(`/requests/REQ-${ref}-DISPATCH/complete`, {});
    await h.post("/admin/evidence", {
      segment_ref: ref,
      revision: 1,
      kind: "transfer_handover",
      result: "pass",
      ref: `DOC-${ref}-HANDOVER`,
    });
    await h.post(
      "/requests",
      transshipBody(ref, {
        scheduled_start: end,
        scheduled_end: new Date(Date.parse(end) + 3600_000).toISOString(),
      })
    );
    await h.post(`/requests/REQ-${ref}-TRANSSHIP/issue`, {});
    await h.post(`/requests/REQ-${ref}-TRANSSHIP/complete`, {});
  }

  // 两份起吊申请完全重叠
  await h.post("/requests", hoistBody("SEG-01", { request_ref: "REQ-RACE-1" }));
  await h.post(
    "/requests",
    hoistBody("SEG-02", {
      request_ref: "REQ-RACE-2",
      scheduled_start: "2026-09-24T11:00:00+08:00",
      scheduled_end: "2026-09-24T12:00:00+08:00",
    })
  );

  const [a, b] = await Promise.all([
    h.post("/requests/REQ-RACE-1/issue", {}),
    h.post("/requests/REQ-RACE-2/issue", {}),
  ]);

  // 恰好一个 200，一个 412（谁先拿到写锁不影响结果）
  assert.deepEqual([a.status, b.status].sort(), [200, 412]);
  const loser = a.status === 412 ? a.body : b.body;
  assert.ok(codes(loser).includes("hoist_lease_conflict"));

  const issued = await h.get("/requests?status=issued");
  const raceWinners = issued.body.requests.filter((item) =>
    ["REQ-RACE-1", "REQ-RACE-2"].includes(item.request_ref)
  );
  assert.equal(raceWinners.length, 1);
});

test("三十七个节段按既定序列合龙，节点反查保留全部制造运输交接安装证据", async (context) => {
  const h = await startHarness();
  context.after(h.stop);
  await seedScenario(h, { segmentCount: 37 });

  for (let i = 1; i <= 37; i += 1) {
    const ref = `SEG-${String(i).padStart(2, "0")}`;
    await fullChain(h, ref);
  }

  const closure = await h.get("/closure");
  assert.equal(closure.body.total_segments, 37);
  assert.equal(closure.body.installed_segments, 37);
  assert.equal(closure.body.closure_complete, true);
  assert.equal(closure.body.next_pending, null);
  const orders = closure.body.sequence.map((item) => item.install_order);
  assert.deepEqual(orders, Array.from({ length: 37 }, (_, i) => i + 1));

  const trace = await h.get("/segments/SEG-19/trace");
  const evidenceKinds = trace.body.evidence.map((item) => item.kind);
  for (const kind of ["fabrication_acceptance", "preassembly_acceptance", "transfer_handover"]) {
    assert.ok(evidenceKinds.includes(kind), `缺少证据 ${kind}`);
  }
  for (const action of ["dispatch", "transship", "hoist", "install"]) {
    assert.equal(trace.body.actions[action].length, 1);
    assert.equal(trace.body.actions[action][0].status, "completed");
    assert.equal(trace.body.actions[action][0].gate.ok, true);
  }
  // 时间线里既有证据也有每个动作的生命周期事件
  assert.ok(trace.body.timeline.some((item) => item.type === "evidence"));
  for (const event of ["request.created", "request.issued", "request.completed"]) {
    assert.ok(trace.body.timeline.some((item) => item.type === event), `时间线缺少 ${event}`);
  }
});
