
const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../src/server");
const { runMigrations } = require("../src/db");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("健康接口返回服务状态", async (context) => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const server = createServer({ database: db });
  const port = await listen(server);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("未知路由返回 404", async (context) => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const server = createServer({ database: db });
  const port = await listen(server);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const response = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(response.status, 404);
});
