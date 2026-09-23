
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("./db");
const dom = require("./domain");

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_048_576) reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("bad_json"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function createServer(options = {}) {
  const ownDb = !options.db;
  const db = options.db || dom.installTransactionHelper(openDatabase(options.databasePath));
  dom.installTransactionHelper(db);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const segment = (p) => decodeURIComponent(p);
    try {
      if (request.method === "GET" && pathname === "/health") {
        return sendJson(response, 200, { status: "ok", time: dom.nowIso() });
      }

      // ---- 合龙序列总览 ----
      if (request.method === "GET" && pathname === "/plan") {
        const group = url.searchParams.get("closure_group") || "main";
        return sendJson(response, 200, { closure_group: group, steps: dom.planOverview(db, group) });
      }

      // ---- 节段 ----
      if (request.method === "POST" && pathname === "/segments") {
        const body = await readBody(request);
        for (const field of ["segment_ref", "weight_t"]) {
          if (body[field] == null) throw Object.assign(new Error(`missing_${field}`), { status: 400 });
        }
        return sendJson(response, 201, dom.registerSegment(db, body));
      }
      let m = pathname.match(/^\/segments\/([^/]+)\/trace$/);
      if (request.method === "GET" && m) {
        const trace = dom.traceSegment(db, segment(m[1]));
        if (!trace) throw Object.assign(new Error("segment_not_found"), { status: 404 });
        return sendJson(response, 200, trace);
      }
      m = pathname.match(/^\/segments\/([^/]+)\/revisions$/);
      if (request.method === "POST" && m) {
        const body = await readBody(request);
        return sendJson(response, 201, dom.bumpSegmentRevision(db, { segment_ref: segment(m[1]), ...body }));
      }

      // ---- 证据事件 ----
      if (request.method === "POST" && pathname === "/events") {
        const body = await readBody(request);
        if (!body.segment_ref || !body.stage) throw Object.assign(new Error("missing_segment_or_stage"), { status: 400 });
        const { event, impact } = dom.appendEvent(db, body);
        return sendJson(response, 201, { event: parseEventOut(event), impact });
      }
      if (request.method === "GET" && pathname === "/events") {
        const ref = url.searchParams.get("segment_ref");
        if (ref) return sendJson(response, 200, { events: dom.eventsOf(db, ref) });
        const rows = db.prepare(`SELECT * FROM evidence_events ORDER BY event_id DESC LIMIT 200`).all();
        return sendJson(response, 200, { events: rows.map(parseEventOut) });
      }

      // ---- 船舶 / 缆索吊 / 两岸 ----
      if (request.method === "POST" && pathname === "/vessels") {
        const body = await readBody(request);
        if (!body.vessel_ref || body.capacity_t == null || body.draft_m == null) {
          throw Object.assign(new Error("missing_vessel_fields"), { status: 400 });
        }
        return sendJson(response, 201, dom.upsertVessel(db, body));
      }
      if (request.method === "GET" && pathname === "/vessels") {
        return sendJson(response, 200, { vessels: db.prepare(`SELECT * FROM vessels ORDER BY vessel_ref`).all() });
      }
      if (request.method === "POST" && pathname === "/hoists") {
        const body = await readBody(request);
        if (!body.hoist_ref || body.capacity_t == null) throw Object.assign(new Error("missing_hoist_fields"), { status: 400 });
        return sendJson(response, 201, dom.upsertHoist(db, body));
      }
      if (request.method === "GET" && pathname === "/hoists") {
        return sendJson(response, 200, { hoists: db.prepare(`SELECT * FROM hoists ORDER BY hoist_ref`).all() });
      }
      if (request.method === "POST" && pathname === "/devices/status") {
        const body = await readBody(request);
        if (!body.resource_type || !body.resource_ref || !body.status) throw Object.assign(new Error("missing_fields"), { status: 400 });
        const impact = dom.setDeviceStatus(db, body.resource_type, body.resource_ref, body.status, body.note);
        return sendJson(response, 200, { ok: true, impact });
      }
      if (request.method === "POST" && pathname === "/banks") {
        const body = await readBody(request);
        if (!body.bank_ref) throw Object.assign(new Error("missing_bank_ref"), { status: 400 });
        return sendJson(response, 201, dom.setBankReady(db, body.bank_ref, !!body.ready, body.note));
      }
      if (request.method === "GET" && pathname === "/banks") {
        return sendJson(response, 200, { banks: db.prepare(`SELECT * FROM banks ORDER BY bank_ref`).all() });
      }

      // ---- 水位窗口 / 航道水深 / 环保禁令 ----
      if (request.method === "POST" && pathname === "/water-windows") {
        const body = await readBody(request);
        for (const field of ["window_ref", "channel_ref", "min_depth_m", "starts_at", "ends_at"]) {
          if (body[field] == null) throw Object.assign(new Error(`missing_${field}`), { status: 400 });
        }
        const result = dom.publishWaterWindow(db, body);
        return sendJson(response, 201, result);
      }
      if (request.method === "GET" && pathname === "/water-windows") {
        const rows = db.prepare(`SELECT * FROM water_windows ORDER BY created_at DESC, window_ref`).all();
        return sendJson(response, 200, { windows: rows });
      }
      if (request.method === "POST" && pathname === "/channel-observations") {
        const body = await readBody(request);
        if (!body.channel_ref || body.depth_m == null) throw Object.assign(new Error("missing_fields"), { status: 400 });
        return sendJson(response, 201, dom.addChannelObservation(db, body));
      }
      if (request.method === "POST" && pathname === "/environmental-bans") {
        const body = await readBody(request);
        for (const field of ["ban_ref", "scope", "starts_at", "ends_at"]) {
          if (body[field] == null) throw Object.assign(new Error(`missing_${field}`), { status: 400 });
        }
        const result = dom.addEnvironmentalBan(db, body);
        return sendJson(response, 201, result);
      }
      if (request.method === "GET" && pathname === "/environmental-bans") {
        return sendJson(response, 200, { bans: db.prepare(`SELECT * FROM environmental_bans ORDER BY starts_at DESC`).all() });
      }

      // ---- 闸门试算 / 许可签发 ----
      if (request.method === "POST" && pathname === "/gate/evaluate") {
        const body = await readBody(request);
        return sendJson(response, 200, dom.computeGate(db, body));
      }
      if (request.method === "POST" && pathname === "/permits") {
        const body = await readBody(request);
        for (const field of ["segment_ref", "action", "resource_ref", "window_ref"]) {
          if (body[field] == null) throw Object.assign(new Error(`missing_${field}`), { status: 400 });
        }
        const result = dom.requestPermit(db, body);
        if (!result.granted && result.status === 409) return sendJson(response, 409, result);
        if (!result.granted) return sendJson(response, 422, result);
        return sendJson(response, 201, result);
      }
      if (request.method === "GET" && pathname === "/permits") {
        const ref = url.searchParams.get("segment_ref");
        const status = url.searchParams.get("status");
        const where = [];
        const params = [];
        if (ref) { where.push("segment_ref = ?"); params.push(ref); }
        if (status) { where.push("status = ?"); params.push(status); }
        const sql = `SELECT * FROM permits ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY permit_id DESC LIMIT 200`;
        const rows = db.prepare(sql).all(...params).map((p) => ({ ...p, gate_report: JSON.parse(p.gate_report_json) }));
        return sendJson(response, 200, { permits: rows });
      }
      m = pathname.match(/^\/permits\/(\d+)$/);
      if (request.method === "GET" && m) {
        const permit = dom.getPermit(db, Number(m[1]));
        if (!permit) throw Object.assign(new Error("permit_not_found"), { status: 404 });
        return sendJson(response, 200, permit);
      }
      m = pathname.match(/^\/permits\/(\d+)\/complete$/);
      if (request.method === "POST" && m) {
        const body = await readBody(request).catch(() => ({}));
        return sendJson(response, 200, dom.completePermit(db, Number(m[1]), body));
      }

      // ---- 影响报告 / 手动重算 ----
      if (request.method === "POST" && pathname === "/impact/recompute") {
        const body = await readBody(request);
        if (!body.trigger_type || !body.trigger_ref) throw Object.assign(new Error("missing_trigger"), { status: 400 });
        return sendJson(response, 200, dom.recomputeImpact(db, body));
      }
      if (request.method === "GET" && pathname === "/impact-reports") {
        const rows = db.prepare(`SELECT * FROM impact_reports ORDER BY report_id DESC LIMIT 100`).all()
          .map((r) => ({ ...r, affected: JSON.parse(r.affected_json), detail: JSON.parse(r.detail_json) }));
        return sendJson(response, 200, { reports: rows });
      }

      // ---- 合龙 ----
      if (request.method === "POST" && pathname === "/closure/close") {
        const body = await readBody(request).catch(() => ({}));
        return sendJson(response, 200, dom.closeClosure(db, body.closure_group || "main"));
      }
      if (request.method === "GET" && pathname === "/closure") {
        const group = url.searchParams.get("closure_group") || "main";
        const closure = db.prepare(`SELECT * FROM closures WHERE closure_group = ?`).get(group) ?? null;
        const steps = dom.planOverview(db, group);
        return sendJson(response, 200, {
          closure_group: group, closed: !!closure, closure,
          installed: steps.filter((s) => s.installed).length,
          total: steps.length,
          pending: steps.filter((s) => !s.installed).map((s) => s.segment_ref),
        });
      }

      // ---- 控制室页面 ----
      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const file = path.join(__dirname, "..", "public", "index.html");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(fs.readFileSync(file));
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      return sendJson(response, status, { error: error.message || "internal_error", detail: error.detail });
    }
  });

  if (ownDb) {
    server.on("close", () => {
      try { db.close(); } catch { /* 已关闭 */ }
    });
  }
  return server;
}

function parseEventOut(row) {
  return { ...row, payload: JSON.parse(row.payload_json || "{}") };
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`协同系统已启动：http://0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
