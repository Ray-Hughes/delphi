// What text has to lose, or be looked at, before it leaves Delphi for
// somewhere other people read: a pull request, a status report, a second
// opinion's answer.
//
// Three things, in this order of trust:
//
// - strip() takes out what nobody can see: control characters, bidi
//   overrides, zero-width and tag characters, and HTML comments, which the
//   preview hides and GitHub hides too. Then it makes em and en dashes plain
//   hyphens, the house rule for anything Delphi writes.
// - redact() replaces what must never leave, whoever wrote it and whether or
//   not anyone noticed: tokens and keys in the shapes they are pasted in,
//   credentials in commands and URLs, Social Security numbers and VA file
//   numbers. A false match costs a word of the text; a miss costs a secret.
// - flag() finds what is probably fine but is somebody's call: internal
//   hosts, private addresses, home folders. Those are shown to the person,
//   highlighted, and never removed or blocked on, because a pull request to
//   an internal repository often has every right to name an internal host.
//
// Pure: no requires, so the MCP server, the main process and the window all
// load the one file (the window by a <script> tag, as ledger/ledger.js is).
// Nothing here is a boundary. It is a net under a person reading a preview.

(function (root) {
  // Shapes a token has when it is pasted whole. Each is specific enough that
  // a match in prose is almost certainly the thing itself.
  const SECRET_SHAPES = [
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    // To its END line, or to the end of the text when it was cut short.
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}/g,
    /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
    // Vault: hvs. and its older s. service tokens.
    /\bhv[sbr]\.[A-Za-z0-9_-]{20,}/g,
    /\bs\.[A-Za-z0-9]{24}\b/g,
    // A JWT on its own: three base64url parts, the first two JSON objects.
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  ];

  // A NAME=value whose name says the value is secret. AWS_ names are all
  // treated as secret: the ones that are not (a region) are not worth the
  // risk of the ones that are.
  const SECRET_NAME = /token|secret|passw(?:or)?d|^pass$|_pass$|^pass_|api_?key|access_?key|private_?key|auth(?!or)|credential|^aws_/i;

  const R = "[redacted]";
  // A value, quoted or bare. Never one already redacted, so a second pass
  // over finished text changes nothing, and never past a backtick, which in
  // finished text closes the code span the value sits in.
  const VALUE = `(?!\\[redacted\\])("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s;\`]+)`;

  // Shapes that need a little context to tell them from ordinary text. Each
  // keeps its context and replaces only the secret part.
  const CONTEXT_SHAPES = [
    // Authorization and the headers named for a key, token, cookie or session.
    // A Cookie header's whole value goes, every pair of it.
    [/((?:proxy-)?authorization:\s*)(?:bearer\s+|token\s+|basic\s+)?(?!\[redacted\])[^\s'"`]+/gi, `$1${R}`],
    [/(\bcookie:\s*)(?!\[redacted\])[^'"`\n]+/gi, `$1${R}`],
    [/((?:x-[\w-]*)?(?:api-?key|token|secret|session)[\w-]*:\s*)(?!\[redacted\])[^\s'"`]+/gi, `$1${R}`],
    // --password value, --token=value and the like.
    [new RegExp(`(--?(?:password|passwd|token|secret|api-?key|access-?key)(?:=|\\s+))${VALUE}`, "gi"), `$1${R}`],
    // A credential in JSON, YAML or a .env line: "password": "x", secret: x.
    [new RegExp(`(["']?\\b(?:password|passwd|pass|secret|client_?secret|token|access_?token|refresh_?token|api_?key|access_?key|private_?key)["']?\\s*[:=]\\s*)${VALUE.replace("[^\\s;\\`]+", "[^\\s,;}\\`]+")}`, "gi"), `$1${R}`],
    // A bearer token outside an Authorization header.
    [/(\bbearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${R}`],
    // curl -u user:password.
    [/((?:^|\s)(?:-u|--user)(?:=|\s+)['"]?[^\s:'"`]+:)(?!\[redacted\])[^\s'"`]+/g, `$1${R}`],
    // mysql -pSECRET, the password glued to the flag.
    [/(\bmysql\w*\b[^\n]*?\s-p)(?!\s|\[redacted\])([^\s'"`]+)/g, `$1${R}`],
    // Credentials in a URL: user:password@, or a lone long token@.
    [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`],
    [/(\b[a-z][\w+.-]*:\/\/)[A-Za-z0-9_\-.~]{20,}@/gi, `$1${R}@`],
  ];

  // People's numbers. An SSN in its usual shape, a VA file number (C and
  // seven or eight digits), and eight or nine digits next to the words that
  // say they are one.
  const PII_SHAPES = [
    /\b\d{3}-\d{2}-\d{4}\b/g,
    /\b\d{3} \d{2} \d{4}\b/g,
    /\bC[- ]?\d{7,8}\b/g,
  ];
  const PII_NEAR = /(\b(?:c-?file|file|claim|ssn|social security)\b(?:\s*(?:no\.?|number|num|#))?\s*[:#]?\s*)(\d{8,9}|\d{3}\s\d{2}\s\d{4})\b/gi;

  /** The text with every secret and number replaced, and how many were. */
  function redact(text) {
    let count = 0;
    let out = String(text == null ? "" : text);
    const hit = () => { count++; return R; };
    for (const shape of SECRET_SHAPES) out = out.replace(shape, hit);
    out = out.replace(new RegExp(`\\b([A-Za-z_][\\w.]*)=${VALUE}`, "g"), (all, name) => {
      if (!SECRET_NAME.test(name) || all.endsWith(`=${R}`)) return all;
      count++;
      return `${name}=${R}`;
    });
    for (const [shape, to] of CONTEXT_SHAPES) {
      out = out.replace(shape, (...m) => {
        const whole = m[0];
        const next = whole.replace(new RegExp(shape.source, shape.flags.replace("g", "")), to);
        if (next !== whole) count++;
        return next;
      });
    }
    for (const shape of PII_SHAPES) out = out.replace(shape, hit);
    out = out.replace(PII_NEAR, (all, lead) => { count++; return `${lead}${R}`; });
    return { text: out, count };
  }

  // What strip() removes. Control characters other than tab and newline; bidi
  // embeddings, overrides and isolates, which can make text read as other
  // text; zero-width characters and the BOM; and Unicode tag characters,
  // which are invisible and can carry a whole hidden sentence.
  const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]|\udb40[\udc00-\udc7f]/g;

  /**
   * Text with nothing in it that the reader cannot see. Repeated until it
   * stops changing, because each removal can make the other's pattern:
   * "<!-\u0001-x-->" is a comment once the control character goes.
   */
  function strip(text) {
    let out = String(text == null ? "" : text).replace(/\r\n?|[\u2028\u2029]/g, "\n");
    for (let before = null; before !== out;) {
      before = out;
      out = out.replace(INVISIBLE, "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    }
    // Every hyphen and dash look-alike, so "123\u201145\u20116789" is the SSN it
    // reads as, and a no-break space is a space.
    return out.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-").replace(/[\u00a0\u202f]/g, " ");
  }

  /** strip() then redact(), the text alone. */
  const scrub = (text) => redact(strip(text)).text;

  // What is shown to the person, not changed. Each with the words to count it.
  const FLAGS = [
    ["host", "internal host", "internal hosts",
      /\b(?:[a-z0-9-]+\.)*(?:va\.gov|va\.ghe\.com|vaec\.va\.gov)\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|intranet|corp|lan|local|localdomain)\b/gi],
    ["ip", "private address", "private addresses",
      /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|127\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g],
    ["home", "home folder", "home folders",
      /(?:\/Users\/|\/home\/)[^\s/'"`)]+|(?:^|[\s'"`(])~\/[^\s'"`)]*|\b[A-Za-z]:\\Users\\[^\s\\'"`)]+/g],
  ];

  /** Every match to look at, in order: { kind, text, index }. */
  function flag(text) {
    const s = String(text == null ? "" : text);
    const found = [];
    for (const [kind, , , shape] of FLAGS) {
      for (const m of s.matchAll(new RegExp(shape.source, shape.flags))) {
        // The ~/ shape takes the character before it, to know it starts a word.
        const lead = kind === "home" && /^[\s'"`(]/.test(m[0]) ? 1 : 0;
        found.push({ kind, text: m[0].slice(lead), index: m.index + lead });
      }
    }
    return found.sort((a, b) => a.index - b.index);
  }

  /** "3 internal hosts, 1 home folder", or "" when there is nothing. */
  function flagWords(found) {
    const out = [];
    for (const [kind, one, many] of FLAGS) {
      const n = new Set(found.filter((f) => f.kind === kind).map((f) => f.text)).size;
      if (n) out.push(`${n} ${n === 1 ? one : many}`);
    }
    return out.join(", ");
  }

  const api = { SECRET_SHAPES, redact, strip, scrub, flag, flagWords };
  root.DelphiScrub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
