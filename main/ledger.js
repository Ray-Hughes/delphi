// The cost and time ledger, the window's half: two read-only IPC handlers over
// ledger/ledger.js, which the MCP server's cost_ledger shares.
//
//   ledger:forTask(taskId)  one task: totals, per agent, each job, time in
//                           each status. Null for a task that does not exist.
//                           For the drawer's Runs card (ui/ledger.js taskLine
//                           draws it as one line).
//   ledger:rollup(opts)     { projectId, weeks }: this week against last, the
//                           weeks before, per agent and per project.
//
// Required by main.js, and by tools/ledger_test.js under a plain Node, so it
// takes the database's sql function as an argument.

const { makeLedger } = require("../ledger/ledger");

function register(handle, { db }) {
  const ledger = makeLedger({ sql: db.sqlP });
  handle("ledger:forTask", (taskId) => ledger.forTask(taskId));
  handle("ledger:rollup", (opts) => ledger.rollup(opts || {}));
  return ledger;
}

module.exports = { register };
