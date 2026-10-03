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
const { LATER_COLUMNS, LATER_TABLES } = require("../agent/schema_later");

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

// The same holds for a whole table. schema_later creates one only in a file
// that already has tasks, so a fresh database gets it from schema.sql or not at
// all, and the two definitions must agree column for column, or what a person's
// table looks like depends on which version first opened their file.
const later = new DatabaseSync(":memory:");
const shape = (handle, table) =>
  handle.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(table);
for (const [table, statement] of LATER_TABLES) {
  later.exec(statement);
  const got = shape(db, table);
  if (got.length && JSON.stringify(got) === JSON.stringify(shape(later, table))) {
    console.log(`  ok   table ${table} is in schema.sql with the same columns`);
  } else {
    failed++;
    console.log(`  FAIL table ${table} is created by schema_later.js but schema.sql ${got.length ? "declares it differently" : "does not declare it"}`);
  }
}

const total = LATER_COLUMNS.length + LATER_TABLES.length;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
