#!/usr/bin/env node
// sheet/client.js against small fake servers.
//
//   ELECTRON_RUN_AS_NODE=1 <electron> tools/client_test.js
//
// The real server is driven by mcp_sheet_test.js and cli_test.js. These are the
// client's own edges, which a well behaved server never shows: a reply written
// just before the process exits, a server that never answers, and the default
// command under Electron when ELECTRON_RUN_AS_NODE was not inherited.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { openServer } = require("../sheet/client");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delphi-client-"));
process.env.DELPHI_DATA_DIR = dir;
process.env.DELPHI_DB = path.join(dir, "delphi.db");

let failures = 0;
let checks = 0;

function check(what, got, want) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

function section(name) { console.log(`\n${name}`); }

function fake(name, body) {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

// Answers the first request it reads, then exits the moment the write has been
// handed to the pipe. Not before: a process that exits with its write still
// queued loses it on some Nodes (23 on macOS among them), and that is the
// fixture's bug, not the client's. What this tests is that a reply followed at
// once by the end of the stream is still read.
const answerAndDie = fake("answer-and-die", `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const i = buffer.indexOf("\\n");
  if (i < 0) return;
  const req = JSON.parse(buffer.slice(0, i));
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { said: "x".repeat(20000) } }) + "\\n", () => process.exit(0));
});
`);

// Answers ping, and never answers anything else.
const selective = fake("selective", `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (req.method === "ping") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } }) + "\\n");
  }
});
`);

async function main() {
  section("a reply written just before the server exits");
  let received = 0;
  for (let i = 0; i < 15; i++) {
    const client = openServer({ server: answerAndDie, warn: () => {} });
    try {
      const result = await client.request("anything", {});
      if (result && result.said && result.said.length === 20000) received++;
    } catch {}
    client.close();
  }
  check("every reply is read, none rejected as an exit", received, 15);

  section("a request with a timeout");
  {
    const client = openServer({ server: selective, warn: () => {}, timeoutMs: 300 });
    const started = Date.now();
    let message = null;
    try { await client.call("slow_tool", {}); } catch (error) { message = error.message; }
    check("it is given up on, in words", /did not answer tools\/call \(slow_tool\) within 0.3s/.test(String(message)), true);
    check("after about the timeout", Date.now() - started < 3000, true);
    check("the client still works afterwards", await client.request("ping", {}), { pong: true });
    let none = "pending";
    const off = client.request("never", {}, { timeoutMs: 0 }).then(() => { none = "answered"; }, () => { none = "rejected"; });
    await new Promise((r) => setTimeout(r, 600));
    check("a timeout of 0 for one request means wait", none, "pending");
    client.close();
    await off;
    check("until the server goes", none, "rejected");
  }

  section("the default command under Electron");
  if (process.versions.electron) {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    const client = openServer({ server: selective, warn: () => {}, timeoutMs: 20000 });
    let answer = null;
    try { answer = await client.request("ping", {}); } catch (error) { answer = error.message; }
    client.close();
    if (saved !== undefined) process.env.ELECTRON_RUN_AS_NODE = saved;
    check("runs the server as Node without the variable being inherited", answer, { pong: true });
  } else {
    console.log("  (not under Electron; nothing to check)");
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
