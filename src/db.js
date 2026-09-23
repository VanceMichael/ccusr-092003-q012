
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(databasePath = process.env.DATABASE_PATH) {
  const resolved =
    databasePath || path.join(process.cwd(), "data", "app.sqlite3");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");

  const migrationsDir = path.join(process.cwd(), "migrations");
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return database;
}

module.exports = { openDatabase };
