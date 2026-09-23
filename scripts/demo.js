
// 端到端场景演示（走真实 HTTP 接口，临时数据库，不污染运行数据）：
// 1. SEGMENT-07 到达倒驳点，水电站临时改变水位窗口，现场申请提前起吊 —— 被拒
// 2. 同一缆索吊两个并发申请 —— 只准一个生效（409）
// 3. 水位/设备/复检变化 —— 立即重算受影响环节、吊销生效许可
// 4. 新窗口开启后按序列恢复作业
// 5. 合龙完成后从节点反查制造→运输→交接→安装全证据

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const { createServer } = require("../src/server");
const dom = require("../src/domain");
const { seedDatabase } = require("./seed");

const MIGRATIONS = path.join(__dirname, "..", "migrations");
const iso = (ms) => new Date(Date.now() + ms).toISOString();

function tempDb() {
  const file = path.join(require("node:os").tmpdir(), `bridge-demo-${process.pid}-${Date.now()}.sqlite3`);
  const db = new DatabaseSync(file);
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  dom.installTransactionHelper(db);
  return { db, file };
}

async function main() {
  const { db, file } = tempDb();
  seedDatabase(db, { log: () => {} });

  const server = createServer({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, body, method = "POST") => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const say = (n, text) => console.log(`\n【${n}】${text}`);

  // ---- 场景 1：提前起吊被拒（前序与窗口双闸） ----
  say(1, "现场申请 SEGMENT-07 提前起吊（当前窗口 WIN-NAV-01 开启，证据齐全时本应通过）");
  let r = await call("/permits", { segment_ref: "SEGMENT-07", action: "hoist", resource_ref: "HOIST-N1", window_ref: "WIN-NAV-01" });
  console.log(r.status === 201 ? `  许可 #${r.data.permit.permit_id} 签发（占用 HOIST-N1）` : r.data);
  const heldPermitId = r.data.permit.permit_id;

  say("1b", "上游水电站临时调度：发布 3 小时后才开启的新窗口 WIN-EMG-02，旧窗口被取代");
  r = await call("/water-windows", {
    window_ref: "WIN-EMG-02", channel_ref: "CH-WUJIANG-1", level_m: 214.1, min_depth_m: 1.5,
    starts_at: iso(3 * 3600e3), ends_at: iso(9 * 3600e3), source: "上游水电站临时调度 0923-T",
  });
  console.log(`  旧许可被吊销：${r.data.impact.voided_permit_ids.join(",") || "无"}；受影响节段数：${r.data.impact.affected_segments.length}`);
  r = await call(`/permits/${heldPermitId}`, undefined, "GET");
  console.log(`  原许可 #${heldPermitId} 状态：${r.data.status}（${r.data.void_reason}）`);

  say("1c", "现场仍申请用新窗口“提前起吊”——窗口未开启，闸门拒绝");
  r = await call("/permits", { segment_ref: "SEGMENT-07", action: "hoist", resource_ref: "HOIST-N1", window_ref: "WIN-EMG-02" });
  console.log(`  HTTP ${r.status}，首个失败闸门：${r.data.gate.checks.find((c) => !c.ok).label}`);

  // ---- 场景 2：同一吊装/运输资源并发只准一个生效 ----
  say(2, "水电站发布即刻开启的修正窗口 WIN-EMG-03；先按序列完成 SEGMENT-07 起吊");
  await call("/water-windows", {
    window_ref: "WIN-EMG-03", channel_ref: "CH-WUJIANG-1", level_m: 217.0, min_depth_m: 2.0,
    starts_at: iso(-60e3), ends_at: iso(4 * 3600e3), source: "水电站修正调度 0923-R",
  });
  let h07 = await call("/permits", { segment_ref: "SEGMENT-07", action: "hoist", resource_ref: "HOIST-N1", window_ref: "WIN-EMG-03" });
  await call(`/permits/${h07.data.permit.permit_id}/complete`, { actor_ref: "RIGGER-N" });
  console.log(`  SEGMENT-07 许可 #${h07.data.permit.permit_id} 完成并释放 HOIST-N1`);

  say("2b", "SEGMENT-08 与 SEGMENT-09（均已预拼验收）同时申请 VESSEL-A 运输，只准一个生效");
  const [a, b] = await Promise.all([
    call("/permits", { segment_ref: "SEGMENT-08", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-EMG-03" }),
    call("/permits", { segment_ref: "SEGMENT-09", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-EMG-03" }),
  ]);
  const ok = [a, b].filter((x) => x.status === 201);
  const conflict = [a, b].find((x) => x.status === 409);
  console.log(`  成功签发 ${ok.length} 个，冲突拒绝 ${conflict ? `1 个（VESSEL-A 被许可 #${conflict.data.conflict.held_by_permit} 占用）` : "0 个"}`);
  // 释放演示占用，便于后续重排
  await call(`/permits/${ok[0].data.permit.permit_id}/complete`, { actor_ref: "CREW-A" });
  console.log(`  许可 #${ok[0].data.permit.permit_id} 完成，资源释放`);

  // ---- 场景 3：设备故障与复检失败立即重算 ----
  say(3, "设备变化：VESSEL-A 故障停用，所有其生效许可被吊销，待运节段进入重排");
  // 先签发一张运输许可制造“生效中”状态
  const t = await call("/permits", { segment_ref: "SEGMENT-08", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-EMG-03" });
  console.log(`  SEGMENT-08 运输许可 #${t.data.permit?.permit_id} 签发`);
  r = await call("/devices/status", { resource_type: "vessel", resource_ref: "VESSEL-A", status: "out_of_service", note: "舵机异常" });
  console.log(`  吊销许可：${r.data.impact.voided_permit_ids.join(",")}；受影响节段示例：${r.data.impact.affected_segments.slice(0, 3).map((x) => x.segment_ref).join("、")}…`);
  r = await call("/permits", { segment_ref: "SEGMENT-09", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-EMG-03" });
  console.log(`  故障期间再申请：HTTP ${r.status}，失败闸门：${r.data.gate?.checks.find((c) => !c.ok)?.label || "无"}`);

  say("3b", "复检变化：SEGMENT-08 预拼验收复检不通过，其后续环节及合龙顺序被阻断");
  const ev = await call("/events?segment_ref=SEGMENT-08", undefined, "GET");
  const acceptedEvent = ev.data.events.find((e) => e.stage === "accepted" && e.event_type !== "recheck");
  r = await call("/events", { segment_ref: "SEGMENT-08", stage: "accepted", event_type: "recheck", disposition: "fail", supersedes_event: acceptedEvent.event_id, note: "焊缝抽检不合格" });
  console.log(`  受阻断节段：${r.data.impact.affected_segments.map((x) => x.segment_ref).slice(0, 4).join("、")}…（含其后未安装节段）`);
  r = await call("/gate/evaluate", { segment_ref: "SEGMENT-08", action: "transport", resource_ref: "BARGE-B", window_ref: "WIN-EMG-03" });
  console.log(`  闸门：${r.data.ok ? "通过（异常！）" : `拒绝 — ${r.data.checks.find((c) => !c.ok).label}`}`);

  // 恢复：设备修复 + 复检通过
  await call("/devices/status", { resource_type: "vessel", resource_ref: "VESSEL-A", status: "available", note: "舵机修复" });
  await call("/events", { segment_ref: "SEGMENT-08", stage: "accepted", event_type: "recheck", disposition: "pass", supersedes_event: acceptedEvent.event_id, note: "返修后复检合格" });
  console.log("  设备恢复、复检通过后，后续环节解除阻断");

  // ---- 场景 4：新窗口内按序列推进（抽样 SEGMENT-08） ----
  say(4, "按既定序列恢复：SEGMENT-08 运输 → 倒驳交接 → 等待 SEGMENT-07 之后起吊");
  let p = await call("/permits", { segment_ref: "SEGMENT-08", action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-EMG-03" });
  await call(`/permits/${p.data.permit.permit_id}/complete`, { actor_ref: "CREW-A" });
  p = await call("/permits", { segment_ref: "SEGMENT-08", action: "transfer", resource_ref: "BARGE-B", window_ref: "WIN-EMG-03" });
  await call(`/permits/${p.data.permit.permit_id}/complete`, { actor_ref: "CREW-B" });
  p = await call("/permits", { segment_ref: "SEGMENT-08", action: "hoist", resource_ref: "HOIST-N1", window_ref: "WIN-EMG-03" });
  console.log(p.status === 201 ? `  SEGMENT-08 起吊许可 #${p.data.permit.permit_id}（前序 SEGMENT-07 已安装，顺序满足）` :
    `  起吊被拒：${p.data.gate.checks.find((c) => !c.ok)?.label}`);
  await call(`/permits/${p.data.permit.permit_id}/complete`, { actor_ref: "RIGGER-N" });

  // ---- 场景 5：合龙前拦截，合龙后反查 ----
  say(5, "合龙校验：尚有 29 个节段未安装时关闭合龙节点 —— 拒绝");
  r = await call("/closure/close", {});
  console.log(`  HTTP ${r.status}：${r.data.error}，缺失 ${r.data.detail.missing_install.length} 节段`);

  say("5b", "按序列补齐 SEGMENT-09..37 全部证据与安装（系统强制顺序），再合龙");
  for (let i = 9; i <= 37; i += 1) {
    const ref = `SEGMENT-${String(i).padStart(2, "0")}`;
    // 16..37 尚只有登记，先补制造与预拼验收证据（复检合格状态）
    if (i >= 16) {
      await call("/events", { segment_ref: ref, stage: "fabricated", event_type: "evidence", actor_ref: "FAB-SHOP" });
      await call("/events", { segment_ref: ref, stage: "accepted", event_type: "evidence", actor_ref: "QC-TEAM" });
    }
    for (const [action, resource, complete] of [
      ["transport", "VESSEL-A", "CREW-A"],
      ["transfer", "BARGE-B", "CREW-B"],
      ["hoist", "HOIST-N1", "RIGGER-N"],
    ]) {
      const g = await call("/permits", { segment_ref: ref, action, resource_ref: resource, window_ref: "WIN-EMG-03" });
      if (g.status !== 201) throw new Error(`${ref} ${action} 未签发：${g.data.gate?.checks.find((c) => !c.ok)?.label}`);
      await call(`/permits/${g.data.permit.permit_id}/complete`, { actor_ref: complete });
    }
  }
  r = await call("/closure/close", {});
  console.log(`  合龙完成：${r.data.closure_group}，节段 ${r.data.total_segments}，留存证据事件 ${r.data.evidence_count} 条`);

  const trace = await call("/segments/SEGMENT-07/trace", undefined, "GET");
  say("5c", "从合龙节点反查 SEGMENT-07 的完整经历（不只最终状态）：");
  for (const stage of trace.data.stages) {
    for (const ev of stage.events) {
      const kind = ev.event_type === "recheck" ? `复检${ev.disposition === "pass" ? "通过" : "不通过"}` : stage.label;
      console.log(`  · ${kind.padEnd(6)} v${ev.revision}  ${ev.occurred_at}  主体=${ev.actor_ref ?? "-"}  ${ev.source_digest ? ev.source_digest.slice(0, 21) + "…" : ""}`);
    }
  }
  console.log(`  许可留痕 ${trace.data.permits.length} 条（含被水位变更吊销的记录）：`);
  for (const p of trace.data.permits) {
    console.log(`    #${p.permit_id} ${p.action} → ${p.resource_ref} [${p.status}]${p.void_reason ? " " + p.void_reason : ""}`);
  }

  server.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(file + suffix); } catch { /* 忽略 */ }
  }
  console.log("\n演示完成。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
