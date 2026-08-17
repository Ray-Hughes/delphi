// Talking to a model.
//
// This lives in the main process because it has to. The renderer runs under
// `default-src 'self'` with no connect-src, so it cannot reach api.anthropic.com
// or anything else; every request goes over IPC and comes back as a stream of
// events. That is the same reason embeddings.js reaches Ollama from here.
//
// Two ways in, and the order matters.
//
// The Claude Code CLI is preferred when it is logged in, because then the person
// is already paying for it and nothing here ever touches a credential: the CLI
// holds its own OAuth token in the Keychain and we only ever run the binary. An
// API key is the fallback, and bills separately.
//
// Both produce the same events. `claude --output-format stream-json
// --include-partial-messages` wraps verbatim Anthropic SSE events inside
// `stream_event.event`, so one mapper reads both and there is no second code
// path to keep in step.

const { spawn } = require("child_process");
const https = require("https");

const API_HOST = "api.anthropic.com";
const API_PATH = "/v1/messages";
const API_VERSION = "2023-06-01";

const DEFAULT_MODEL = "claude-opus-5";

// ---------------------------------------------------------------------------
// Finding the CLI
//
// An app launched from Finder inherits almost nothing of the PATH a terminal
// has, and a version manager puts the binary somewhere only a login shell knows
// about. Asking a login shell is the one reliable way to find it.

let cliPathCache;

function findClaudeCli() {
  if (cliPathCache !== undefined) return cliPathCache;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("/bin/zsh", ["-ilc", "command -v claude"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // An interactive login shell runs the whole profile first, and a profile
    // that starts ssh-agent prints "Agent pid 21976" to stdout before anything
    // this command said. Taking the last line rather than the whole output is
    // what stops that greeting being treated as part of the path, and the
    // existence check is what catches any other thing a profile might print.
    const fs = require("fs");
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    const found = lines.reverse().find((l) => l.startsWith("/") && fs.existsSync(l));
    cliPathCache = found || null;
  } catch {
    cliPathCache = null;
  }
  return cliPathCache;
}


// ---------------------------------------------------------------------------
// Copilot
//
// The reason this exists: Copilot at work is reached through GitHub Enterprise,
// so signing in to github.com is not enough and the token has to be one the
// enterprise issued.
//
// Credentials are never minted or stored here. The CLI takes GH_TOKEN, and the
// token comes from `gh`, which the person signed in to themselves. That keeps
// this on the supported path rather than the reverse-engineered one.

let copilotPathCache;

function findCopilotCli() {
  if (copilotPathCache !== undefined) return copilotPathCache;
  try {
    const { execFileSync } = require("child_process");
    const fs = require("fs");
    const out = execFileSync("/bin/zsh", ["-ilc", "command -v copilot"], {
      encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(out).split("\n").map((l) => l.trim()).filter(Boolean);
    copilotPathCache = lines.reverse().find((l) => l.startsWith("/") && fs.existsSync(l)) || null;
  } catch {
    copilotPathCache = null;
  }
  return copilotPathCache;
}

/** The GitHub hosts `gh` is signed in to, enterprise ones first. */
function ghHosts() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("/bin/zsh", ["-ilc", "gh auth status"], {
      encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "pipe"],
    });
    const hosts = [...String(out).matchAll(/^([a-z0-9.-]+\.[a-z]{2,})$/gim)].map((m) => m[1]);
    // An enterprise host is the one that matters at work, so it sorts first.
    return [...new Set(hosts)].sort((a, b) => (a === "github.com" ? 1 : b === "github.com" ? -1 : 0));
  } catch {
    return [];
  }
}

/**
 * A token for a host, and whether Copilot will accept it.
 *
 * The distinction matters more than it looks. A classic PAT authenticates fine
 * against the API and is refused by Copilot with "Classic PATs are not
 * supported", which arrives as an exit code and an empty stream unless you go
 * looking in the CLI's own log. Checking the prefix here turns that into
 * something the window can explain.
 */
function ghToken(host) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("/bin/zsh", ["-ilc", `gh auth token --hostname ${host}`], {
      encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "ignore"],
    });
    const token = String(out).split("\n").map((l) => l.trim())
      .filter(Boolean).reverse().find((l) => /^gh[a-z]_/.test(l));
    if (!token) return { token: null, kind: "none" };
    // Classic PATs start ghp_. Copilot takes OAuth tokens (gho_), the ones a
    // web login produces, and fine-grained PATs (github_pat_).
    const kind = token.startsWith("ghp_") ? "classic" : "supported";
    return { token, kind };
  } catch {
    return { token: null, kind: "none" };
  }
}

function streamViaCopilot({ cli, cwd, model, prompt, host, token }, emit) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--allow-all-tools"];
    if (model) args.push("--model", model);

    const child = spawn(cli, args, {
      cwd: cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(host ? { GH_HOST: host } : {}), ...(token ? { GH_TOKEN: token } : {}) },
    });

    let stderr = "";
    let saidAnything = false;
    child.stdout.setEncoding("utf8");
    // Plain text rather than a stream of events: this CLI has no JSON output
    // mode, so what it prints is the reply.
    child.stdout.on("data", (chunk) => { saidAnything = true; emit({ type: "text", text: chunk }); });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { emit({ type: "error", message: String(e.message || e) }); resolve(); });
    child.on("close", (code) => {
      if (code !== 0 && !saidAnything) {
        // It fails silently on a rejected token, so the likely cause is named
        // rather than leaving an empty reply and an exit code nobody sees.
        emit({
          type: "error",
          message: stderr.trim() ||
            "Copilot exited without saying anything. The usual cause is the token: " +
            "classic personal access tokens are refused. Run " +
            `gh auth login --hostname ${host || "your-enterprise-host"} --web ` +
            "to get one Copilot accepts, then try again.",
        });
      }
      emit({ type: "done" });
      resolve();
    });
  });
}

/**
 * What this machine can talk to.
 *
 * Reported rather than assumed, so the window can say "connected through your
 * Claude login" or ask for a key, instead of failing at the first message.
 */
async function providers({ apiKey } = {}) {
  const out = [];

  const cli = findClaudeCli();
  if (cli) {
    let loggedIn = false;
    let detail = "installed, not signed in";
    try {
      const status = await run(cli, ["auth", "status", "--json"], { timeout: 10000 });
      const parsed = JSON.parse(status.stdout || "{}");
      loggedIn = parsed.loggedIn === true;
      if (loggedIn) {
        detail = parsed.subscriptionType
          ? `signed in, ${parsed.subscriptionType}`
          : "signed in";
      }
    } catch {
      // Older builds have no `auth status`. Being unable to ask is not the same
      // as being signed out, so it is reported as unknown rather than as a no.
      detail = "installed, could not read sign-in state";
    }
    out.push({ id: "claude-cli", label: "Claude Code", ready: loggedIn, detail, path: cli });
  } else {
    out.push({ id: "claude-cli", label: "Claude Code", ready: false, detail: "not installed" });
  }

  const copilot = findCopilotCli();
  if (copilot) {
    const host = ghHosts()[0] || null;
    const { kind } = host ? ghToken(host) : { kind: "none" };
    const ready = kind === "supported";
    const detail =
      kind === "supported" ? `signed in to ${host}`
      : kind === "classic" ? `${host} uses a classic token, which Copilot refuses`
      : host ? `signed in to ${host}, no token available`
      : "gh is not signed in";
    out.push({ id: "copilot", label: "GitHub Copilot", ready, detail, host, tokenKind: kind });
  } else {
    out.push({ id: "copilot", label: "GitHub Copilot", ready: false, detail: "not installed" });
  }

  out.push({
    id: "anthropic",
    label: "Anthropic API key",
    ready: Boolean(apiKey),
    detail: apiKey ? "key saved" : "no key saved",
  });

  return out;
}

/** Runs a command to completion and collects its output. */
function run(command, args, { timeout = 30000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// The event shape everything downstream sees
//
//   { type: "text",  text }      a piece of the reply
//   { type: "usage", input, output }
//   { type: "done" }
//   { type: "error", message }

/**
 * Reads one Anthropic SSE event and emits what the window cares about.
 *
 * Keying on delta.type === "text_delta" rather than on the presence of text is
 * what keeps thinking blocks, signatures and tool-call arguments out of the
 * transcript: they arrive as deltas too, with different types.
 */
function mapAnthropicEvent(event, emit) {
  if (!event || typeof event !== "object") return;
  if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
    emit({ type: "text", text: event.delta.text || "" });
    return;
  }
  if (event.type === "message_delta" && event.usage) {
    emit({ type: "usage", input: event.usage.input_tokens || 0, output: event.usage.output_tokens || 0 });
    return;
  }
  if (event.type === "message_start" && event.message && event.message.usage) {
    emit({ type: "usage", input: event.message.usage.input_tokens || 0, output: 0 });
    return;
  }
  if (event.type === "error") {
    emit({ type: "error", message: (event.error && event.error.message) || "The model returned an error" });
  }
}

/**
 * Splits an SSE byte stream into events.
 *
 * Returned as a function holding its own buffer because a chunk boundary lands
 * wherever the network puts it, routinely mid-JSON. Anything not yet terminated
 * by a blank line is kept for the next chunk.
 */
function sseReader(onEvent) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { onEvent(JSON.parse(payload)); } catch { /* a partial line is not an error */ }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// The two paths

function streamViaApi({ apiKey, model, system, messages }, emit) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 4096,
      stream: true,
      // system is a top-level field, not a message with role "system". Sending
      // it as a message is accepted and then ignored, which looks like the model
      // disregarding its instructions.
      ...(system ? { system } : {}),
      messages,
    });

    const req = https.request(
      {
        hostname: API_HOST,
        path: API_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let error = "";
          res.on("data", (d) => (error += d));
          res.on("end", () => {
            let message = `The API returned ${res.statusCode}`;
            try {
              const parsed = JSON.parse(error);
              if (parsed.error && parsed.error.message) message = parsed.error.message;
            } catch { /* keep the status line */ }
            emit({ type: "error", message });
            resolve();
          });
          return;
        }
        const feed = sseReader((event) => mapAnthropicEvent(event, emit));
        res.setEncoding("utf8");
        res.on("data", feed);
        res.on("end", () => { emit({ type: "done" }); resolve(); });
      }
    );
    req.on("error", (e) => { emit({ type: "error", message: String(e.message || e) }); resolve(); });
    req.write(body);
    req.end();
  });
}

function streamViaCli({ cli, cwd, model, system, prompt }, emit) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (model) args.push("--model", model);
    if (system) args.push("--append-system-prompt", system);

    // Never --bare. It refuses the Keychain credential outright and insists on
    // ANTHROPIC_API_KEY, so on a signed-in machine it fails with "Please run
    // /login" and the subscription path looks broken.
    const child = spawn(cli, args, {
      cwd: cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      // One JSON object per line, so a line that has not arrived whole is kept.
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        // The CLI wraps verbatim Anthropic events, which is what lets the same
        // mapper serve both paths.
        if (parsed.type === "stream_event" && parsed.event) {
          mapAnthropicEvent(parsed.event, emit);
        } else if (parsed.type === "result" && parsed.usage) {
          emit({
            type: "usage",
            input: parsed.usage.input_tokens || 0,
            output: parsed.usage.output_tokens || 0,
          });
        } else if (parsed.type === "result" && parsed.is_error) {
          emit({ type: "error", message: parsed.result || "The agent reported an error" });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { emit({ type: "error", message: String(e.message || e) }); resolve(); });
    child.on("close", (code) => {
      if (code !== 0 && stderr.trim()) emit({ type: "error", message: stderr.trim() });
      emit({ type: "done" });
      resolve();
    });
  });
}

/**
 * Sends a turn and streams the reply.
 *
 * `messages` is the whole conversation so far, oldest first. The CLI takes a
 * single prompt rather than a transcript, so on that path the history is folded
 * into one string; it keeps its own context per invocation otherwise.
 */
async function send({ provider, apiKey, model, system, messages, cwd }, emit) {
  if (!messages || !messages.length) {
    emit({ type: "error", message: "Nothing to send" });
    emit({ type: "done" });
    return;
  }

  if (provider === "anthropic") {
    if (!apiKey) {
      emit({ type: "error", message: "No API key saved. Add one in the project's settings." });
      emit({ type: "done" });
      return;
    }
    await streamViaApi({ apiKey, model, system, messages }, emit);
    return;
  }

  if (provider === "copilot") {
    const cli = findCopilotCli();
    if (!cli) {
      emit({ type: "error", message: "The Copilot CLI is not installed." });
      emit({ type: "done" });
      return;
    }
    const host = ghHosts()[0] || null;
    const { token, kind } = host ? ghToken(host) : { token: null, kind: "none" };
    if (kind === "classic") {
      emit({
        type: "error",
        message: `Copilot refuses classic personal access tokens, and that is what gh holds for ${host}. ` +
          `Run: gh auth login --hostname ${host} --web`,
      });
      emit({ type: "done" });
      return;
    }
    const prompt = messages.map((m) => (m.role === "user" ? m.content : `Assistant: ${m.content}`)).join("\n\n");
    await streamViaCopilot({ cli, cwd, model, prompt, host, token }, emit);
    return;
  }

  const cli = findClaudeCli();
  if (!cli) {
    emit({ type: "error", message: "Claude Code is not installed, and no API key is saved." });
    emit({ type: "done" });
    return;
  }

  const prompt = messages
    .map((m) => (m.role === "user" ? m.content : `Assistant: ${m.content}`))
    .join("\n\n");
  await streamViaCli({ cli, cwd, model, system, prompt }, emit);
}

module.exports = { providers, send, DEFAULT_MODEL, findClaudeCli, findCopilotCli, ghHosts, sseReader, mapAnthropicEvent };
