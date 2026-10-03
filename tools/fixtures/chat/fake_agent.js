#!/usr/bin/env node
// A stand in for an agent CLI, for tools/chat_test.js and the runner's
// Workbench test. It replays a recorded JSON stream rather than calling a
// model, so the tests cost nothing and say the same thing every time.
//
//   FAKE_AGENT_FIXTURE         the stream to replay on a first turn
//   FAKE_AGENT_RESUME_FIXTURE  the stream when --resume or --session-id is given
//   FAKE_AGENT_FAIL_RESUME=1   exit 1 silently when asked to resume, as a CLI
//                              does for a session it no longer has
//   FAKE_AGENT_LOG             a file to append { argv, cwd, env } to, per run
//
// In a fixture, {{CWD}} is replaced by the folder it runs in, and a line
// {"fake":"hang"} stops there until the process is killed.

const fs = require("fs");

const argv = process.argv.slice(2);
const resuming = argv.includes("--resume") || argv.includes("--session-id");
if (process.env.FAKE_AGENT_LOG) {
  const env = {};
  for (const k of ["DELPHI_ACTOR", "DELPHI_AUTHOR_TYPE", "DELPHI_DB"]) env[k] = process.env[k];
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, cwd: process.cwd(), env }) + "\n");
}
if (resuming && process.env.FAKE_AGENT_FAIL_RESUME === "1") {
  process.stderr.write("No conversation found with that session ID\n");
  process.exit(1);
}
const file = resuming && process.env.FAKE_AGENT_RESUME_FIXTURE ? process.env.FAKE_AGENT_RESUME_FIXTURE : process.env.FAKE_AGENT_FIXTURE;
const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());

(async () => {
  for (const line of lines) {
    if (line.includes('"fake":"hang"')) {
      process.on("SIGINT", () => process.exit(130));
      setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write(line.split("{{CWD}}").join(process.cwd().replace(/\\/g, "\\\\")) + "\n");
    await new Promise((r) => setTimeout(r, 5));
  }
})();
