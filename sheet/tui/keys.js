/**
 * Raw terminal input into keys.
 *
 * A terminal in raw mode hands over bytes, not keys: an arrow is three bytes,
 * a CJK character three more, an emoji four, a paste could be a megabyte, and
 * any of them can be split across two reads. Escape is the awkward one. A lone
 * ESC byte is the Esc key, but it is also how Alt-x and every arrow begin, and
 * the only way to tell them apart is to wait briefly for what follows. That
 * wait is why there are two entry points:
 *
 *   decode(buffer)   pure. The buffer is taken as everything there is, so a
 *                    trailing ESC is the Esc key. What the tests drive.
 *   createDecoder()  stateful, for a live stream. Holds an incomplete escape
 *                    sequence, UTF-8 character or paste until the rest arrives,
 *                    and turns a lone ESC into Esc only after escMs of quiet.
 *
 * A key is { name, ch, ctrl, meta, shift }, plus text for a paste. ch is set
 * only for something that types a character, so a handler can insert ch
 * without knowing which keys are printable.
 */

const ESC = 0x1b;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const key = (name, extra = {}) => ({ name, ch: null, ctrl: false, meta: false, shift: false, ...extra });

// CSI final bytes, and the numbered ~ forms, that name a key.
const CSI_FINAL = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab", P: "f1", Q: "f2", R: "f3", S: "f4" };
const CSI_TILDE = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12" };

/** The xterm modifier parameter (1 + shift + 2 alt + 4 ctrl) as flags. */
function modifiers(param) {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: Boolean(m & 1), meta: Boolean(m & 2), ctrl: Boolean(m & 4) };
}

/** One control byte (or DEL) as a key. */
function controlKey(byte) {
  if (byte === 0x0d || byte === 0x0a) return key("enter");
  if (byte === 0x09) return key("tab");
  if (byte === 0x7f || byte === 0x08) return key("backspace");
  if (byte === 0x00) return key("space", { ctrl: true });
  if (byte >= 0x01 && byte <= 0x1a) return key(String.fromCharCode(byte + 0x60), { ctrl: true });
  // ^\ ^] ^^ ^_ : named after the character they share a key with.
  return key(String.fromCharCode(byte + 0x40), { ctrl: true });
}

/** A printable character as a key. */
function charKey(ch, meta = false) {
  if (ch === " ") return key("space", { ch: meta ? null : " ", meta });
  const upper = ch.length === 1 && ch >= "A" && ch <= "Z";
  return key(ch, { ch: meta ? null : ch, meta, shift: upper });
}

/** Bytes a UTF-8 sequence starting with this byte needs in all, or 0 if it cannot start one. */
function utf8Length(byte) {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

/**
 * Reads one key starting at i. Returns { key, next } or { need: true } when the
 * bytes stop partway through something that may still be completed.
 * final means there is nothing more coming, so a partial thing is read as what
 * it already is.
 */
function readOne(buf, i, final) {
  const b = buf[i];
  if (b === ESC) {
    if (i + 1 >= buf.length) return final ? { key: key("escape"), next: i + 1 } : { need: true };
    const c = buf[i + 1];
    // CSI: ESC [ params intermediates final.
    if (c === 0x5b) {
      let j = i + 2;
      while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
      while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f) j++;
      if (j >= buf.length) {
        // ESC [ with nothing after it, at the very end, is Alt-[ typed.
        if (final) return { key: key("[", { meta: true }), next: i + 2 };
        return { need: true };
      }
      const params = buf.toString("latin1", i + 2, j);
      const finalByte = String.fromCharCode(buf[j]);
      const next = j + 1;
      if (params === "200" && finalByte === "~") return { paste: true, next };
      const parts = params.split(";");
      if (finalByte === "~") {
        const name = CSI_TILDE[parts[0]];
        return { key: name ? key(name, modifiers(parts[1])) : key("unknown"), next };
      }
      if (finalByte === "Z") return { key: key("tab", { shift: true }), next };
      const name = CSI_FINAL[finalByte];
      return { key: name ? key(name, modifiers(parts[1])) : key("unknown"), next };
    }
    // SS3: ESC O x, the application cursor form some terminals send arrows in.
    if (c === 0x4f) {
      if (i + 2 >= buf.length) {
        if (final) return { key: key("O", { meta: true, shift: true }), next: i + 2 };
        return { need: true };
      }
      const name = CSI_FINAL[String.fromCharCode(buf[i + 2])];
      if (buf[i + 2] === 0x4d) return { key: key("enter"), next: i + 3 };
      return { key: name ? key(name) : key("unknown"), next: i + 3 };
    }
    // ESC ESC: the first is Esc on its own, the second starts again.
    if (c === ESC) return { key: key("escape"), next: i + 1 };
    // Alt with a control byte (Alt-Backspace, Alt-Enter).
    if (c < 0x20 || c === 0x7f) return { key: { ...controlKey(c), meta: true }, next: i + 2 };
    // Alt with a character, which may itself be several bytes.
    const len = utf8Length(c);
    if (len === 0) return { key: key("escape"), next: i + 1 };
    if (i + 1 + len > buf.length) return final ? { key: key("escape"), next: i + 1 } : { need: true };
    return { key: charKey(buf.toString("utf8", i + 1, i + 1 + len), true), next: i + 1 + len };
  }
  if (b < 0x20 || b === 0x7f) return { key: controlKey(b), next: i + 1 };
  const len = utf8Length(b);
  // A stray continuation byte or an invalid lead: skipped, not guessed at.
  if (len === 0) return { key: null, next: i + 1 };
  if (i + len > buf.length) return final ? { key: null, next: buf.length } : { need: true };
  for (let k = 1; k < len; k++) {
    if ((buf[i + k] & 0xc0) !== 0x80) return { key: null, next: i + k };
  }
  return { key: charKey(buf.toString("utf8", i, i + len)), next: i + len };
}

/**
 * Decodes as much of buf as it can. Returns { keys, rest }: rest is the tail
 * that might still become something once more bytes arrive, empty when final.
 */
function decodeSome(input, final) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  const keys = [];
  let i = 0;
  while (i < buf.length) {
    const r = readOne(buf, i, final);
    if (r.need) break;
    if (r.paste) {
      const end = buf.indexOf(PASTE_END, r.next, "latin1");
      if (end < 0) {
        if (!final) break;
        keys.push(key("paste", { text: buf.toString("utf8", r.next) }));
        i = buf.length;
        continue;
      }
      // Line endings as one: a paste from a Windows file is the same text.
      keys.push(key("paste", { text: buf.toString("utf8", r.next, end).replace(/\r\n?/g, "\n") }));
      i = end + PASTE_END.length;
      continue;
    }
    if (r.key) keys.push(r.key);
    i = r.next;
  }
  return { keys, rest: buf.subarray(i) };
}

/** Pure: every key in buf, which is taken to be complete. */
function decode(buffer) {
  return decodeSome(buffer, true).keys;
}

/**
 * For a live stream. push(chunk) returns the keys that are certain now, and
 * calls onKeys later with any that only time could settle (a lone Esc).
 */
function createDecoder({ escMs = 50, onKeys = () => {} } = {}) {
  let pending = Buffer.alloc(0);
  let timer = null;
  const settle = () => {
    timer = null;
    if (!pending.length) return;
    // A paste still open after the wait is not finished arriving; a lone
    // escape is Esc. Only the second is settled by the clock.
    if (pending.indexOf(PASTE_START, 0, "latin1") === 0) return;
    const { keys } = decodeSome(pending, true);
    pending = Buffer.alloc(0);
    if (keys.length) onKeys(keys);
  };
  return {
    push(chunk) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const { keys, rest } = decodeSome(pending, false);
      pending = Buffer.from(rest);
      if (pending.length) {
        timer = setTimeout(settle, escMs);
        if (timer.unref) timer.unref();
      }
      return keys;
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      const { keys } = decodeSome(pending, true);
      pending = Buffer.alloc(0);
      return keys;
    },
  };
}

/**
 * Raw mode on and keys to onKey until the returned stop() is called. stop
 * restores the mode the terminal was in, and so does process exit: the screen
 * module covers signals and crashes, this covers the plain exit.
 */
function listen(stdin, onKey, { escMs } = {}) {
  const wasRaw = Boolean(stdin.isRaw);
  const decoder = createDecoder({ escMs, onKeys: (keys) => keys.forEach(onKey) });
  const onData = (chunk) => { for (const k of decoder.push(chunk)) onKey(k); };
  let stopped = false;
  const restore = () => { try { if (stdin.isTTY) stdin.setRawMode(wasRaw); } catch {} };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onData);
  stdin.resume();
  process.on("exit", restore);
  return function stop() {
    if (stopped) return;
    stopped = true;
    stdin.removeListener("data", onData);
    stdin.pause();
    process.removeListener("exit", restore);
    restore();
  };
}

module.exports = { decode, createDecoder, listen, PASTE_START, PASTE_END };
