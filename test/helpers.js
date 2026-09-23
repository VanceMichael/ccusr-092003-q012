
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const dom = require("../src/domain");
const { seedDatabase } = require("../scripts/seed");

const MIGRATIONS = path.join(__dirname, "..", "migrations");

function newDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  return dom.installTransactionHelper(db);
}

function seededDb() {
  const db = newDb();
  seedDatabase(db, { log: () => {} });
  return db;
}

async function withServer(t, db) {
  const { createServer } = require("../src/server");
  const server = createServer({ db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body, method = "POST") => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { base, call };
}

module.exports = { newDb, seededDb, withServer };
