
// 初始化 37 个节段的本地演示数据（不含真实身份，全部为受控引用编号）。
// 默认在已有节段数据时拒绝执行；RESET=1 时先清空领域表再写入。

const path = require("node:path");
const { openMigratedDatabase } = require("../src/db");
const service = require("../src/service");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
const db = openMigratedDatabase(databasePath);

const TZ = "+08:00";
const iso = (value) => `${value}${TZ}`;
const count = Number.parseInt(process.env.SEGMENT_COUNT || "37", 10);

try {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM segments").get().n;
  if (existing > 0 && process.env.RESET !== "1") {
    console.log(`已存在 ${existing} 个节段，跳过种子写入；如需重建请设置 RESET=1。`);
    process.exit(0);
  }
  if (existing > 0) {
    db.exec(
      `DELETE FROM request_events;
       DELETE FROM change_impacts;
       DELETE FROM change_events;
       DELETE FROM resource_leases;
       DELETE FROM action_requests;
       DELETE FROM resource_rechecks;
       DELETE FROM channel_readings;
       DELETE FROM vessel_loadings;
       DELETE FROM evidence;
       DELETE FROM segment_revisions;
       DELETE FROM segments;
       DELETE FROM environmental_restrictions;
       DELETE FROM water_windows;
       DELETE FROM vessels;
       DELETE FROM hoists;
       DELETE FROM banks;`
    );
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      db.exec("DELETE FROM sqlite_sequence;");
    }
  }

  // 水位窗口：覆盖整个合龙作业期的调度窗口（示例值，非真实调度）
  service.registerWindow(db, {
    window_ref: "WIN-DEMO-1",
    starts_at: iso("2026-09-25T06:00:00"),
    ends_at: iso("2026-10-31T20:00:00"),
    level_min: 218.0,
    level_max: 222.0,
    source: "水电站调度（示例窗口）",
  });

  service.registerVessel(db, { vessel_ref: "VESSEL-A", max_load: 500, max_draft: 2.5 });
  service.registerVessel(db, { vessel_ref: "VESSEL-B", max_load: 420, max_draft: 2.2 });
  service.registerHoist(db, { hoist_ref: "HOIST-MAIN", capacity: 600 });
  service.registerBank(db, { bank_ref: "BANK-N", side: "north", ready: true });
  service.registerBank(db, { bank_ref: "BANK-S", side: "south", ready: true });
  service.recordChannelReading(db, { point_ref: "CH-PT-01", depth: 6.0 });
  service.recordChannelReading(db, { point_ref: "CH-PT-02", depth: 5.5 });
  service.recordChannelReading(db, { point_ref: "CH-PT-03", depth: 5.8 });

  for (let i = 1; i <= count; i += 1) {
    const ref = `SEG-${String(i).padStart(2, "0")}`;
    const weight = 110 + (i % 5) * 4; // 110~126 吨
    service.registerSegment(db, {
      segment_ref: ref,
      install_order: i,
      name: `节段 ${i}`,
      revision: 1,
      weight,
      length_m: 12,
    });
    for (const kind of ["fabrication_acceptance", "preassembly_acceptance"]) {
      service.addEvidence(db, {
        segment_ref: ref,
        revision: 1,
        kind,
        result: "pass",
        ref: `DOC-${ref}-R1-${kind}`,
        sha256: `sha256:${ref}-r1-${kind}`,
        recorded_by: "QC-DEMO",
      });
    }
    service.recordLoading(db, {
      vessel_ref: "VESSEL-A",
      segment_ref: ref,
      revision: 1,
      load: weight + 24, // 含工装
      draft: 2.0,
    });
  }

  console.log(`种子数据完成：${count} 个节段、${count * 2} 份验收证据、2 艘船、1 套缆索吊、两岸与 3 个航道点。`);
  console.log(`数据库：${databasePath}`);
} finally {
  db.close();
}
