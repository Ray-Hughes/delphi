// Every column agent/schema_later.js adds must also be declared in schema.sql.
//
// db.js runs schema_later first and schema.sql second, so a table that does not
// exist yet is created by schema.sql alone. A column that lives only in
// schema_later is then missing for the whole of that first launch, and nothing
// says so until something writes to it. That shipped twice: sessions had no
// workspace_id after an upgrade from 1.4, and a fresh install had no
// tasks.colour. This is the check that would have caught both.

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { LATER_COLUMNS } = require("../agent/schema_later");

const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));

let failed = 0;
for (const [table, column] of LATER_COLUMNS) {
  const found = db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`).all(table, column);
  if (found.length === 1) {
    console.log(`  ok   ${table}.${column} is in schema.sql`);
  } else {
    failed++;
    console.log(`  FAIL ${table}.${column} is added by schema_later.js but not declared in schema.sql`);
  }
}

console.log(`\n${LATER_COLUMNS.length - failed}/${LATER_COLUMNS.length} checks passed`);
process.exit(failed ? 1 : 0);
