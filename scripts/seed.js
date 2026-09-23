
// 种子数据：37 节段合龙序列、运输船、缆索吊、两岸条件、当前水位窗口、环保禁限时段。
// 主体均为不含真实身份信息的引用编号；时间为 ISO 8601 带偏移量。

const dom = require("../src/domain");
const crypto = require("node:crypto");

function digestOf(ref, stage) {
  return "sha256:" + crypto.createHash("sha256").update(`${ref}:${stage}`).digest("hex");
}

function iso(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedDatabase(db, options = {}) {
  dom.installTransactionHelper(db);
  const log = options.log ?? (() => {});

  // 既定合龙序列：SEGMENT-01 … SEGMENT-37
  for (let i = 1; i <= 37; i += 1) {
    const ref = `SEGMENT-${String(i).padStart(2, "0")}`;
    const weight = 120 + (i % 5) * 12; // 120–168 t
    dom.registerSegment(db, {
      segment_ref: ref,
      weight_t: weight,
      length_m: 12,
      install_order: i,
      closure_group: "main",
      note: `乌江特大桥主跨节段 ${i}`,
    });
  }

  // 运输船 / 驳船
  dom.upsertVessel(db, { vessel_ref: "VESSEL-A", name: "浅水运输船A", capacity_t: 300, draft_m: 1.6 });
  dom.upsertVessel(db, { vessel_ref: "BARGE-B", kind: "barge", name: "倒驳驳船B", capacity_t: 220, draft_m: 1.2 });

  // 缆索吊（两岸）
  dom.upsertHoist(db, { hoist_ref: "HOIST-N1", name: "北岸缆索吊", capacity_t: 260 });
  dom.upsertHoist(db, { hoist_ref: "HOIST-S1", name: "南岸缆索吊", capacity_t: 200 });

  // 两岸起吊条件具备
  dom.setBankReady(db, "NORTH", true, "北岸锚锭、牵引系统验收完成");
  dom.setBankReady(db, "SOUTH", true, "南岸扣挂系统具备条件");

  // 当前水位窗口（上游水电站当日调度），含航道实测水深
  dom.publishWaterWindow(db, {
    window_ref: "WIN-NAV-01",
    channel_ref: "CH-WUJIANG-1",
    level_m: 218.4,
    min_depth_m: 2.0,
    starts_at: iso(-2 * 3600e3),
    ends_at: iso(6 * 3600e3),
    source: "上游水电站调度计划 D-0923",
  });
  dom.addChannelObservation(db, {
    channel_ref: "CH-WUJIANG-1",
    depth_m: 2.7,
    observed_at: iso(-30 * 60e3),
    note: "航道巡航实测浅点水深",
  });

  // 环保禁限时段（当晚禁吊，不影响当前窗口）
  dom.addEnvironmentalBan(db, {
    ban_ref: "BAN-NIGHT-01",
    scope: "hoist",
    starts_at: iso(8 * 3600e3),
    ends_at: iso(16 * 3600e3),
    reason: "夜间声学管制与鱼类活动时段",
  });

  const addMilestones = (ref, stages, actorPrefix = "TEAM") => {
    for (const stage of stages) {
      dom.appendEvent(db, {
        segment_ref: ref,
        stage,
        event_type: "evidence",
        actor_ref: `${actorPrefix}-${stage.slice(0, 3).toUpperCase()}`,
        payload: { ref, stage },
        source_digest: digestOf(ref, stage),
      });
    }
  };

  // SEGMENT-01..06 已完成制造→安装（按序放行、完成）
  for (let i = 1; i <= 6; i += 1) {
    const ref = `SEGMENT-${String(i).padStart(2, "0")}`;
    addMilestones(ref, ["fabricated", "accepted"]);
    const t = dom.requestPermit(db, { segment_ref: ref, action: "transport", resource_ref: "VESSEL-A", window_ref: "WIN-NAV-01" });
    if (!t.granted) throw new Error(`种子运输许可失败 ${ref}: ${JSON.stringify(t.gate?.checks.find((c) => !c.ok))}`);
    dom.completePermit(db, t.permit.permit_id, { actor_ref: "CREW-A" });
    addMilestones(ref, ["transferred"]);
    const h = dom.requestPermit(db, { segment_ref: ref, action: "hoist", resource_ref: "HOIST-N1", window_ref: "WIN-NAV-01" });
    if (!h.granted) throw new Error(`种子起吊许可失败 ${ref}: ${JSON.stringify(h.gate?.checks.find((c) => !c.ok))}`);
    dom.completePermit(db, h.permit.permit_id, { actor_ref: "RIGGER-N", payload: { bolt_torque_checked: true } });
  }

  // SEGMENT-07 已到达倒驳点：制造、验收、运输、倒驳交接证据齐备，等待窗口起吊
  addMilestones("SEGMENT-07", ["fabricated", "accepted", "transported", "transferred"]);

  // SEGMENT-08..15 已制造并通过预拼验收，待运输
  for (let i = 8; i <= 15; i += 1) {
    addMilestones(`SEGMENT-${String(i).padStart(2, "0")}`, ["fabricated", "accepted"]);
  }

  log("种子数据完成：37 节段；SEGMENT-01..06 已安装；SEGMENT-07 在倒驳点；WIN-NAV-01 开启中。");
  return db;
}

module.exports = { seedDatabase };

if (require.main === module) {
  fs_resetAndSeed();
}

function fs_resetAndSeed() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { openDatabase } = require("../src/db");
  const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  if (process.env.RESET === "1" && fs.existsSync(databasePath)) {
    fs.rmSync(databasePath);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(databasePath + suffix)) fs.rmSync(databasePath + suffix);
    }
  }
  const db = dom.installTransactionHelper(openDatabase(databasePath));
  if (dom.getSegment(db, "SEGMENT-01") && process.env.RESET !== "1") {
    console.log("数据库已有种子数据，跳过（RESET=1 可重建）。");
  } else {
    seedDatabase(db, { log: console.log });
  }
  db.close();
  console.log(`数据库：${databasePath}`);
}
