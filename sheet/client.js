/**
 * Speaks JSON-RPC 2.0 to agent/mcp_server.js over its stdio transport.
 *
 * Shared by the queue runner and the delphi command line, which both drive the
 * server rather than opening the database themselves: the claim, the audit rows
 * and the Sheet rules live in one place, and both work under a Node with no
 * node:sqlite, same as any other client. Lifted out of queue_runner.js with its
 * behaviour unchanged.
 *
 * One server process per client. It handles each line as it arrives, so
 * concurrent calls are safe, and every request carries an id so the answers
 * cannot be mixed up.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function defaultServerPath() {
  return path.join(__dirname, "..", "agent", "mcp_server.js");
}

/**
 * Starts the server and returns { start, call, request, close }.
 *
 * The child gets DELPHI_ACTOR, which is what History attributes every write to,
 * and DELPHI_CLIENT, which says which program is on the other end. env is laid
 * over the top of both, last.
 */
function openServer({
  server = defaultServerPath(),
  // What runs the server. This process's own binary by default, which is a
  // Node that can certainly read the server file; the tests pass a plain node
  // to prove the route a client without Electron takes.
  command = process.execPath,
  actor,
  env = {},
  clientName = "delphi-cli",
  verbose = false,
  log = () => {},
  warn = console.error,
  // Its own process group. The command line asks for this so that Ctrl-C at
  // the terminal reaches only the command it is running, and the server stays
  // up long enough to record that the command was interrupted. The server
  // still exits when this process does, because its stdin closes.
  detached = false,
  // How long one request may take, in milliseconds, before it is given up on.
  // Off by default, because some tools wait on purpose (a queue poll, a
  // Workbench fetch over a slow link). The command line turns it on: a person
  // at a terminal is better told the server stopped answering than left
  // staring at nothing.
  timeoutMs = 0,
} = {}) {
  if (!fs.existsSync(server)) {
    throw new Error(`No MCP server at ${server}. Pass --server or set DELPHI_MCP_SERVER.`);
  }
  const childEnv = { ...process.env, DELPHI_CLIENT: clientName, ...env };
  // Under Electron, process.execPath is the app. Without this the default
  // command opens a window instead of running the server, and only clients
  // that happened to inherit the variable worked.
  if (process.versions.electron && command === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = "1";
  if (actor !== undefined && actor !== null) childEnv.DELPHI_ACTOR = actor;
  const child = spawn(command, [server], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    detached,
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let dead = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || "MCP error"));
      else waiter.resolve(message.result);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => warn("mcp:", String(chunk).trimEnd()));

  const fail = (reason) => {
    dead = dead || new Error(reason);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(dead); }
    pending.clear();
  };
  child.on("error", (error) => fail(`MCP server could not start: ${error.message}`));
  // close rather than exit: exit can fire while the last answer is still in
  // the stdout pipe, and rejecting then loses a reply that was sent. close
  // waits for stdout to drain, so every answer is read before anything fails.
  child.on("close", (code, signal) => fail(`MCP server exited (${signal || code})`));
  // A server that died between requests closes the pipe under us. Without a
  // listener that is an unhandled error event and takes the client down with it,
  // rather than failing the one request that hit it.
  child.stdin.on("error", (error) => fail(`MCP server stopped reading: ${error.message}`));

  const request = (method, params, { timeoutMs: limit = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = nextId++;
    const waiter = { resolve, reject, timer: null };
    if (limit > 0) {
      waiter.timer = setTimeout(() => {
        // A late answer to this id is then ignored, which is all a timeout can
        // promise: the server may still have done the work.
        pending.delete(id);
        reject(new Error(`The MCP server did not answer ${method}${params && params.name ? ` (${params.name})` : ""} within ${limit / 1000}s.`));
      }, limit);
    }
    pending.set(id, waiter);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  return {
    async start() {
      return request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1" } });
    },
    /** Calls a tool and unwraps the JSON the server packs into its text content. */
    async call(tool, args = {}, options = {}) {
      if (verbose) log(`mcp ${tool}`, JSON.stringify(args));
      const result = await request("tools/call", { name: tool, arguments: args }, options);
      const text = result && result.content && result.content[0] && result.content[0].text;
      if (typeof text !== "string") return null;
      try { return JSON.parse(text); } catch { return text; }
    },
    request,
    close() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

module.exports = { defaultServerPath, openServer };
