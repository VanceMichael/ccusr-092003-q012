
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

const migrationsDir = path.join(process.cwd(), "migrations");
const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
}
database.close();
console.log(`数据库迁移完成：${databasePath}`);
