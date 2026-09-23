
// 协同服务：登记、申请、签发门事务、变更影响传播、节点反查

const { evaluateGate, CHAIN } = require("./gate");

function nowIso() {
  return new Date().toISOString();
}

// 事务包装：异常自动回滚；CommitSignal 表示先提交再把信号里的错误抛给调用方
class CommitSignal {
  constructor(error) {
    this.error = error;
  }
}

function transaction(db, immediate, fn) {
  db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
  let done = false;
  let signal = null;
  try {
    const result = fn();
    db.exec("COMMIT");
    done = true;
    return result;
  } catch (error) {
    if (error instanceof CommitSignal) {
      db.exec("COMMIT");
      done = true;
      signal = error;
    } else {
      throw error;
    }
  } finally {
    if (!done) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 连接已释放时忽略
      }
    }
  }
  if (signal) throw signal.error;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class DomainError extends Error {
  constructor(status, code, detail = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function requireBody(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null);
  if (missing.length > 0) throw new DomainError(400, "missing_fields", { fields: missing });
}

// ---------- 登记 ----------

function registerSegment(db, body) {
  requireBody(body, ["segment_ref", "install_order", "revision", "weight"]);
  const ts = nowIso();
  const existing = db.prepare("SELECT segment_ref FROM segments WHERE segment_ref = ?").get(body.segment_ref);
  if (existing) throw new DomainError(409, "segment_exists", { segment_ref: body.segment_ref });
  const orderTaken = db.prepare("SELECT segment_ref FROM segments WHERE install_order = ?").get(body.install_order);
  if (orderTaken) {
    throw new DomainError(409, "install_order_taken", {
      install_order: body.install_order,
      segment_ref: orderTaken.segment_ref,
    });
  }
  transaction(db, false, () => {
    db.prepare(
      `INSERT INTO segments(segment_ref, install_order, name, current_revision, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(body.segment_ref, body.install_order, body.name || null, body.revision, ts);
    db.prepare(
      `INSERT INTO segment_revisions(segment_ref, revision, weight, length_m, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      body.segment_ref,
      body.revision,
      body.weight,
      body.length_m ?? null,
      body.detail ? JSON.stringify(body.detail) : null,
      ts
    );
  });
  return getSegment(db, body.segment_ref);
}

function registerRevision(db, body) {
  requireBody(body, ["segment_ref", "revision", "weight"]);
  const segment = db.prepare("SELECT * FROM segments WHERE segment_ref = ?").get(body.segment_ref);
  if (!segment) throw new DomainError(404, "segment_unknown", { segment_ref: body.segment_ref });
  if (body.revision <= segment.current_revision) {
    throw new DomainError(409, "revision_not_newer", {
      current: segment.current_revision,
      requested: body.revision,
    });
  }
  const ts = nowIso();
  transaction(db, false, () => {
    db.prepare(
      `INSERT INTO segment_revisions(segment_ref, revision, weight, length_m, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      body.segment_ref,
      body.revision,
      body.weight,
      body.length_m ?? null,
      body.detail ? JSON.stringify(body.detail) : null,
      ts
    );
    // 版本升级：该节段所有未完成的申请立即失效，必须按新版本重新取证申请
    db.prepare(
      `UPDATE resource_leases SET released_at = ?
       WHERE released_at IS NULL AND request_ref IN (
         SELECT request_ref FROM action_requests
         WHERE segment_ref = ? AND status IN ('pending', 'issued', 'suspended'))`
    ).run(ts, body.segment_ref);
    db.prepare(
      `UPDATE action_requests SET status = 'cancelled', updated_at = ?, decision_note = ?
       WHERE segment_ref = ? AND status IN ('pending', 'issued', 'suspended')`
    ).run(ts, `构件版本升级为 ${body.revision}，按旧版本提出的申请作废`, body.segment_ref);
    db.prepare("UPDATE segments SET current_revision = ? WHERE segment_ref = ?").run(
      body.revision,
      body.segment_ref
    );
  });
  return getSegment(db, body.segment_ref);
}

function getSegment(db, segmentRef) {
  const segment = db.prepare("SELECT * FROM segments WHERE segment_ref = ?").get(segmentRef);
  if (!segment) throw new DomainError(404, "segment_unknown", { segment_ref: segmentRef });
  segment.revisions = db
    .prepare(
      "SELECT revision, weight, length_m, detail, created_at FROM segment_revisions WHERE segment_ref = ? ORDER BY revision"
    )
    .all(segmentRef)
    .map((row) => ({ ...row, detail: parseJson(row.detail) }));
  return segment;
}

function addEvidence(db, body) {
  requireBody(body, ["kind", "result"]);
  const isGlobal = body.segment_ref === null || body.segment_ref === undefined;
  if (!isGlobal) {
    if (body.revision === undefined || body.revision === null) {
      throw new DomainError(400, "missing_fields", { fields: ["revision"] });
    }
    const revision = db
      .prepare("SELECT 1 FROM segment_revisions WHERE segment_ref = ? AND revision = ?")
      .get(body.segment_ref, body.revision);
    if (!revision) throw new DomainError(404, "revision_unknown", { revision: body.revision });
  }
  if (!["pass", "fail", "note"].includes(body.result)) {
    throw new DomainError(400, "bad_result", { allowed: ["pass", "fail", "note"] });
  }
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO evidence(segment_ref, revision, kind, result, ref, sha256, valid_from, valid_until,
                            recorded_by, recorded_at, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      isGlobal ? null : body.segment_ref,
      isGlobal ? null : body.revision,
      body.kind,
      body.result,
      body.ref || null,
      body.sha256 || null,
      body.valid_from || null,
      body.valid_until || null,
      body.recorded_by || null,
      body.recorded_at || ts,
      body.detail ? JSON.stringify(body.detail) : null,
      ts
    );
  return db.prepare("SELECT * FROM evidence WHERE evidence_id = ?").get(Number(info.lastInsertRowid));
}

function registerWindow(db, body) {
  requireBody(body, ["window_ref", "starts_at", "ends_at"]);
  if (Date.parse(body.starts_at) >= Date.parse(body.ends_at)) {
    throw new DomainError(400, "bad_window_range", null);
  }
  const ts = nowIso();
  db.prepare(
    `INSERT INTO water_windows(window_ref, starts_at, ends_at, level_min, level_max, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(window_ref) DO UPDATE SET
       starts_at=excluded.starts_at, ends_at=excluded.ends_at,
       level_min=excluded.level_min, level_max=excluded.level_max,
       source=excluded.source, status='active', replaced_by=NULL`
  ).run(
    body.window_ref,
    body.starts_at,
    body.ends_at,
    body.level_min ?? null,
    body.level_max ?? null,
    body.source || null,
    ts
  );
  return db.prepare("SELECT * FROM water_windows WHERE window_ref = ?").get(body.window_ref);
}

function addEnvironmentalRestriction(db, body) {
  requireBody(body, ["starts_at", "ends_at", "level"]);
  if (!["prohibit", "restrict"].includes(body.level)) {
    throw new DomainError(400, "bad_level", { allowed: ["prohibit", "restrict"] });
  }
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO environmental_restrictions(starts_at, ends_at, kind, level, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(body.starts_at, body.ends_at, body.kind || null, body.level, body.note || null, ts);
  return db
    .prepare("SELECT * FROM environmental_restrictions WHERE restriction_id = ?")
    .get(Number(info.lastInsertRowid));
}

function registerVessel(db, body) {
  requireBody(body, ["vessel_ref", "max_load", "max_draft"]);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO vessels(vessel_ref, max_load, max_draft, status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vessel_ref) DO UPDATE SET max_load=excluded.max_load, max_draft=excluded.max_draft,
       status=excluded.status, updated_at=excluded.updated_at`
  ).run(body.vessel_ref, body.max_load, body.max_draft, body.status || "available", ts);
  return db.prepare("SELECT * FROM vessels WHERE vessel_ref = ?").get(body.vessel_ref);
}

function registerHoist(db, body) {
  requireBody(body, ["hoist_ref", "capacity"]);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO hoists(hoist_ref, capacity, status, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(hoist_ref) DO UPDATE SET capacity=excluded.capacity, status=excluded.status,
       updated_at=excluded.updated_at`
  ).run(body.hoist_ref, body.capacity, body.status || "available", ts);
  return db.prepare("SELECT * FROM hoists WHERE hoist_ref = ?").get(body.hoist_ref);
}

function registerBank(db, body) {
  requireBody(body, ["bank_ref"]);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO banks(bank_ref, side, ready, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(bank_ref) DO UPDATE SET side=excluded.side, ready=excluded.ready, updated_at=excluded.updated_at`
  ).run(body.bank_ref, body.side || null, body.ready === false ? 0 : 1, ts);
  return db.prepare("SELECT * FROM banks WHERE bank_ref = ?").get(body.bank_ref);
}

function recordLoading(db, body) {
  requireBody(body, ["vessel_ref", "segment_ref", "revision", "load", "draft"]);
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO vessel_loadings(vessel_ref, segment_ref, revision, load, draft, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(body.vessel_ref, body.segment_ref, body.revision, body.load, body.draft, body.recorded_at || ts);
  return db.prepare("SELECT * FROM vessel_loadings WHERE loading_id = ?").get(Number(info.lastInsertRowid));
}

function recordChannelReading(db, body) {
  requireBody(body, ["point_ref", "depth"]);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO channel_readings(point_ref, depth, recorded_at)
     VALUES (?, ?, ?)
     ON CONFLICT(point_ref) DO UPDATE SET depth=excluded.depth, recorded_at=excluded.recorded_at`
  ).run(body.point_ref, body.depth, body.recorded_at || ts);
  return db.prepare("SELECT * FROM channel_readings WHERE point_ref = ?").get(body.point_ref);
}

// ---------- 申请 / 签发 / 完成 ----------

function createRequest(db, body) {
  requireBody(body, [
    "request_ref",
    "segment_ref",
    "revision",
    "action",
    "scheduled_start",
    "scheduled_end",
  ]);
  if (!CHAIN.includes(body.action)) throw new DomainError(400, "bad_action", { allowed: CHAIN });
  if (Date.parse(body.scheduled_start) >= Date.parse(body.scheduled_end)) {
    throw new DomainError(400, "bad_schedule_range", null);
  }
  if (db.prepare("SELECT 1 FROM action_requests WHERE request_ref = ?").get(body.request_ref)) {
    throw new DomainError(409, "request_exists", { request_ref: body.request_ref });
  }
  const segment = db.prepare("SELECT * FROM segments WHERE segment_ref = ?").get(body.segment_ref);
  if (!segment) throw new DomainError(404, "segment_unknown", { segment_ref: body.segment_ref });
  const revision = db
    .prepare("SELECT 1 FROM segment_revisions WHERE segment_ref = ? AND revision = ?")
    .get(body.segment_ref, body.revision);
  if (!revision) throw new DomainError(404, "revision_unknown", { revision: body.revision });

  const ts = nowIso();
  db.prepare(
    `INSERT INTO action_requests(request_ref, segment_ref, revision, action, vessel_ref, hoist_ref,
       window_ref, scheduled_start, scheduled_end, detail, requester, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    body.request_ref,
    body.segment_ref,
    body.revision,
    body.action,
    body.vessel_ref || null,
    body.hoist_ref || null,
    body.window_ref || null,
    body.scheduled_start,
    body.scheduled_end,
    body.detail ? JSON.stringify(body.detail) : null,
    body.requester || null,
    ts,
    ts
  );
  const request = getRequest(db, body.request_ref);
  const gate = evaluateGate(db, request);
  persistGate(db, request.request_ref, gate);
  addEvent(db, request, "created", gate, body.requester || null, "申请已登记，等待签发");
  return getRequestView(db, body.request_ref);
}

function persistGate(db, requestRef, gate) {
  db.prepare("UPDATE action_requests SET gate_snapshot = ?, updated_at = ? WHERE request_ref = ?").run(
    JSON.stringify({ ok: gate.ok, blockers: gate.blockers, checks: gate.checks, evaluated_at: gate.evaluated_at }),
    nowIso(),
    requestRef
  );
}

function addEvent(db, request, event, gate = null, actor = null, note = null) {
  db.prepare(
    `INSERT INTO request_events(request_ref, segment_ref, revision, action, event, gate, note, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.request_ref,
    request.segment_ref,
    request.revision,
    request.action,
    event,
    gate ? JSON.stringify({ ok: gate.ok, blockers: gate.blockers, evaluated_at: gate.evaluated_at }) : null,
    note,
    actor,
    nowIso()
  );
}

function getRequest(db, requestRef) {
  const request = db.prepare("SELECT * FROM action_requests WHERE request_ref = ?").get(requestRef);
  if (!request) throw new DomainError(404, "request_unknown", { request_ref: requestRef });
  request.detail = parseJson(request.detail, {});
  request.gate_snapshot = parseJson(request.gate_snapshot, null);
  return request;
}

function getRequestView(db, requestRef) {
  const request = getRequest(db, requestRef);
  request.leases = db
    .prepare("SELECT resource_type, resource_ref, starts_at, ends_at, granted_at, released_at FROM resource_leases WHERE request_ref = ?")
    .all(requestRef);
  return request;
}

function listRequests(db, query) {
  const where = [];
  const params = [];
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.segment_ref) {
    where.push("segment_ref = ?");
    params.push(query.segment_ref);
  }
  const sql = `SELECT request_ref, segment_ref, revision, action, status, vessel_ref, hoist_ref,
                      window_ref, scheduled_start, scheduled_end, gate_snapshot, updated_at
               FROM action_requests ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY scheduled_start, request_ref`;
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row, gate_snapshot: parseJson(row.gate_snapshot, null) }));
}

function resourcesFor(request) {
  const resources = [];
  const detail = request.detail || {};
  if (request.action === "dispatch" || request.action === "transship") {
    const vesselRef = request.vessel_ref || detail.vessel_ref;
    if (vesselRef) resources.push({ type: "vessel", ref: vesselRef });
  }
  if (request.action === "hoist" || request.action === "install") {
    const hoistRef = request.hoist_ref || detail.hoist_ref;
    if (hoistRef) resources.push({ type: "hoist", ref: hoistRef });
  }
  return resources;
}

function grantLeases(db, request) {
  const ts = nowIso();
  for (const { type, ref } of resourcesFor(request)) {
    db.prepare(
      `INSERT INTO resource_leases(resource_type, resource_ref, request_ref, starts_at, ends_at, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(type, ref, request.request_ref, request.scheduled_start, request.scheduled_end, ts);
  }
}

function releaseLeases(db, requestRef, ts = nowIso()) {
  db.prepare("UPDATE resource_leases SET released_at = ? WHERE request_ref = ? AND released_at IS NULL").run(
    ts,
    requestRef
  );
}

// 签发：BEGIN IMMEDIATE 内重算闸门并占用资源，同一并发资源只准一个申请生效
function issueRequest(db, requestRef, actor = null) {
  let gate = null;
  transaction(db, true, () => {
    const request = getRequest(db, requestRef);
    if (request.status !== "pending" && request.status !== "suspended") {
      throw new DomainError(409, "request_not_issueable", { status: request.status });
    }
    gate = evaluateGate(db, request);
    persistGate(db, requestRef, gate);
    if (!gate.ok) {
      addEvent(db, request, "issue_denied", gate, actor, "前序证据或当前窗口不成立，拒绝签发");
      throw new CommitSignal(new DomainError(412, "gate_blocked", { blockers: gate.blockers }));
    }
    releaseLeases(db, requestRef);
    grantLeases(db, request);
    db.prepare("UPDATE action_requests SET status = 'issued', decided_by = ?, decided_at = ?, updated_at = ? WHERE request_ref = ?")
      .run(actor, nowIso(), nowIso(), requestRef);
    const issued = getRequest(db, requestRef);
    addEvent(db, issued, "issued", gate, actor, "前序证据与当前窗口同时成立，许可签发");
  });
  return getRequestView(db, requestRef);
}

function completeRequest(db, requestRef, actor = null) {
  transaction(db, true, () => {
    const request = getRequest(db, requestRef);
    if (request.status !== "issued") {
      throw new DomainError(409, "request_not_issued", { status: request.status });
    }
    const gate = evaluateGate(db, request);
    if (!gate.ok) {
      // 完成前条件已被变化打破：挂起而非完成
      persistGate(db, requestRef, gate);
      releaseLeases(db, requestRef);
      db.prepare("UPDATE action_requests SET status = 'suspended', updated_at = ? WHERE request_ref = ?").run(
        nowIso(),
        requestRef
      );
      const suspended = getRequest(db, requestRef);
      addEvent(db, suspended, "suspended", gate, actor, "执行前条件失效，许可挂起");
      throw new CommitSignal(new DomainError(412, "gate_blocked", { blockers: gate.blockers }));
    }
    releaseLeases(db, requestRef);
    db.prepare("UPDATE action_requests SET status = 'completed', updated_at = ? WHERE request_ref = ?").run(
      nowIso(),
      requestRef
    );
    const completed = getRequest(db, requestRef);
    addEvent(db, completed, "completed", gate, actor, "动作完成");
  });
  return getRequestView(db, requestRef);
}

function cancelRequest(db, requestRef, actor = null, note = "人工取消") {
  transaction(db, true, () => {
    const request = getRequest(db, requestRef);
    if (request.status === "completed" || request.status === "cancelled") {
      throw new DomainError(409, "request_terminal", { status: request.status });
    }
    releaseLeases(db, requestRef);
    db.prepare("UPDATE action_requests SET status = 'cancelled', updated_at = ? WHERE request_ref = ?").run(
      nowIso(),
      requestRef
    );
    const cancelled = getRequest(db, requestRef);
    addEvent(db, cancelled, "cancelled", null, actor, note);
  });
  return getRequestView(db, requestRef);
}

// ---------- 变更与影响传播 ----------

function blockerCodes(gate) {
  return (gate?.blockers || []).map((item) => item.code).sort();
}

function recomputeActive(db, changeRef) {
  const ts = nowIso();
  const active = db
    .prepare("SELECT * FROM action_requests WHERE status IN ('pending', 'issued', 'suspended')")
    .all()
    .map((row) => ({ ...row, detail: parseJson(row.detail, {}), gate_snapshot: parseJson(row.gate_snapshot, null) }));

  const impacts = [];
  for (const request of active) {
    const before = request.status;
    const beforeCodes = blockerCodes(request.gate_snapshot);
    const gate = evaluateGate(db, request);
    let after = before;
    let note = null;

    if (before === "issued" && !gate.ok) {
      // 已签发许可的条件被打破：立即挂起并释放资源；恢复后须由控制室重新签发
      releaseLeases(db, request.request_ref, ts);
      after = "suspended";
      note = "条件变化导致许可失效，已挂起并释放资源，恢复后须重新签发";
    }
    // pending / suspended 不自动放行：只刷新闸门快照，等待显式签发

    const afterCodes = blockerCodes(gate);
    const codesChanged = JSON.stringify(beforeCodes) !== JSON.stringify(afterCodes);
    const statusChanged = before !== after;

    if (statusChanged) {
      db.prepare("UPDATE action_requests SET status = ?, updated_at = ? WHERE request_ref = ?").run(
        after,
        ts,
        request.request_ref
      );
      addEvent(db, { ...request, status: after }, "suspended", gate, changeRef, note);
    }
    persistGate(db, request.request_ref, gate);

    if (statusChanged || codesChanged) {
      db.prepare(
        `INSERT INTO change_impacts(change_ref, request_ref, segment_ref, action, before_status, after_status, blockers, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        changeRef,
        request.request_ref,
        request.segment_ref,
        request.action,
        before,
        after,
        JSON.stringify(gate.blockers),
        note ? JSON.stringify({ note }) : null,
        ts
      );
      impacts.push({
        request_ref: request.request_ref,
        segment_ref: request.segment_ref,
        action: request.action,
        before_status: before,
        after_status: after,
        blockers: gate.blockers,
        note,
      });
    }
  }
  return impacts;
}

function recordChange(db, body) {
  requireBody(body, ["type"]);
  if (!["water", "equipment", "reinspection"].includes(body.type)) {
    throw new DomainError(400, "bad_change_type", null);
  }
  const changeRef = body.change_ref || `CHG-${Date.now()}`;
  const ts = nowIso();

  if (db.prepare("SELECT 1 FROM change_events WHERE change_ref = ?").get(changeRef)) {
    throw new DomainError(409, "change_exists", { change_ref: changeRef });
  }

  const impacts = transaction(db, true, () => {
    if (body.type === "water") {
      for (const cancelled of body.cancel_windows || []) {
        db.prepare("UPDATE water_windows SET status = 'cancelled' WHERE window_ref = ?").run(cancelled);
      }
      if (body.supersede_active) {
        db.prepare("UPDATE water_windows SET status = 'superseded' WHERE status = 'active'").run();
      }
      for (const win of body.new_windows || []) {
        if (!win.window_ref || !win.starts_at || !win.ends_at) {
          throw new DomainError(400, "bad_window", win);
        }
        if (Date.parse(win.starts_at) >= Date.parse(win.ends_at)) {
          throw new DomainError(400, "bad_window_range", { window_ref: win.window_ref });
        }
        db.prepare(
          `INSERT INTO water_windows(window_ref, starts_at, ends_at, level_min, level_max, source, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
        ).run(win.window_ref, win.starts_at, win.ends_at, win.level_min ?? null, win.level_max ?? null, win.source || null, ts);
      }
      if ((body.cancel_windows || []).length === 0 && !body.supersede_active && (body.new_windows || []).length === 0) {
        throw new DomainError(400, "empty_water_change", null);
      }
    }

    if (body.type === "equipment") {
      for (const vessel of body.vessels || []) {
        if (!vessel.vessel_ref || !vessel.status) throw new DomainError(400, "bad_equipment", vessel);
        db.prepare("UPDATE vessels SET status = ?, updated_at = ? WHERE vessel_ref = ?").run(
          vessel.status,
          ts,
          vessel.vessel_ref
        );
      }
      for (const hoist of body.hoists || []) {
        if (!hoist.hoist_ref || !hoist.status) throw new DomainError(400, "bad_equipment", hoist);
        db.prepare("UPDATE hoists SET status = ?, updated_at = ? WHERE hoist_ref = ?").run(
          hoist.status,
          ts,
          hoist.hoist_ref
        );
      }
      for (const bank of body.banks || []) {
        if (!bank.bank_ref || bank.ready === undefined) throw new DomainError(400, "bad_equipment", bank);
        db.prepare("UPDATE banks SET ready = ?, updated_at = ? WHERE bank_ref = ?").run(
          bank.ready ? 1 : 0,
          ts,
          bank.bank_ref
        );
      }
      if ((body.vessels || []).length + (body.hoists || []).length + (body.banks || []).length === 0) {
        throw new DomainError(400, "empty_equipment_change", null);
      }
    }

    if (body.type === "reinspection") {
      for (const item of body.rechecks || []) {
        if (!item.resource_type || !item.resource_ref || !["pass", "fail"].includes(item.result)) {
          throw new DomainError(400, "bad_recheck", item);
        }
        db.prepare(
          `INSERT INTO resource_rechecks(resource_type, resource_ref, result, note, recorded_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(item.resource_type, item.resource_ref, item.result, item.note || null, item.recorded_at || ts);
      }
      if ((body.rechecks || []).length === 0) throw new DomainError(400, "empty_reinspection", null);
    }

    db.prepare(
      "INSERT INTO change_events(change_ref, type, summary, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(changeRef, body.type, body.summary || null, JSON.stringify(body), ts);

    const impacts = recomputeActive(db, changeRef);
    return {
      change_ref: changeRef,
      type: body.type,
      summary: body.summary || null,
      created_at: ts,
      impacts,
    };
  });
  return impacts;
}

// ---------- 反查与合龙 ----------

function traceSegment(db, segmentRef) {
  const segment = getSegment(db, segmentRef);
  const evidence = db
    .prepare("SELECT evidence_id, revision, kind, result, ref, sha256, valid_from, valid_until, recorded_by, recorded_at, detail FROM evidence WHERE segment_ref = ? ORDER BY recorded_at, evidence_id")
    .all(segmentRef)
    .map((row) => ({ ...row, detail: parseJson(row.detail) }));

  const requests = db
    .prepare("SELECT * FROM action_requests WHERE segment_ref = ? ORDER BY scheduled_start, request_ref")
    .all(segmentRef);
  const actions = {};
  for (const action of CHAIN) {
    const related = requests.filter((row) => row.action === action);
    actions[action] = related.map((row) => {
      const events = db
        .prepare("SELECT event, gate, note, actor, created_at FROM request_events WHERE request_ref = ? ORDER BY event_id")
        .all(row.request_ref)
        .map((event) => ({ ...event, gate: parseJson(event.gate) }));
      const impacts = db
        .prepare(
          `SELECT c.change_ref, c.type, c.created_at, i.before_status, i.after_status, i.blockers, i.detail
           FROM change_impacts i JOIN change_events c ON c.change_ref = i.change_ref
           WHERE i.request_ref = ? ORDER BY i.impact_id`
        )
        .all(row.request_ref)
        .map((impact) => ({ ...impact, blockers: parseJson(impact.blockers), detail: parseJson(impact.detail) }));
      return {
        request_ref: row.request_ref,
        revision: row.revision,
        status: row.status,
        vessel_ref: row.vessel_ref,
        hoist_ref: row.hoist_ref,
        window_ref: row.window_ref,
        scheduled_start: row.scheduled_start,
        scheduled_end: row.scheduled_end,
        gate: parseJson(row.gate_snapshot),
        events,
        change_impacts: impacts,
      };
    });
  }

  // 汇总时间线：制造/预拼/交接等证据 + 运输/倒驳/起吊/安装生命周期事件
  const timeline = [];
  for (const item of evidence) {
    timeline.push({
      at: item.recorded_at,
      type: "evidence",
      revision: item.revision,
      kind: item.kind,
      result: item.result,
      ref: item.ref,
    });
  }
  for (const row of requests) {
    const events = db
      .prepare("SELECT event, note, actor, created_at FROM request_events WHERE request_ref = ? ORDER BY event_id")
      .all(row.request_ref);
    for (const event of events) {
      timeline.push({
        at: event.created_at,
        type: `request.${event.event}`,
        action: row.action,
        revision: row.revision,
        request_ref: row.request_ref,
        actor: event.actor,
        note: event.note,
      });
    }
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    segment,
    evidence,
    actions,
    timeline,
  };
}

function closureStatus(db) {
  const segments = db
    .prepare(
      `SELECT s.segment_ref, s.install_order, s.current_revision,
        (SELECT COUNT(*) FROM action_requests a
          WHERE a.segment_ref = s.segment_ref AND a.revision = s.current_revision
            AND a.action = 'install' AND a.status = 'completed') AS installed
       FROM segments s ORDER BY s.install_order`
    )
    .all();
  const total = segments.length;
  const installed = segments.filter((row) => row.installed > 0).length;
  const nextPending = segments.find((row) => row.installed === 0) || null;
  return {
    total_segments: total,
    installed_segments: installed,
    remaining: total - installed,
    closure_complete: total > 0 && installed === total,
    next_pending: nextPending ? nextPending.segment_ref : null,
    sequence: segments.map((row) => ({
      install_order: row.install_order,
      segment_ref: row.segment_ref,
      current_revision: row.current_revision,
      installed: row.installed > 0,
    })),
  };
}

module.exports = {
  DomainError,
  registerSegment,
  registerRevision,
  addEvidence,
  registerWindow,
  addEnvironmentalRestriction,
  registerVessel,
  registerHoist,
  registerBank,
  recordLoading,
  recordChannelReading,
  createRequest,
  issueRequest,
  completeRequest,
  cancelRequest,
  recordChange,
  traceSegment,
  closureStatus,
  getSegment,
  getRequestView,
  listRequests,
};
