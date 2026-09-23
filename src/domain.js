
// 领域核心：以构件版本与既定安装序列为主线
// 规则：只有“前序证据”与“当前窗口”同时成立，下一动作才可签发。

const STAGES = ["fabricated", "accepted", "transported", "transferred", "installed"];
const STAGE_LABEL = {
  fabricated: "制造",
  accepted: "预拼验收",
  transported: "运输",
  transferred: "倒驳交接",
  installed: "安装",
};
const ACTION_LABEL = { transport: "运输", transfer: "倒驳交接", hoist: "起吊安装" };

// 每个动作要求已成立（最新复检通过）的前序阶段
const ACTION_PRECEDENCE = {
  transport: ["fabricated", "accepted"],
  transfer: ["transported"],
  hoist: ["transferred"],
};
const ACTION_RESOURCE = { transport: "vessel", transfer: "vessel", hoist: "hoist" };
const ACTION_RESULT_STAGE = { transport: "transported", transfer: "transferred", hoist: "installed" };
const BAN_SCOPES = {
  transport: ["navigation", "all"],
  transfer: ["navigation", "all"],
  hoist: ["hoist", "all"],
};

function nowIso() {
  return new Date().toISOString();
}

function rowOrNull(statement, ...params) {
  return statement.get(...params) ?? null;
}

// ---------------------------------------------------------------------------
// 基础登记
// ---------------------------------------------------------------------------

function registerSegment(db, { segment_ref, revision = 1, weight_t, length_m, install_order, closure_group = "main", note }) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO segments(segment_ref, revision, status, install_order, closure_group, weight_t, length_m, updated_at)
     VALUES (?, ?, 'registered', ?, ?, ?, ?, ?)
     ON CONFLICT(segment_ref) DO NOTHING`
  ).run(segment_ref, revision, install_order ?? null, closure_group, weight_t, length_m ?? null, ts);
  db.prepare(
    `INSERT INTO segment_revisions(segment_ref, revision, weight_t, length_m, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(segment_ref, revision) DO NOTHING`
  ).run(segment_ref, revision, weight_t, length_m ?? null, note ?? null, ts);
  if (install_order != null) {
    db.prepare(
      `INSERT INTO install_plan(closure_group, install_order, segment_ref)
       VALUES (?, ?, ?)
       ON CONFLICT(closure_group, install_order) DO UPDATE SET segment_ref = excluded.segment_ref`
    ).run(closure_group, install_order, segment_ref);
  }
  return getSegment(db, segment_ref);
}

// 构件升版：旧版本证据不再满足新版本闸门
function bumpSegmentRevision(db, { segment_ref, weight_t, length_m, note }) {
  const segment = getSegment(db, segment_ref);
  if (!segment) throw Object.assign(new Error("segment_not_found"), { status: 404 });
  const revision = segment.revision + 1;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO segment_revisions(segment_ref, revision, weight_t, length_m, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(segment_ref, revision, weight_t ?? segment.weight_t, length_m ?? segment.length_m, note ?? null, ts);
  db.prepare(`UPDATE segments SET revision = ?, weight_t = ?, length_m = COALESCE(?, length_m), updated_at = ? WHERE segment_ref = ?`)
    .run(revision, weight_t ?? segment.weight_t, length_m ?? null, ts, segment_ref);
  return getSegment(db, segment_ref);
}

function getSegment(db, segmentRef) {
  return rowOrNull(db.prepare(`SELECT * FROM segments WHERE segment_ref = ?`), segmentRef);
}

function upsertVessel(db, v) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO vessels(vessel_ref, kind, name, capacity_t, draft_m, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vessel_ref) DO UPDATE SET
       kind=excluded.kind, name=excluded.name, capacity_t=excluded.capacity_t,
       draft_m=excluded.draft_m, status=excluded.status, note=excluded.note, updated_at=excluded.updated_at`
  ).run(v.vessel_ref, v.kind || "vessel", v.name ?? null, v.capacity_t, v.draft_m, v.status || "available", v.note ?? null, ts);
  return db.prepare(`SELECT * FROM vessels WHERE vessel_ref = ?`).get(v.vessel_ref);
}

function setDeviceStatus(db, resourceType, resourceRef, status, note) {
  const ts = nowIso();
  const table = resourceType === "hoist" ? "hoists" : "vessels";
  const result = db.prepare(`UPDATE ${table} SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE ${resourceType === "hoist" ? "hoist_ref" : "vessel_ref"} = ?`)
    .run(status, note ?? null, ts, resourceRef);
  if (result.changes === 0) throw Object.assign(new Error("device_not_found"), { status: 404 });
  // 设备状态变化立即重算受影响环节
  return recomputeImpact(db, { trigger_type: "device_status", trigger_ref: `${resourceType}:${resourceRef}` });
}

function upsertHoist(db, h) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO hoists(hoist_ref, name, capacity_t, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hoist_ref) DO UPDATE SET
       name=excluded.name, capacity_t=excluded.capacity_t,
       status=excluded.status, note=excluded.note, updated_at=excluded.updated_at`
  ).run(h.hoist_ref, h.name ?? null, h.capacity_t, h.status || "available", h.note ?? null, ts);
  return db.prepare(`SELECT * FROM hoists WHERE hoist_ref = ?`).get(h.hoist_ref);
}

function setBankReady(db, bankRef, ready, note) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO banks(bank_ref, name, ready, ready_since, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bank_ref) DO UPDATE SET ready=excluded.ready,
       ready_since=CASE WHEN excluded.ready=1 THEN COALESCE(banks.ready_since, excluded.ready_since) ELSE NULL END,
       note=excluded.note, updated_at=excluded.updated_at`
  ).run(bankRef, bankRef, ready ? 1 : 0, ready ? ts : null, note ?? null, ts);
  return db.prepare(`SELECT * FROM banks WHERE bank_ref = ?`).get(bankRef);
}

function publishWaterWindow(db, w) {
  const ts = nowIso();
  // 同航道时间重叠的旧窗口被新调度取代
  if (w.supersede !== false) {
    db.prepare(
      `UPDATE water_windows SET valid = 0, superseded_by = ?
       WHERE channel_ref = ? AND valid = 1 AND ? < ends_at AND starts_at < ?`
    ).run(w.window_ref, w.channel_ref, w.starts_at, w.ends_at);
  }
  db.prepare(
    `INSERT INTO water_windows(window_ref, channel_ref, level_m, min_depth_m, starts_at, ends_at, source, valid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(window_ref) DO UPDATE SET
       channel_ref=excluded.channel_ref, level_m=excluded.level_m, min_depth_m=excluded.min_depth_m,
       starts_at=excluded.starts_at, ends_at=excluded.ends_at, source=excluded.source, valid=1, created_at=excluded.created_at`
  ).run(w.window_ref, w.channel_ref, w.level_m ?? null, w.min_depth_m, w.starts_at, w.ends_at, w.source ?? null, ts);

  const report = recomputeImpact(db, { trigger_type: "water_window", trigger_ref: w.window_ref });
  return { window: db.prepare(`SELECT * FROM water_windows WHERE window_ref = ?`).get(w.window_ref), impact: report };
}

function addChannelObservation(db, { channel_ref, depth_m, observed_at, note }) {
  const info = db.prepare(
    `INSERT INTO channel_observations(channel_ref, depth_m, observed_at, note) VALUES (?, ?, ?, ?)`
  ).run(channel_ref, depth_m, observed_at || nowIso(), note ?? null);
  return db.prepare(`SELECT * FROM channel_observations WHERE observation_id = ?`).get(Number(info.lastInsertRowid));
}

function addEnvironmentalBan(db, b) {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO environmental_bans(ban_ref, scope, starts_at, ends_at, reason, valid, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(ban_ref) DO UPDATE SET scope=excluded.scope, starts_at=excluded.starts_at,
       ends_at=excluded.ends_at, reason=excluded.reason, valid=1, created_at=excluded.created_at`
  ).run(b.ban_ref, b.scope, b.starts_at, b.ends_at, b.reason ?? null, ts);
  const report = recomputeImpact(db, { trigger_type: "environmental_ban", trigger_ref: b.ban_ref });
  return { ban: db.prepare(`SELECT * FROM environmental_bans WHERE ban_ref = ?`).get(b.ban_ref), impact: report };
}

// ---------------------------------------------------------------------------
// 证据事件（只追加）
// ---------------------------------------------------------------------------

function appendEvent(db, e) {
  const segment = getSegment(db, e.segment_ref);
  if (!segment) throw Object.assign(new Error("segment_not_found"), { status: 404 });
  const revision = e.revision ?? segment.revision;
  if (!STAGES.includes(e.stage)) throw Object.assign(new Error("bad_stage"), { status: 400 });
  if (e.event_type === "recheck" && !["pass", "fail"].includes(e.disposition)) {
    throw Object.assign(new Error("recheck_needs_disposition"), { status: 400 });
  }
  const ts = nowIso();
  const payload = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload ?? {});
  const info = db.prepare(
    `INSERT INTO evidence_events(segment_ref, revision, stage, event_type, occurred_at, recorded_at,
       actor_ref, payload_json, source_digest, supersedes_event, disposition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.segment_ref, revision, e.stage, e.event_type || "evidence", e.occurred_at || ts, ts,
    e.actor_ref ?? null, payload, e.source_digest ?? null, e.supersedes_event ?? null,
    e.event_type === "recheck" ? e.disposition : null
  );
  // 非复检的里程碑事件同步节段状态
  if (e.event_type !== "recheck") {
    db.prepare(`UPDATE segments SET status = ?, updated_at = ? WHERE segment_ref = ?`)
      .run(e.stage, ts, e.segment_ref);
  }
  const event = db.prepare(`SELECT * FROM evidence_events WHERE event_id = ?`).get(Number(info.lastInsertRowid));

  // 复检结论立即影响后续环节
  let impact = null;
  if (e.event_type === "recheck") {
    impact = recomputeImpact(db, {
      trigger_type: "recheck",
      trigger_ref: `${e.segment_ref}:${e.stage}:${event.event_id}`,
    });
  }
  return { event, impact };
}

// 某节段某阶段在指定版本上的证据与最新复检结论
function evidenceState(db, segmentRef, revision, stage) {
  const base = db.prepare(
    `SELECT * FROM evidence_events
     WHERE segment_ref = ? AND revision = ? AND stage = ? AND event_type != 'recheck'
     ORDER BY event_id DESC LIMIT 1`
  ).get(segmentRef, revision, stage);
  if (!base) return { present: false, pass: false, reason: "missing" };
  const rechecks = db.prepare(
    `SELECT * FROM evidence_events WHERE event_type = 'recheck' AND supersedes_event = ? ORDER BY event_id`
  ).all(base.event_id);
  const latest = rechecks.at(-1);
  if (latest && latest.disposition === "fail") {
    return { present: true, pass: false, reason: "recheck_failed", evidence: base, recheck: latest };
  }
  return { present: true, pass: true, reason: latest ? "recheck_passed" : "accepted", evidence: base, recheck: latest ?? null };
}

function eventsOf(db, segmentRef) {
  return db.prepare(
    `SELECT * FROM evidence_events WHERE segment_ref = ? ORDER BY event_id`
  ).all(segmentRef).map(parseEvent);
}

function parseEvent(row) {
  return { ...row, payload: JSON.parse(row.payload_json || "{}") };
}

// ---------------------------------------------------------------------------
// 闸门：前序证据 + 当前窗口同时成立
// ---------------------------------------------------------------------------

function activeBans(db, scopes, at) {
  return db.prepare(
    `SELECT * FROM environmental_bans WHERE valid = 1 AND scope IN (${scopes.map(() => "?").join(",")})
     AND starts_at <= ? AND ? < ends_at ORDER BY starts_at`
  ).all(...scopes, at, at);
}

function currentWindow(db, windowRef, at) {
  if (!windowRef) return null;
  const window = db.prepare(`SELECT * FROM water_windows WHERE window_ref = ?`).get(windowRef);
  if (!window) return { missing: true };
  if (!window.valid) return { window, invalid: true };
  if (!(window.starts_at <= at && at < window.ends_at)) return { window, not_open: true };
  return { window, open: true };
}

function latestDepth(db, channelRef, at) {
  const row = db.prepare(
    `SELECT * FROM channel_observations WHERE channel_ref = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1`
  ).get(channelRef, at);
  return row ? row.depth_m : null;
}

function predecessorPlanRow(db, segment) {
  if (segment.install_order == null) return null;
  return db.prepare(
    `SELECT * FROM install_plan WHERE closure_group = ? AND install_order < ?
     ORDER BY install_order DESC LIMIT 1`
  ).get(segment.closure_group, segment.install_order);
}

function computeGate(db, input) {
  const at = input.at || nowIso();
  const action = input.action;
  const checks = [];
  const push = (code, label, ok, detail = {}) => checks.push({ code, label, ok, detail });
  const fail = (code, label, detail) => {
    push(code, label, false, detail);
    return { ok: false, action, at, checks };
  };

  if (!ACTION_PRECEDENCE[action]) return { ok: false, action, at, checks: [{ code: "bad_action", label: "未知动作", ok: false }] };

  const segment = getSegment(db, input.segment_ref);
  if (!segment) return fail("segment_missing", "节段已登记", { segment_ref: input.segment_ref });
  push("revision", `构件版本有效（当前 v${segment.revision}）`, true, { segment_ref: segment.segment_ref, revision: segment.revision });

  // 1a) 当前版本上任一既有证据若最新复检不通过，后续动作全部阻断（不分阶段）
  for (const stage of STAGES) {
    const state = evidenceState(db, segment.segment_ref, segment.revision, stage);
    if (state.present && !state.pass) {
      return fail(`recheck_${stage}`, `证据复检：${STAGE_LABEL[stage]}（最新复检未通过）`, {
        stage, reason: state.reason, recheck_event_id: state.recheck?.event_id,
      });
    }
  }

  // 1b) 前序证据：必须是当前版本且最新复检通过
  for (const stage of ACTION_PRECEDENCE[action]) {
    const state = evidenceState(db, segment.segment_ref, segment.revision, stage);
    if (!state.present) {
      return fail(`precedence_${stage}`, `前序证据：${STAGE_LABEL[stage]}`, { required: stage, reason: "missing" });
    }
    push(`precedence_${stage}`, `前序证据：${STAGE_LABEL[stage]}（v${segment.revision}）`, true, {
      event_id: state.evidence.event_id, recheck_event_id: state.recheck?.event_id ?? null,
    });
  }

  // 2) 既定安装序列：起吊前前序节段必须已安装
  if (action === "hoist") {
    const predecessor = predecessorPlanRow(db, segment);
    if (predecessor) {
      const installedAny = db.prepare(
        `SELECT 1 FROM evidence_events e JOIN segments s ON s.segment_ref = e.segment_ref
         WHERE e.segment_ref = ? AND e.stage = 'installed' AND e.event_type != 'recheck'
           AND NOT EXISTS (
             SELECT 1 FROM evidence_events r WHERE r.event_type='recheck' AND r.supersedes_event = e.event_id AND r.disposition='fail'
           ) LIMIT 1`
      ).get(predecessor.segment_ref);
      if (!installedAny) {
        return fail("predecessor_installed", `合龙顺序：前序节段 ${predecessor.segment_ref} 已安装`, {
          predecessor: predecessor.segment_ref, install_order: predecessor.install_order,
        });
      }
      push("predecessor_installed", `合龙顺序：前序节段 ${predecessor.segment_ref} 已安装`, true, {
        predecessor: predecessor.segment_ref, install_order: predecessor.install_order,
      });
    }
  }

  // 3) 资源存在、可用、能力足够
  const resourceType = ACTION_RESOURCE[action];
  const resource = resourceType === "hoist"
    ? db.prepare(`SELECT * FROM hoists WHERE hoist_ref = ?`).get(input.resource_ref)
    : db.prepare(`SELECT * FROM vessels WHERE vessel_ref = ?`).get(input.resource_ref);
  if (!resource) return fail("resource_missing", resourceType === "hoist" ? "缆索吊已登记" : "船舶已登记", { resource_ref: input.resource_ref });
  const capLabel = resourceType === "hoist" ? "缆索吊能力" : "船舶载荷";
  if (resource.status !== "available") return fail("resource_status", `${capLabel}：设备可用`, { resource_ref: input.resource_ref, status: resource.status });
  if (resource.capacity_t < segment.weight_t) {
    return fail("capacity", `${capLabel}满足节段重量`, { capacity_t: resource.capacity_t, weight_t: segment.weight_t });
  }
  push("resource_status", `${capLabel}：设备可用`, true, { resource_ref: input.resource_ref, capacity_t: resource.capacity_t });
  push("capacity", `${capLabel}满足节段重量（${segment.weight_t}t）`, true, { capacity_t: resource.capacity_t, weight_t: segment.weight_t });

  // 4) 当前窗口：水位窗口有效且正开启
  const windowState = currentWindow(db, input.window_ref, at);
  if (!input.window_ref || windowState?.missing) {
    return fail("window_present", "当前水位窗口已指定", { window_ref: input.window_ref ?? null });
  }
  if (windowState.invalid) return fail("window_valid", "水位窗口仍有效（未被新调度取代）", { window_ref: input.window_ref });
  if (windowState.not_open) {
    return fail("window_open", "当前时间处于水位窗口内", {
      window_ref: input.window_ref, starts_at: windowState.window.starts_at, ends_at: windowState.window.ends_at, at,
    });
  }
  const window = windowState.window;
  push("window_valid", `水位窗口 ${window.window_ref} 有效且开启`, true, {
    starts_at: window.starts_at, ends_at: window.ends_at, level_m: window.level_m, source: window.source,
  });

  // 5) 航道水深（仅船运/倒驳）：吃水不超过实测水深
  if (resourceType === "vessel") {
    const observed = latestDepth(db, window.channel_ref, at);
    const effectiveDepth = observed ?? window.min_depth_m;
    const depthSource = observed == null ? "window_min_depth" : "channel_observation";
    if (resource.draft_m > effectiveDepth) {
      return fail("channel_depth", "航道水深满足船舶吃水", {
        draft_m: resource.draft_m, effective_depth_m: effectiveDepth, depth_source: depthSource, channel_ref: window.channel_ref,
      });
    }
    push("channel_depth", `航道水深满足吃水（${resource.draft_m}m ≤ ${effectiveDepth}m）`, true, {
      draft_m: resource.draft_m, effective_depth_m: effectiveDepth, depth_source: depthSource, channel_ref: window.channel_ref,
    });
  }

  // 6) 两岸条件（起吊）：南北两岸必须均已登记且具备
  if (action === "hoist") {
    const requiredBanks = ["NORTH", "SOUTH"];
    const banks = requiredBanks.map((ref) => db.prepare(`SELECT * FROM banks WHERE bank_ref = ?`).get(ref));
    const notReady = requiredBanks.filter((ref, i) => !banks[i] || !banks[i].ready);
    if (notReady.length > 0) {
      return fail("banks_ready", "两岸起吊条件具备", { banks: requiredBanks.map((ref, i) => ({ bank_ref: ref, ready: !!banks[i]?.ready })) });
    }
    push("banks_ready", "两岸起吊条件具备", true, { banks: requiredBanks });
  }

  // 7) 环保禁限时段
  const bans = activeBans(db, BAN_SCOPES[action], at);
  if (bans.length > 0) {
    return fail("environmental_ban", "当前不在环保禁限时段", { bans: bans.map((b) => ({ ban_ref: b.ban_ref, scope: b.scope, reason: b.reason })) });
  }
  push("environmental_ban", "当前不在环保禁限时段", true);

  // 8) 同节段同动作不得重复占用
  const duplicate = db.prepare(
    `SELECT * FROM permits WHERE segment_ref = ? AND action = ? AND status = 'issued' AND valid_from <= ? AND ? < valid_until
     ORDER BY permit_id DESC LIMIT 1`
  ).get(segment.segment_ref, action, at, at);
  if (duplicate) return fail("active_permit", "同节段同动作无重复生效许可", { permit_id: duplicate.permit_id });
  push("active_permit", "同节段同动作无重复生效许可", true);

  return {
    ok: true, action, at, segment_ref: segment.segment_ref, revision: segment.revision,
    resource_type: resourceType, resource_ref: input.resource_ref, window_ref: input.window_ref,
    window_ends_at: window.ends_at, checks,
  };
}

// ---------------------------------------------------------------------------
// 许可签发：闸门通过 + 资源互斥（同一资源并发只准一个生效）
// ---------------------------------------------------------------------------

function requestPermit(db, input) {
  return db.execSafeTransaction(() => {
    const gate = computeGate(db, input);
    if (!gate.ok) {
      return { granted: false, status: 422, gate };
    }
    const validFrom = gate.at;
    const validUntil = input.valid_until || gate.window_ends_at;
    const ts = nowIso();
    const permitInfo = db.prepare(
      `INSERT INTO permits(segment_ref, revision, action, resource_type, resource_ref, window_ref,
         valid_from, valid_until, status, issued_at, gate_report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`
    ).run(
      gate.segment_ref, gate.revision, gate.action, gate.resource_type, gate.resource_ref,
      gate.window_ref, validFrom, validUntil, ts, JSON.stringify(gate)
    );
    const permitId = Number(permitInfo.lastInsertRowid);
    try {
      db.prepare(
        `INSERT INTO resource_grants(resource_type, resource_ref, permit_id, granted_at) VALUES (?, ?, ?, ?)`
      ).run(gate.resource_type, gate.resource_ref, permitId, ts);
    } catch (error) {
      // 唯一部分索引：同一吊装/运输资源已有未释放授权。
      // 删除本次未获资源授权的许可行，保证“并发申请只准一个生效”不留残记录。
      db.prepare(`DELETE FROM permits WHERE permit_id = ?`).run(permitId);
      const holder = db.prepare(
        `SELECT permit_id FROM resource_grants WHERE resource_type = ? AND resource_ref = ? AND released_at IS NULL`
      ).get(gate.resource_type, gate.resource_ref);
      return {
        granted: false, status: 409, gate,
        conflict: { resource_type: gate.resource_type, resource_ref: gate.resource_ref, held_by_permit: holder?.permit_id ?? null },
      };
    }
    return { granted: true, status: 201, permit: getPermit(db, permitId) };
  })();
}

function getPermit(db, permitId) {
  const row = db.prepare(`SELECT * FROM permits WHERE permit_id = ?`).get(permitId);
  if (!row) return null;
  return { ...row, gate_report: JSON.parse(row.gate_report_json) };
}

function releaseGrant(db, permitId, ts) {
  db.prepare(`UPDATE resource_grants SET released_at = ? WHERE permit_id = ? AND released_at IS NULL`).run(ts, permitId);
}

// 完成动作：记录里程碑证据并释放资源
function completePermit(db, permitId, completion = {}) {
  return db.execSafeTransaction(() => {
    const permit = getPermit(db, permitId);
    if (!permit) throw Object.assign(new Error("permit_not_found"), { status: 404 });
    if (permit.status !== "issued") throw Object.assign(new Error(`permit_${permit.status}`), { status: 409 });
    const at = completion.occurred_at || nowIso();
    const stage = ACTION_RESULT_STAGE[permit.action];
    const appended = appendEvent(db, {
      segment_ref: permit.segment_ref,
      revision: permit.revision,
      stage,
      event_type: "evidence",
      occurred_at: at,
      actor_ref: completion.actor_ref,
      payload: { permit_id: permit.permit_id, resource_ref: permit.resource_ref, window_ref: permit.window_ref, ...(completion.payload ?? {}) },
      source_digest: completion.source_digest,
    });
    const ts = nowIso();
    db.prepare(`UPDATE permits SET status = 'completed', completed_at = ? WHERE permit_id = ?`).run(ts, permitId);
    releaseGrant(db, permitId, ts);
    return { permit: getPermit(db, permitId), event: parseEvent(appended.event) };
  })();
}

function _voidPermits(db, selectSql, params, reason) {
  const ts = nowIso();
  const rows = db.prepare(selectSql).all(...params);
  for (const row of rows) {
    db.prepare(`UPDATE permits SET status = 'voided', voided_at = ?, void_reason = ? WHERE permit_id = ?`).run(ts, reason, row.permit_id);
    releaseGrant(db, row.permit_id, ts);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 变化即重算：水位 / 设备 / 复检 / 环保
// ---------------------------------------------------------------------------

function pendingPlan(db, closureGroup = "main") {
  return db.prepare(
    `SELECT p.*, s.status AS segment_status, s.revision, s.weight_t
       FROM install_plan p JOIN segments s ON s.segment_ref = p.segment_ref
      WHERE p.closure_group = ?
      ORDER BY p.install_order`
  ).all(closureGroup);
}

function isInstalled(db, segmentRef) {
  const row = db.prepare(
    `SELECT e.event_id FROM evidence_events e
      WHERE e.segment_ref = ? AND e.stage = 'installed' AND e.event_type != 'recheck'
        AND NOT EXISTS (SELECT 1 FROM evidence_events r WHERE r.event_type='recheck'
              AND r.supersedes_event = e.event_id AND r.disposition='fail')
      ORDER BY e.event_id DESC LIMIT 1`
  ).get(segmentRef);
  return !!row;
}

function recomputeImpact(db, { trigger_type, trigger_ref }) {
  return db.execSafeTransaction(() => {
    const at = nowIso();
    const voided = [];
    const affectedSegments = new Map();
    const remember = (segmentRef, reason) => {
      if (!segmentRef) return;
      if (!affectedSegments.has(segmentRef)) affectedSegments.set(segmentRef, new Set());
      affectedSegments.get(segmentRef).add(reason);
    };

    if (trigger_type === "water_window") {
      // 覆盖新窗口本身及被本次调度发布取代（superseded_by）的旧窗口
      const windows = db.prepare(
        `SELECT * FROM water_windows WHERE window_ref = ? OR superseded_by = ?`
      ).all(trigger_ref, trigger_ref);
      for (const window of windows) {
        // 窗口失效或当前时间已不在窗口内：其签发的未完成许可立即吊销，释放吊装/运输资源
        const targets = db.prepare(
          `SELECT p.* FROM permits p JOIN water_windows w ON w.window_ref = p.window_ref
           WHERE p.status = 'issued' AND p.window_ref = ?
             AND (w.valid = 0 OR ? < w.starts_at OR ? >= w.ends_at)`
        ).all(window.window_ref, at, at);
        for (const target of targets) {
          db.prepare(`UPDATE permits SET status = 'voided', voided_at = ?, void_reason = ? WHERE permit_id = ? AND status = 'issued'`)
            .run(at, `water_window_changed:${trigger_ref}`, target.permit_id);
          releaseGrant(db, target.permit_id, at);
          voided.push(target.permit_id);
          remember(target.segment_ref, "permit_voided_window");
        }
      }
      // 所有尚未安装的节段都需按新窗口重新复核
      for (const step of pendingPlan(db)) {
        if (!isInstalled(db, step.segment_ref)) remember(step.segment_ref, "window_schedule_review");
      }
    } else if (trigger_type === "device_status") {
      const [rtype, rref] = trigger_ref.split(":");
      const device = rtype === "hoist"
        ? db.prepare(`SELECT * FROM hoists WHERE hoist_ref = ?`).get(rref)
        : db.prepare(`SELECT * FROM vessels WHERE vessel_ref = ?`).get(rref);
      if (device && device.status !== "available") {
        const rows = _voidPermits(
          db,
          `SELECT * FROM permits WHERE status = 'issued' AND resource_type = ? AND resource_ref = ?`,
          [rtype, rref],
          `device_unavailable:${trigger_ref}`
        );
        rows.forEach((r) => { voided.push(r.permit_id); remember(r.segment_ref, "permit_voided_device"); });
        for (const step of pendingPlan(db)) {
          if (!isInstalled(db, step.segment_ref) && (step.segment_status === "transported" || step.segment_status === "transferred" || step.segment_status === "accepted")) {
            remember(step.segment_ref, "resource_reschedule");
          }
        }
      }
    } else if (trigger_type === "recheck") {
      const [segmentRef, stage] = trigger_ref.split(":");
      const segment = getSegment(db, segmentRef);
      if (segment) {
        const state = evidenceState(db, segmentRef, segment.revision, stage);
        if (!state.pass) {
          const rows = _voidPermits(
            db,
            `SELECT * FROM permits WHERE status = 'issued' AND segment_ref = ?`,
            [segmentRef],
            `recheck_failed:${stage}`
          );
          rows.forEach((r) => voided.push(r.permit_id));
          // 该节段及其后所有未安装节段（合龙顺序被阻断）
          let blocking = false;
          for (const step of pendingPlan(db, segment.closure_group)) {
            if (step.segment_ref === segmentRef) blocking = true;
            if (blocking && !isInstalled(db, step.segment_ref)) {
              remember(step.segment_ref, step.segment_ref === segmentRef ? `recheck_failed:${stage}` : "predecessor_blocked");
            }
          }
        }
      }
    } else if (trigger_type === "environmental_ban") {
      const ban = db.prepare(`SELECT * FROM environmental_bans WHERE ban_ref = ?`).get(trigger_ref);
      if (ban) {
        const rows = _voidPermits(
          db,
          `SELECT p.* FROM permits p
            WHERE p.status='issued' AND p.valid_from < ? AND ? < p.valid_until
              AND ((? IN ('navigation','all') AND p.action IN ('transport','transfer'))
                OR (? IN ('hoist','all') AND p.action = 'hoist'))`,
          [ban.ends_at, ban.starts_at, ban.scope, ban.scope],
          `environmental_ban:${trigger_ref}`
        );
        rows.forEach((r) => { voided.push(r.permit_id); remember(r.segment_ref, "permit_voided_ban"); });
      }
    }

    const affected = [...affectedSegments.entries()].map(([segment_ref, reasons]) => ({
      segment_ref, reasons: [...reasons],
    }));
    const detail = { at, voided_permit_ids: voided, affected_segments: affected };
    const info = db.prepare(
      `INSERT INTO impact_reports(trigger_type, trigger_ref, computed_at, affected_json, detail_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(trigger_type, trigger_ref, at, JSON.stringify(affected.map((a) => a.segment_ref)), JSON.stringify(detail));
    return { report_id: Number(info.lastInsertRowid), ...detail };
  })();
}

// ---------------------------------------------------------------------------
// 合龙与反查
// ---------------------------------------------------------------------------

function closeClosure(db, closureGroup = "main") {
  return db.execSafeTransaction(() => {
    const plan = pendingPlan(db, closureGroup);
    if (plan.length === 0) throw Object.assign(new Error("empty_plan"), { status: 422 });
    const missing = [];
    for (const step of plan) {
      if (!isInstalled(db, step.segment_ref)) missing.push(step.segment_ref);
    }
    if (missing.length > 0) {
      throw Object.assign(new Error("closure_incomplete"), { status: 422, detail: { missing_install: missing } });
    }
    const ts = nowIso();
    const evidenceCount = db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_events e JOIN install_plan p ON p.segment_ref = e.segment_ref
       WHERE p.closure_group = ?`
    ).get(closureGroup).n;
    db.prepare(
      `INSERT INTO closures(closure_group, closed_at, total_segments, evidence_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(closure_group) DO UPDATE SET closed_at=excluded.closed_at,
         total_segments=excluded.total_segments, evidence_count=excluded.evidence_count`
    ).run(closureGroup, ts, plan.length, evidenceCount);
    return db.prepare(`SELECT * FROM closures WHERE closure_group = ?`).get(closureGroup);
  })();
}

function traceSegment(db, segmentRef) {
  const segment = getSegment(db, segmentRef);
  if (!segment) return null;
  const revisions = db.prepare(`SELECT * FROM segment_revisions WHERE segment_ref = ? ORDER BY revision`).all(segmentRef);
  const planRow = db.prepare(`SELECT * FROM install_plan WHERE segment_ref = ?`).get(segmentRef);
  const events = eventsOf(db, segmentRef);
  const permits = db.prepare(`SELECT * FROM permits WHERE segment_ref = ? ORDER BY permit_id`).all(segmentRef)
    .map((p) => ({ ...p, gate_report: JSON.parse(p.gate_report_json) }));
  // 分阶段证据视图：每阶段的证据 + 复检链
  const stages = STAGES.map((stage) => {
    const evidence = db.prepare(
      `SELECT * FROM evidence_events WHERE segment_ref = ? AND stage = ? ORDER BY event_id`
    ).all(segmentRef, stage).map(parseEvent);
    return { stage, label: STAGE_LABEL[stage], events: evidence };
  });
  return { segment, plan: planRow, revisions, stages, events, permits };
}

function planOverview(db, closureGroup = "main") {
  const steps = pendingPlan(db, closureGroup);
  return steps.map((step) => {
    const states = {};
    for (const stage of STAGES) states[stage] = evidenceState(db, step.segment_ref, step.revision, stage);
    return {
      ...step,
      installed: isInstalled(db, step.segment_ref),
      evidence: Object.fromEntries(STAGES.map((s) => [s, { present: states[s].present, pass: states[s].pass, reason: states[s].reason }])),
    };
  });
}

// 为 DatabaseSync 补事务辅助（node:sqlite 无原生 transaction()），支持嵌套保存点
function installTransactionHelper(db) {
  if (typeof db.execSafeTransaction === "function") return db;
  let depth = 0;
  db.execSafeTransaction = (fn) => (...args) => {
    const savepoint = `sp_${depth}`;
    if (depth === 0) db.exec("BEGIN IMMEDIATE");
    else db.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn(...args);
      depth -= 1;
      if (depth === 0) db.exec("COMMIT");
      else db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      depth -= 1;
      if (depth === 0) {
        try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      } else {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch { /* 保存点已不存在 */ }
      }
      throw error;
    }
  };
  return db;
}

module.exports = {
  STAGES, STAGE_LABEL, ACTION_LABEL,
  nowIso, installTransactionHelper,
  registerSegment, bumpSegmentRevision, getSegment,
  upsertVessel, upsertHoist, setDeviceStatus, setBankReady,
  publishWaterWindow, addChannelObservation, addEnvironmentalBan,
  appendEvent, evidenceState, eventsOf,
  computeGate, requestPermit, completePermit, getPermit,
  recomputeImpact, closeClosure, traceSegment, planOverview,
  pendingPlan, isInstalled,
};
