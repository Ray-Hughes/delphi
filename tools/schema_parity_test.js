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
const { LATER_COLUMNS, LATER_TABLES, LATER_INDEXES, LATER_TRIGGERS, apply } = require("../agent/schema_later");

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

// Indexes and triggers the same way: schema_later's text must make the same
// object schema.sql makes, compared as SQLite stores it with the spacing
// squeezed out, because a trigger that clears the wrong entity on one route
// only shows up as a dangling association months later.
const squeeze = (text) => String(text || "").replace(/\s+/g, " ").replace(/ IF NOT EXISTS/g, "").trim();
const stored = (handle, type, name) =>
  (handle.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) || {}).sql;
for (const [, table, , statement] of LATER_INDEXES) {
  // The other later tables an index needs, made here so every index can be
  // created on this second handle the way schema_later would.
  if (!stored(later, "table", table)) later.exec(stored(db, "table", table));
  later.exec(statement);
}
for (const [, table] of LATER_TRIGGERS) if (!stored(later, "table", table)) later.exec(stored(db, "table", table));
for (const [name, , , statement] of LATER_TRIGGERS) later.exec(statement);
let extra = 0;
for (const [type, list] of [["index", LATER_INDEXES], ["trigger", LATER_TRIGGERS]]) {
  for (const [name] of list) {
    extra++;
    const want = squeeze(stored(db, type, name));
    const got = squeeze(stored(later, type, name));
    if (want && want === got) {
      console.log(`  ok   ${type} ${name} is in schema.sql the same way`);
    } else {
      failed++;
      console.log(`  FAIL ${type} ${name}: schema.sql ${want ? "declares it differently" : "does not declare it"}\n       schema.sql      ${want}\n       schema_later.js ${got}`);
    }
  }
}

// An old database, made before any of the later tables, gains every one of
// them, their indexes and their triggers when schema_later runs on it, which is
// what the MCP server does on startup against a file the app has not opened.
const old = new DatabaseSync(":memory:");
old.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, key TEXT, name TEXT); CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT); CREATE TABLE notes (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, body TEXT); CREATE TABLE scratchpads (id INTEGER PRIMARY KEY, project_id INTEGER, key TEXT, title TEXT, body TEXT); CREATE TABLE links (id INTEGER PRIMARY KEY, project_id INTEGER, label TEXT, url TEXT);");
const ran = apply((statement) => old.prepare(statement).all());
for (const [type, names] of [["table", ["item_flags", "flag_entries", "item_projects", "item_copies"]],
                             ["index", LATER_INDEXES.filter(([n]) => /item|flag/.test(n)).map(([n]) => n)],
                             ["trigger", LATER_TRIGGERS.map(([n]) => n)]]) {
  for (const name of names) {
    extra++;
    if (stored(old, type, name)) console.log(`  ok   an old database gains ${type} ${name}`);
    else { failed++; console.log(`  FAIL an old database did not gain ${type} ${name} (${JSON.stringify(ran.errors)})`); }
  }
}

const total = LATER_COLUMNS.length + LATER_TABLES.length + extra;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
