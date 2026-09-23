
const path = require("node:path");
const { openMigratedDatabase } = require("../src/db");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
const database = openMigratedDatabase(databasePath);
const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
database.close();
console.log(`数据库迁移完成：${databasePath}`);
for (const { version } of versions) {
  console.log(`  - ${version}`);
}
