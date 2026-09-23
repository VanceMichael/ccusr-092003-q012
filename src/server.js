
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { openMigratedDatabase } = require("./db");
const service = require("./service");

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new service.DomainError(413, "body_too_large", null));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new service.DomainError(400, "bad_json", null));
      }
    });
    request.on("error", () => reject(new service.DomainError(400, "bad_json", null)));
  });
}

function actorOf(request) {
  return request.headers["x-actor"] || null;
}

const REGISTRY = {
  "/admin/segments": (db, body) => service.registerSegment(db, body),
  "/admin/segments/revision": (db, body) => service.registerRevision(db, body),
  "/admin/evidence": (db, body) => service.addEvidence(db, body),
  "/admin/windows": (db, body) => service.registerWindow(db, body),
  "/admin/restrictions": (db, body) => service.addEnvironmentalRestriction(db, body),
  "/admin/vessels": (db, body) => service.registerVessel(db, body),
  "/admin/hoists": (db, body) => service.registerHoist(db, body),
  "/admin/banks": (db, body) => service.registerBank(db, body),
  "/admin/loadings": (db, body) => service.recordLoading(db, body),
  "/admin/channel-readings": (db, body) => service.recordChannelReading(db, body),
};

const REQUEST_VERB = /^\/requests\/([^/]+)\/(issue|complete|cancel)$/;
const SEGMENT_PATH = /^\/segments\/([^/]+)$/;
const SEGMENT_TRACE = /^\/segments\/([^/]+)\/trace$/;
const REQUEST_PATH = /^\/requests\/([^/]+)$/;

function createServer(options = {}) {
  const ownsDatabase = !options.database;
  const db =
    options.database ||
    openMigratedDatabase(process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3"));

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      const method = request.method;

      if (method === "GET" && pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }

      // GET 只读接口
      if (method === "GET") {
        if (pathname === "/requests") {
          send(response, 200, {
            requests: service.listRequests(db, {
              status: url.searchParams.get("status"),
              segment_ref: url.searchParams.get("segment_ref"),
            }),
          });
          return;
        }
        if (pathname === "/closure") {
          send(response, 200, service.closureStatus(db));
          return;
        }
        if (SEGMENT_TRACE.test(pathname)) {
          send(response, 200, service.traceSegment(db, decodeURIComponent(SEGMENT_TRACE.exec(pathname)[1])));
          return;
        }
        if (SEGMENT_PATH.test(pathname)) {
          send(response, 200, service.getSegment(db, decodeURIComponent(SEGMENT_PATH.exec(pathname)[1])));
          return;
        }
        if (REQUEST_PATH.test(pathname)) {
          send(response, 200, service.getRequestView(db, decodeURIComponent(REQUEST_PATH.exec(pathname)[1])));
          return;
        }
        send(response, 404, { error: "not_found" });
        return;
      }

      if (method !== "POST") {
        send(response, 405, { error: "method_not_allowed" });
        return;
      }

      const body = await readJson(request);

      if (REGISTRY[pathname]) {
        send(response, 201, REGISTRY[pathname](db, body));
        return;
      }
      if (pathname === "/requests") {
        send(response, 201, service.createRequest(db, body));
        return;
      }
      if (REQUEST_VERB.test(pathname)) {
        const match = REQUEST_VERB.exec(pathname);
        const requestRef = decodeURIComponent(match[1]);
        const verb = match[2];
        const actor = actorOf(request);
        if (verb === "issue") send(response, 200, service.issueRequest(db, requestRef, actor));
        else if (verb === "complete") send(response, 200, service.completeRequest(db, requestRef, actor));
        else send(response, 200, service.cancelRequest(db, requestRef, actor, body.note));
        return;
      }
      if (pathname === "/changes") {
        send(response, 201, service.recordChange(db, body));
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof service.DomainError) {
        send(response, error.status, { error: error.code, detail: error.detail });
      } else {
        console.error(error);
        send(response, 500, { error: "internal_error" });
      }
    }
  });

  server.on("close", () => {
    if (ownsDatabase) db.close();
  });

  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`协同服务已启动：http://0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
