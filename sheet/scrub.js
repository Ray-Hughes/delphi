// What text has to lose, or be looked at, before it leaves Delphi for
// somewhere other people read: a pull request, a status report, a second
// opinion's answer.
//
// The threat is an accident, not an adversary: a token pasted into a command
// weeks ago, an SSN in a ticket's notes. So there are three tiers, and the
// line between the first two is confidence, not importance:
//
// - strip() takes out what nobody can see: control and invisible characters,
//   bidi overrides, and HTML comments (outside code, which shows them), and
//   folds what only looks different (fullwidth letters, numeric entities,
//   dash look-alikes) so the rules below see the text as a reader does.
// - redact() replaces only what is almost certainly a secret or a person's
//   number: tokens in the shapes their issuers give them, a credential whose
//   key says so and whose value looks like one, an SSN, a VA file number next
//   to the words that make it one. Damaging a real title is a bug, so a guess
//   is never redacted.
// - flag() finds what is worth a look and is the person's call: internal
//   hosts, private addresses, home folders, and the guesses redact() would not
//   make (a password key with a word for a value, nine digits that might be an
//   SSN). They are named and highlighted, never removed or blocked on.
//
// Every pattern is bounded and anchored at a non-word boundary, because this
// runs in the main process on every pull request and in the window as a
// person types, and a 64KB line must cost milliseconds, not seconds.
//
// Known limits, on purpose: letters from other scripts that look Latin
// (Cyrillic a) are not folded, and a token split across lines or by spaces is
// not rejoined. Both take intent, and intent is not the threat here.
//
// Pure: no requires, so the MCP server, the main process and the window all
// load the one file (the window by a <script> tag, as ledger/ledger.js is).
// Nothing here is a boundary. It is a net under a person reading a preview.

(function (root) {
  const R = "[redacted]";
  // Where a token may start: not inside a run of token characters. A hyphen
  // before one is allowed, even right after a word ("Pasted-ghp_...", an em
  // dash folded): every body below but the JWT's is bounded at 255, so
  // restarting at each hyphen of a hostile line stays linear. Lookbehind is
  // in every runtime that loads this (Node 16+, Electron's Chromium).
  const L = "(?<![A-Za-z0-9_])";
  // The JWT's three parts run to 4096 each, so it may not start after any
  // hyphen that follows a token character or another hyphen: otherwise a
  // 64KB "--eyJ--eyJ..." is rescanned from every start.
  const LJ = "(?<![A-Za-z0-9_])(?<![A-Za-z0-9_-]-)";
  // A token's end: not followed by more of its own characters. An underscore
  // may follow (ghp_..._old), since the shapes it ends do not contain one.
  const RT = "(?![A-Za-z0-9])";

  // Shapes a token has when it is pasted whole, each specific enough that a
  // match is almost certainly the thing itself. Shared with second_opinion.js.
  const SECRET_SHAPES = [
    new RegExp(`${L}(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}${RT}`, "g"),
    new RegExp(`${L}github_pat_[A-Za-z0-9_]{20,255}(?![A-Za-z0-9_])`, "g"),
    new RegExp(`${L}(?:AKIA|ASIA)[0-9A-Z]{16}${RT}`, "g"),
    new RegExp(`${L}xox[abposr]-[A-Za-z0-9-]{10,255}`, "g"),
    // A private key with its END line; one with none is privateKeys()'s.
    // For second_opinion's loop, which guards an agent's answer, not text a
    // person wrote: to an END within 64KB, or else to the end of the answer,
    // since one cut short mid-key is the case it exists for. redact() is
    // narrower (privateKeys): a header mentioned in prose keeps what follows.
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,65536}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
    new RegExp(`${L}npm_[A-Za-z0-9]{36}${RT}`, "g"),
    new RegExp(`${L}glpat-[A-Za-z0-9_-]{20,255}`, "g"),
    // sk- keys are digit-rich (see DIGIT_RICH below); sk-learn-style names are not.
    new RegExp(`${L}sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,255}`, "g"),
    // Vault: hvs. and its older s. service tokens, which have digits too.
    new RegExp(`${L}hv[sbr]\\.[A-Za-z0-9_-]{20,255}`, "g"),
    new RegExp(`${L}s\\.(?=[A-Za-z]{0,23}[0-9])[A-Za-z0-9]{24}${RT}`, "g"),
    // A JWT on its own: three base64url parts, the first two JSON objects.
    // A JWT on its own: three base64url parts, the first two JSON objects.
    // For second_opinion's loop; redact() finds them with jwts(), which may
    // start after any hyphen and still stays linear.
    new RegExp(`${LJ}eyJ[A-Za-z0-9_-]{8,4096}\\.eyJ[A-Za-z0-9_-]{8,4096}\\.[A-Za-z0-9_-]{8,4096}`, "g"),
    // Google API keys, and Slack's incoming webhooks.
    new RegExp(`${L}AIza[0-9A-Za-z_-]{35}${RT}`, "g"),
    /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,12}\/B[A-Z0-9]{6,12}\/[A-Za-z0-9]{20,32}/g,
    // Stripe's secret and restricted keys (not pk_, which is published).
    new RegExp(`${L}[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}${RT}`, "g"),
  ];
  // The private-key shape is second_opinion's; redact() pairs BEGIN and END
  // itself (privateKeys), in one pass, so a mention is not the rest of the text.
  const PEM_SHAPE = SECRET_SHAPES[4];
  const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/y;
  const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/y;
  // A key body: optional "Proc-Type:"-style header lines, then lines of
  // base64, the first of them at least 16 characters long.
  // Whole lines only, so the line after a key's last is never cut into, and
  // CRLF and lines up to 1024 characters are read to their end.
  // A key on one line, or with its line breaks escaped as \n in a string:
  // the base64 follows the header directly, after a space or a literal \n.
  const PEM_BODY_INLINE = /(?:\\n|[ \t])?[A-Za-z0-9+/=]{40,4096}(?:(?:\\n|[ \t])[A-Za-z0-9+/=]{1,1024})*?(?=\\n-----|[\s"'`]|$)/y;
  // Whether what lies between a BEGIN and an END is a key's body: a run of
  // thirty-two base64 characters, as a key line is and prose almost never is.
  const PEM_BETWEEN = /[A-Za-z0-9+/=]{32}/;
  const PEM_BODY = /(?:\r?\n[A-Za-z-]{1,40}:[^\n]{0,200}){0,4}(?:\r?\n){1,2}[A-Za-z0-9+/=]{16,1024}\r?(?=\n|$)(?:\n[A-Za-z0-9+/=]{1,1024}\r?(?=\n|$)){0,4000}/y;

  /**
   * Cuts for every private key: from BEGIN to its END line when one follows
   * within 16KB, or else to the end of the base64 body when the lines after
   * BEGIN are one. A BEGIN line merely mentioned, with prose after it, is
   * left alone. Linear: the next END is found once and remembered.
   */
  function privateKeys(text) {
    const cuts = [];
    let i = 0;
    let end = -2;
    for (;;) {
      const begin = text.indexOf("-----BEGIN ", i);
      if (begin < 0) return cuts;
      PEM_BEGIN.lastIndex = begin;
      const head = PEM_BEGIN.exec(text);
      if (!head) { i = begin + 11; continue; }
      const after = begin + head[0].length;
      if (end !== -1 && end < after) end = text.indexOf("-----END ", after);
      if (end >= 0 && end - after <= 65536) {
        PEM_END.lastIndex = end;
        const tail = PEM_END.exec(text);
        // Prose that names both header lines keeps the words between them.
        if (tail && PEM_BETWEEN.test(text.slice(after, end))) { cuts.push({ from: begin, to: end + tail[0].length }); i = end + tail[0].length; continue; }
      }
      PEM_BODY.lastIndex = after;
      const body = PEM_BODY.exec(text);
      if (body) { cuts.push({ from: begin, to: after + body[0].length }); i = after + body[0].length; continue; }
      PEM_BODY_INLINE.lastIndex = after;
      const inline = PEM_BODY_INLINE.exec(text);
      if (inline) { cuts.push({ from: begin, to: after + inline[0].length }); i = after + inline[0].length; continue; }
      i = after;
    }
  }

  const JWT_SHAPE = SECRET_SHAPES[10];
  const isB64 = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;

  /**
   * Cuts for every JWT: eyJ, a base64url part, a dot, eyJ and another, a dot
   * and a third, each part 8 to 4096 long. A start may follow anything but a
   * letter, digit or underscore, so "token-eyJ..." is caught. Where a run of
   * base64url characters ends is worked out once per run and remembered, so
   * a hostile "-eyJ-eyJ..." costs one pass, not one per start.
   */
  function jwts(text) {
    const cuts = [];
    const runEnd = new Map();
    const endOf = (i) => {
      if (runEnd.has(i)) return runEnd.get(i);
      let j = i;
      while (j < text.length && isB64(text.charCodeAt(j))) j++;
      // Every start inside this run ends where it does.
      runEnd.set(i, j);
      return j;
    };
    let lastRun = -1;
    let lastRunEnd = -1;
    const end = (i) => {
      if (i < lastRunEnd && i > lastRun) return lastRunEnd;
      lastRun = i;
      lastRunEnd = endOf(i);
      return lastRunEnd;
    };
    const part = (i, needsHead) => {
      if (needsHead && text.slice(i, i + 3) !== "eyJ") return -1;
      const e = end(i);
      const n = e - i - (needsHead ? 3 : 0);
      return n >= 8 && n <= 4096 ? e : -1;
    };
    let i = 0;
    for (;;) {
      const at = text.indexOf("eyJ", i);
      if (at < 0) return cuts;
      i = at + 3;
      if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1])) continue;
      const a = part(at, true);
      if (a < 0 || text[a] !== ".") continue;
      const b = part(a + 1, true);
      if (b < 0 || text[b] !== ".") continue;
      const c = part(b + 1, false);
      if (c < 0) continue;
      cuts.push({ from: at, to: c });
      i = c;
    }
  }

  // Shapes whose prefix is also an ordinary word's, kept only when the match
  // has the digits a random key has: three or more.
  const DIGIT_RICH = new Set([SECRET_SHAPES[7]]);
  const digitRich = (t) => (t.match(/[0-9]/g) || []).length >= 3;

  // Key names that say their value is a credential. A name is split into its
  // parts at _, -, . and a lower-to-upper case change (adminPassword,
  // clientSecret, SecretKey), and judged by its last part or two. An
  // all-capitals name is also read as run together (PGPASSWORD). Never a part
  // in the middle or a longer word: tokens, token_count, max_tokens,
  // session_id, AUTH_MODE and bypass are not credentials. pass and pwd count
  // only as the last part of a longer name (DB_PASS, dbPwd): on their own
  // they are "Perf pass:" and the shell's working directory.
  // A key's kind: "password" (password, passwd, passphrase, pass and pwd at
  // the end of a longer name), "token" (secret, token, the api, access,
  // secret, private and account keys), "number" (an SSN or a VA file or claim
  // number under its own name), "weak" (pwd, pw and pass alone: in a
  // connection string they are the password, but in prose "pass" is a word,
  // so their value has to look like a secret and is never only flagged), or
  // null for a name that is not a credential's.
  const PASSWORD_WORDS = new Set(["password", "passwd", "passphrase"]);
  const TOKEN_ONE = new Set(["secret", "token", "apikey", "accesskey", "secretkey", "privatekey", "clientsecret", "accesstoken", "refreshtoken", "authtoken", "accountkey"]);
  const TOKEN_TWO = new Set(["api key", "access key", "secret key", "private key", "client secret", "access token", "refresh token", "auth token", "account key"]);
  const NUMBER_ONE = new Set(["ssn", "filenumber", "fileno", "claimnumber", "cfile", "cfilenumber"]);
  const NUMBER_TWO = new Set(["file number", "file no", "claim number", "claim no", "c file", "social security"]);
  const SUFFIX_ONLY = new Set(["pass", "pwd"]);
  const WEAK_ALONE = new Set(["pass", "pwd", "pw"]);
  const RUN_TOGETHER = /(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|APIKEY|ACCESSKEY|SECRETKEY|PRIVATEKEY|ACCOUNTKEY)$/;
  const RUN_TOGETHER_LOWER = /^[a-z0-9]{1,48}(?:password|passwd|passphrase|secret|token|apikey|accesskey|secretkey|privatekey|accountkey)$/;
  // dbpass, rootpwd, but not the words that end the same way.
  const RUN_PASS_LOWER = /^[a-z0-9]{2,48}(?:pass|pwd)$/;
  // What may follow the key word without changing what it is: SECRET_KEY_BASE,
  // secretKeyBase, API_TOKEN_PROD, password_confirmation. A number on the end
  // (password2) is read the same way.
  const QUALIFIERS = new Set(["base", "prod", "production", "dev", "development", "test", "staging", "stage", "qa", "uat", "old", "new", "prev", "previous", "current", "next", "primary", "secondary", "backup", "main", "live", "local", "value", "hash", "enc", "encrypted", "b64", "base64", "raw", "default", "confirmation", "confirm", "again", "repeat"]);
  // DBPASS and DBPWD, but not the words that end the same way.
  const RUN_PASS = /^[A-Z0-9]{2,48}(?:PASS|PWD)$/;
  const PASS_WORDS = /^(?:BYPASS|COMPASS|SURPASS|TRESPASS|OVERPASS|UNDERPASS|ENCOMPASS|PASS|PWD)$/;

  /** A name's parts: split at _, -, ., spaces and case changes, lowercased. */
  const partsOf = (name) => String(name)
    // DBPassword, JWTSecret: a capital run, then a capitalised word.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/).filter(Boolean).map((p) => p.toLowerCase());

  function keyKind(name) {
    let parts = partsOf(String(name).replace(/^[-_]+/, ""));
    // The key word with qualifiers or a number after it is still the key word.
    for (;;) {
      if (!parts.length) return null;
      const last = parts[parts.length - 1].replace(/(?<=[a-z])\d{1,3}$/, "");
      if (parts.length >= 2 && (QUALIFIERS.has(last) || /^\d{1,3}$/.test(last))) { parts = parts.slice(0, -1); continue; }
      parts[parts.length - 1] = last;
      break;
    }
    const last = parts[parts.length - 1];
    const two = parts.length >= 2 ? `${parts[parts.length - 2]} ${last}` : null;
    if (PASSWORD_WORDS.has(last) || (parts.length >= 2 && SUFFIX_ONLY.has(last))) return "password";
    if (TOKEN_ONE.has(last) || (two && TOKEN_TWO.has(two))) return "token";
    if (NUMBER_ONE.has(last) || (two && NUMBER_TWO.has(two))) return "number";
    if (parts.length === 1 && WEAK_ALONE.has(last)) return "weak";
    const raw = String(name).split(/[_.-]/).pop();
    if (/^[A-Z0-9]{2,64}$/.test(raw)) {
      if (/(?:PASSWORD|PASSWD|PASSPHRASE)$/.test(raw) || (RUN_PASS.test(raw) && !PASS_WORDS.test(raw))) return "password";
      if (RUN_TOGETHER.test(raw)) return "token";
    }
    // pgpassword, githubtoken, dbpass: a lowercase name run together.
    if (/^[a-z0-9]{1,48}(?:password|passwd|passphrase)$/.test(raw) || (RUN_PASS_LOWER.test(raw) && !PASS_WORDS.test(raw.toUpperCase()))) return "password";
    if (RUN_TOGETHER_LOWER.test(raw)) return "token";
    return null;
  }
  const isSecretKey = (name) => keyKind(name) !== null;

  // A name a value can sit under, matched loosely and judged by isSecretKey.
  // Bounded, and starting only where a run of name characters starts.
  // A leading _, digit or dash belongs to the name (_authToken, 2fa_token,
  // -Dspring.datasource.password), and isSecretKey reads past it.
  const NAME = "(?<![A-Za-z0-9_.-])[-_]{0,2}[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}";
  // A value, quoted or bare, bounded. Never one already redacted, so a
  // second pass changes nothing, and never past a backtick, which in finished
  // text closes the code span the value sits in.
  // A template reference ({{ x }}, ${x}, <your token>) is one value with
  // its spaces, so it is judged whole and kept.
  // A JSON-escaped string (\\"Hunter2x\\") is a quoted value too. A bare
  // value may hold ) ] and >, which a password can; trimClosers() takes back
  // the ones at its end that close a link, an index or a tag around it.
  const VALUE = "(?!\\[redacted\\])(\\\\\"[^\"\\\\\\n]{1,512}\\\\\"|\"[^\"\\n]{1,512}\"|'[^'\\n]{1,512}'|\\{\\{[^}\\n]{1,128}\\}\\}|\\$\\{[^}\\n]{1,128}\\}|<[^<>\\n]{1,128}>|[^\\s,;}'\"`]{1,512})";
  const PLACEHOLDER = /^(?:true|false|null|none|nil|yes|no|on|off|undefined|empty|required|optional|string|number|\*+|x+|\.+|-+|changeme|redacted|\[redacted\]|example|secret|password|token|\(none\)|n\/a)$/i;

  const unquote = (v) => String(v).replace(/^\\?(["'])([\s\S]*?)\\?\1$/, "$2");

  /**
   * A value that only says where the secret is: $VAR, ${VAR}, {{ var }},
   * <your token>, an environment lookup, or a placeholder word. Never the
   * secret itself, so never redacted.
   */
  function isReference(value) {
    const v = unquote(value).trim();
    return !v || PLACEHOLDER.test(v) || /^\$[A-Za-z_{(]/.test(v) || /^%[A-Za-z_]+%$/.test(v) || /^\{\{[\s\S]*\}\}$/.test(v)
      // <your password> and <PASSWORD> are placeholders; <Hunter2x>, with
      // its digits, is a password someone put in brackets.
      || /^<[A-Za-z_ .-]{1,128}>$/.test(v) || /^(?:process\.env\.|os\.environ|ENV\[|System\.getenv|getenv\()/.test(v);
  }

  /**
   * Whether a value under a credential key is one: "yes", "maybe" (flag it)
   * or "no". Under a key that says credential, anything is redacted except a
   * reference to somewhere else (no) and a plain lowercase word or phrase
   * with no digits (maybe: "hunter" might be a weak password, "not-set" and
   * "stored-in-vault-now" are notes, and the person can tell which).
   */
  function judge(value, kind = "password") {
    const v = unquote(value).trim();
    if (isReference(v)) return "no";
    if (kind === "number") return /^(?:C[- ]?\d{7,8}|\d{3}[ .-]?\d{2}[ .-]?\d{4}|\d{8,9})$/i.test(v) ? "yes" : "maybe";
    // pw=, pwd=, pass= alone: a secret-shaped value is one, anything else
    // is the word it looks like, and is not even flagged ("Perf pass: x").
    if (kind === "weak") return looksSecret(v, "password") ? "yes" : "no";
    return looksSecret(v, kind) ? "yes" : "maybe";
  }

  /**
   * Whether a value reads as a secret rather than as words: six or more
   * characters with a digit and a letter (Hunter2x, Admin.Pa55word), or
   * with a symbol a password has (Xk9#mQ2v!), or six or more digits (a
   * PIN), or a long run of mixed case with no spaces (a base64 key). A word
   * after a label ("Token: Refresh flow", "Token: JWT", "token: 4096") is
   * not, and is flagged instead.
   */
  function looksSecret(v, kind = "password") {
    if (/\s/.test(v) && !/^["']/.test(v)) return false;
    if (kind !== "password") {
      // Under a token or secret key a word with a version on it (OAuth2,
      // Python3) or a plain count (128000) is prose, not a key: those are
      // flagged. A password is shorter and anything goes.
      // Only the names of things (OAuth2, HTTP2, SHA256, IPv6), not any
      // capitalised word with a number: Welcome1 and Summer24 are passwords.
      if (/^(?:oauth|https?|python|web|ipv|sha|hs|rs|es|ps|ec|s|tls|ssl|v|version|md|aes|rsa|utf|base|ed|x)\d{1,4}$/i.test(v) || /^\d{1,15}$/.test(v)) return false;
    }
    if (v.length >= 6 && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) return true;
    if (v.length >= 6 && /[!@#$%^&*+=?|\\~]/.test(v) && /[A-Za-z0-9]/.test(v)) return true;
    if (/^\d{6,}$/.test(v)) return true;
    return v.length >= 16 && /[a-z]/.test(v) && /[A-Z]/.test(v) && !/[^A-Za-z0-9+/=_.-]/.test(v);
  }
  /**
   * For a header value with no scheme, where a phrase is as likely as a key
   * (Authorization: Add role checks): a reference is no, something
   * token-shaped (twelve or more characters, letters and digits) is yes, and
   * anything else is only flagged.
   */
  function tokenish(value) {
    const v = unquote(value).trim();
    if (isReference(v)) return "no";
    return v.length >= 12 && /[0-9]/.test(v) && /[A-Za-z]/.test(v) ? "yes" : "maybe";
  }
  /** Yes unless the value is a reference, which is flagged instead. */
  const unlessReference = (group) => (m) => (isReference(m[group]) ? "maybe" : "yes");

  // A shape whose value is read after its match, with VALUE_AT, and only when
  // its third element says the name is a credential's; its fourth judges the
  // value. Keeps the cost of the many names that are not to the name alone.
  const AFTER = 0;
  const VALUE_AT = new RegExp(VALUE, "y");
  function valueAfter(text, at) {
    VALUE_AT.lastIndex = at;
    const v = VALUE_AT.exec(text);
    return v ? trimClosers(v[1]) : null;
  }

  /**
   * A bare value without the ) ] or > at its end that it never opened:
   * [x](https://h?token=Ab12Cd34) keeps its closing bracket, while a password
   * with a ) inside it (Ab)12xyz9Q) is redacted whole.
   */
  function trimClosers(v) {
    if (/^["'\\{$<]/.test(v)) return v;
    const pairs = { ")": "(", "]": "[", ">": "<" };
    let out = v;
    while (out.length > 1 && pairs[out[out.length - 1]]) {
      const close = out[out.length - 1];
      const opens = out.split(pairs[close]).length - 1;
      const closes = out.split(close).length - 1;
      if (closes <= opens) break;
      out = out.slice(0, -1);
    }
    return out;
  }

  // Credentials that need a key or a flag to know them, as
  // [pattern, which group is the secret, how to judge it]. The judge returns
  // yes (redact), maybe (flag) or no.
  const CONTEXT_SHAPES = [
    // A key and a value: KEY=value, KEY: value, "key": "value", 'key' => 'value',
    // and JSON escaped inside a string ({\\"password\\":\\"x\\"}). => before =,
    // or = alone would match and leave the value behind it.
    // The value is read after the match, and only when the name is a
    // credential's (see AFTER): a match uses up the name and its separator
    // alone, so "https:" or "x=" does not swallow the access_token= or
    // password= later in the same URL or query, and a run of "x=x=x=" costs
    // nothing per name. The separator stays on the line (any run of spaces,
    // for aligned YAML), so a label is not joined to the next line's prose,
    // and a fullwidth colon counts as a colon here without the text being
    // changed. A YAML block (password: | then indented lines) is read whole.
    [new RegExp(`(\\\\?["']?)(${NAME})\\\\?["']?([ \\t]{0,16}(?:=>|[:=\\uff1a])[ \\t]{0,64})`, "g"), AFTER, (m) => keyKind(m[2]), judge],
    // A flag named for a credential and its value: --password value,
    // --client-secret abc, --admin-token=x. Read after the match too, so
    // "--verbose --password x" does not let --verbose take --password as its
    // value. A value that is itself a flag is the next option, not the secret.
    [new RegExp(`(?<![A-Za-z0-9_-])(--?[A-Za-z][A-Za-z0-9_.-]{0,63})(=|[ \\t]{1,4})`, "g"), AFTER, (m) => keyKind(m[1]),
      (v, kind) => (/^-/.test(v) ? "no" : judge(v, kind))],
    // Authorization, as a header line or a JSON key. With a scheme, the value
    // is a credential unless it is a reference ($TOKEN); without one it is
    // judged like any other value under a credential key.
    [/(?<![A-Za-z0-9_-])((?:proxy-)?authorization["']?\s{0,4}[:\uff1a]\s{0,4}["']?(?:(?:bearer|token|basic|negotiate|ntlm)\s{1,4})?)(?!\[redacted\]|(?:bearer|token|basic|negotiate|ntlm)\b)([^\s'"`]{4,4096})/gi, 2,
      (m) => (/(?:bearer|token|basic|negotiate|ntlm)\s$/i.test(m[1]) ? unlessReference(2)(m) : tokenish(m[2]))],
    // A bearer token anywhere else, when it is long and has digits; $TOKEN is
    // a reference and is flagged.
    [/(?<![A-Za-z0-9_-])(bearer\s{1,4})(?!\[redacted\])([A-Za-z0-9._~+/$-]{6,4096}=*)/gi, 2,
      (m) => (isReference(m[2]) ? "maybe" : m[2].length >= 20 && /[0-9]/.test(m[2]) && /[A-Za-z]/.test(m[2]) ? "yes" : "no")],
    // A Cookie header, as a header: its pairs, up to a quote or the line's end.
    [/((?:^|[\s'"])(?:set-)?cookie[:\uff1a]\s{0,4})(?!\[redacted\])([^\s'"`=;]{1,256}=[^\s'"`;]{0,4096}(?:;\s?[^\s'"`=;]{1,256}=[^\s'"`;]{0,4096}){0,32})/gi, 2, unlessReference(2)],
    // An x-...-key or x-...-token header.
    [/(?<![A-Za-z0-9_-])(x-[A-Za-z0-9-]{0,40}(?:api-key|token|auth|secret)[A-Za-z0-9-]{0,20}[:\uff1a]\s{0,4})(?!\[redacted\])([^\s'"`]{1,4096})/gi, 2, (m) => tokenish(m[2])],
    // curl -u user:password.
    [/((?:^|\s)(?:-u|--user)(?:=|\s{1,4})['"]?[^\s:'"`]{1,128}:)(?!\[redacted\])([^\s'"`]{1,256})/g, 2, unlessReference(2)],
    // mysql -pSECRET or -p'SECRET', the password glued to the flag; -port is not one.
    // The mysql and mariadb clients and tools, -p anywhere among the arguments.
    [/(?<![A-Za-z0-9_-])((?:mysql(?:dump|admin|check|import|show|pump)?|mariadb(?:-?(?:dump|admin|check|import|show))?)(?:[ \t][^\n`]{0,256}?)?[ \t]-p)(?!ort\b|\s|\[redacted\])('[^'\n]{1,128}'|"[^"\n]{1,128}"|[^\s'"`]{1,128})/g, 2, unlessReference(2)],
    // A URL with a password: scheme://user:password@.
    [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@`]{1,128}:)(?!\[redacted\])([^\s@/`]{1,256})(?=@)/gi, 2, unlessReference(2)],
    // A URL whose user is a long token: scheme://TOKEN@.
    [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/)(?!\[redacted\])([A-Za-z0-9_\-.~]{20,256})(?=@)/gi, 2, (m) => (/[0-9]/.test(m[2]) && /[A-Za-z]/.test(m[2]) ? "yes" : "maybe")],
    // A presigned S3 URL's signature.
    [/(X-Amz-Signature=)([0-9a-f]{64})/gi, 2, () => "yes"],
  ];

  // People's numbers. An SSN with dashes is its own evidence once the
  // numbers are ones the SSA issues; spaced, dotted or bare, or a VA file
  // number, it needs the words beside it.
  // Not after a digit or a digit and hyphen; after a word and a hyphen
  // (SSN-123-45-6789) it is still one.
  const SSN_DASHED = /(?<!\d)(?<!\d-)(\d{3})-(\d{2})-(\d{4})(?![\d])/g;
  const validSsn = (a, g, s) => a !== "000" && a !== "666" && a[0] !== "9" && g !== "00" && s !== "0000";
  const PII_NEAR = /(?<![A-Za-z0-9_])((?:c-?file|file|claim(?:\s{1,3}id)?|ssns?|social security)(?:\s{0,3}(?:no\.?|number|num|#|is|was)){0,2}\s{0,3}[:#(\uff1a]?\s{0,3})(C[- ]?\d{7,8}|\d{3}[ \u3000.-]\d{2}[ \u3000.-]\d{4}|\d{8,9})(?![A-Za-z0-9_])/gi;
  // An eight-digit date (20261106) next to "file" is a date, not a number.
  const isDate = (d) => /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(d);

  /** Where the secret group of a match is, by position, not by searching for its text again. */
  function cut(m, group) {
    const before = m.slice(1, group).join("");
    const inside = m[0].indexOf(m[group], before.length);
    // A group read in a lookahead starts where the match ends.
    const at = m.index + (inside >= 0 && inside + m[group].length <= m[0].length ? inside : m[0].length);
    return { from: at, to: at + m[group].length };
  }

  /** Every context match in text, with its verdict and where its secret is. */
  function* contextMatches(text) {
    for (const shape of CONTEXT_SHAPES) {
      for (const m of text.matchAll(shape[0])) {
        const found = verdictOf(shape, m, text);
        if (found) yield found;
      }
    }
  }

  /** A match's verdict, where its secret is, and the secret: null when there is nothing to judge. */
  function verdictOf([, group, test, judgeValue], m, text) {
    if (group !== AFTER) return { verdict: test(m), ...cut(m, group), value: m[group] };
    const kind = test(m);
    if (!kind) return null;
    const from = m.index + m[0].length;
    const block = yamlBlock(text, from, m.index);
    if (block) return { verdict: isReference(block.value.trim()) ? "no" : kind === "weak" && !looksSecret(block.value.trim(), "password") ? "no" : "yes", ...block };
    const value = valueAfter(text, from);
    if (value === null) return null;
    return { verdict: judgeValue(value, kind), from, to: from + value.length, value };
  }

  // A YAML block indicator after a key: | or >, with a chomping sign or an
  // indent number, and nothing else on the line.
  const BLOCK_HEAD = /[|>][-+]?[0-9]?[ \t]*(?=\r?\n)/y;
  /**
   * The lines of a YAML block value (password: | or >- and the lines indented
   * under the key), as a cut from the start of the first line to the end of
   * the last, or null when the value is not a block. Bounded at 400 lines.
   */
  function yamlBlock(text, from, keyAt) {
    BLOCK_HEAD.lastIndex = from;
    const head = BLOCK_HEAD.exec(text);
    if (!head) return null;
    const lineStart = text.lastIndexOf("\n", keyAt - 1) + 1;
    const keyIndent = /^[ \t]*/.exec(text.slice(lineStart, keyAt))[0].length;
    let at = text.indexOf("\n", from + head[0].length) + 1;
    const start = at;
    let end = start;
    for (let n = 0; n < 400 && at > 0 && at <= text.length; n++) {
      const next = text.indexOf("\n", at);
      const line = text.slice(at, next < 0 ? text.length : next);
      const indent = /^[ \t]*/.exec(line)[0].length;
      if (line.trim() && indent <= keyIndent) break;
      if (line.trim()) end = at + line.length;
      if (next < 0) break;
      at = next + 1;
    }
    if (end <= start) return null;
    return { from: start, to: end, value: text.slice(start, end) };
  }

  /** The cuts made into one new string in one pass: never a rebuild per match. */
  function applyCuts(text, cuts) {
    if (!cuts.length) return text;
    cuts.sort((a, b) => a.from - b.from);
    const out = [];
    let at = 0;
    for (const c of cuts) {
      if (c.from < at) continue;
      out.push(text.slice(at, c.from), R);
      at = c.to;
    }
    out.push(text.slice(at));
    return out.join("");
  }

  /**
   * The text with every high-confidence secret and number replaced: { text,
   * count, maybe }, where maybe lists what looked like one but was not sure
   * enough to blank, for flag() to show. strict redacts the maybes too, for a
   * caller with no person to read the flags (today/tidy.js).
   */
  function redact(text, { strict = false } = {}) {
    let out = String(text == null ? "" : text);
    let count = 0;
    const maybe = [];
    const hit = () => { count++; return R; };
    const keys = privateKeys(out);
    count += keys.length;
    out = applyCuts(out, keys);
    const tokens = jwts(out);
    count += tokens.length;
    out = applyCuts(out, tokens);
    for (const shape of SECRET_SHAPES) {
      if (shape === PEM_SHAPE || shape === JWT_SHAPE) continue;
      out = out.replace(shape, (all) => (DIGIT_RICH.has(shape) && !digitRich(all) ? all : hit()));
    }
    // One shape at a time, each over the text the last left, so a value two
    // shapes both claim is cut once.
    for (const shape of CONTEXT_SHAPES) {
      const cuts = [];
      for (const m of out.matchAll(shape[0])) {
        const found = verdictOf(shape, m, out);
        if (!found) continue;
        if (found.verdict === "yes" || (strict && found.verdict === "maybe")) cuts.push(found);
        else if (found.verdict === "maybe") maybe.push(found.value);
      }
      count += cuts.length;
      out = applyCuts(out, cuts);
    }
    out = out.replace(SSN_DASHED, (all, a, g, s) => (validSsn(a, g, s) ? hit() : all));
    out = out.replace(PII_NEAR, (all, lead, num) => (isDate(num) ? all : (count++, `${lead}${R}`)));
    return { text: out, count, maybe };
  }

  // What strip() removes. Control characters other than tab and newline; the
  // soft hyphen, the combining grapheme joiner, the Mongolian vowel separator
  // and variation selectors, which draw nothing; bidi embeddings, overrides
  // and isolates, which can make text read as other text; zero-width
  // characters and the BOM; and Unicode tag characters, which are invisible
  // and can carry a whole hidden sentence.
  const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0]|\udb40[\udc00-\udc7f]|\udb40[\udd00-\uddef]/g;
  // Variation selectors and the zero-width joiner are how emoji are drawn
  // (a warning sign, a family), so they stay, except between two token
  // characters, where they only split a token from its pattern.
  // Removed after any ASCII character (password\u200d=, gh\ufe0fp_), which no
  // emoji sequence starts with, except a keycap's (1\ufe0f\u20e3).
  const IN_TOKEN = /(?<=[\u0000-\u007f])[\ufe00-\ufe0f\u200d](?!\u20e3)/g;
  const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;

  /** &#65; and &#x41; as the characters they draw, except the ones that would make markup. */
  const decodeEntities = (s) => s.replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/gi, (all, n) => {
    const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    if (!Number.isFinite(code) || code > 0x10ffff || [0x3c, 0x3e, 0x26].includes(code)) return all;
    try { return String.fromCodePoint(code); } catch { return all; }
  });

  /**
   * Calls fn on the parts of Markdown that are not code: fenced blocks and
   * inline code spans are shown as written, so an HTML comment in one is text
   * the reader sees, and removing it would eat the code (and, unclosed, the
   * rest of the description).
   */
  function outsideCode(text, fn) {
    const lines = text.split("\n");
    const out = [];
    let prose = [];
    let fence = null;
    const flush = () => { if (prose.length) { out.push(outsideSpans(prose.join("\n"), fn)); prose = []; } };
    for (const line of lines) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        out.push(line);
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !/\S/.test(line.slice(open[0].length))) fence = null;
      } else if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
        flush();
        fence = open[1];
        out.push(line);
      } else {
        prose.push(line);
      }
    }
    flush();
    return out.join("\n");
  }

  /**
   * The same within prose, around inline code spans: a run of n backticks
   * closed by the next run of exactly n in the same paragraph. A span never
   * crosses a blank line, so two stray backticks in different paragraphs do
   * not shelter a comment between them.
   */
  function outsideSpans(text, fn) {
    let result = "";
    let i = 0;
    let from = 0;
    // Where the current paragraph ends, found once per paragraph, and for
    // each run length the paragraph end past which no closer of that length
    // was found, so a second opener of the same length does not search again.
    let limit = -1;
    const none = new Map();
    while (i < text.length) {
      if (text[i] !== "`") { i++; continue; }
      let n = 0;
      while (text[i + n] === "`") n++;
      // The next run of exactly n before the paragraph ends, found run by run
      // so this stays linear.
      if (limit < i + n) {
        const para = /\n[ \t]*\n/g;
        para.lastIndex = i + n;
        const ends = para.exec(text);
        limit = ends ? ends.index : text.length;
      }
      let j = i + n;
      let close = -1;
      if (none.get(n) === limit) j = limit;
      while (j < limit) {
        const k = text.indexOf("`", j);
        if (k < 0 || k >= limit) break;
        let m = 0;
        while (text[k + m] === "`") m++;
        if (m === n) { close = k; break; }
        j = k + m;
      }
      if (close < 0) { none.set(n, limit); i += n; continue; }
      result += fn(text.slice(from, i)) + text.slice(i, close + n);
      i = close + n;
      from = i;
    }
    return result + fn(text.slice(from));
  }

  // A comment closed, or an opener left alone with nothing after it to close
  // it: the opener goes, so neither the preview nor GitHub hides what follows.
  // A scan rather than a lazy regex, which would rescan the rest of the text
  // from every opener: linear, whatever the text.
  function removeComments(s) {
    let out = "";
    let i = 0;
    let close = -2;
    for (;;) {
      const open = s.indexOf("<!--", i);
      if (open < 0) return out + s.slice(i);
      out += s.slice(i, open);
      // The next closer at or after this opener, remembered between openers.
      if (close !== -1 && close < open + 4) close = s.indexOf("-->", open + 4);
      if (close < 0) { i = open + 4; continue; }
      i = close + 3;
    }
  }

  /**
   * Text with nothing in it that the reader cannot see, folded so it reads
   * the way it looks. Repeated until it stops changing, because each step can
   * make another's pattern: "<!-\u0001-x-->" and "<!\u2010\u2010x-->" are both
   * comments once the step before has run.
   */
  function strip(text) {
    let out = String(text == null ? "" : text).replace(/\r\n?|[\u2028\u2029]/g, "\n");
    // Until nothing changes; the bound only stops a pathological input, and
    // each round is linear.
    for (let before = null, rounds = 0; before !== out && rounds < 64; rounds++) {
      before = out;
      // Fullwidth ASCII is folded everywhere, since nobody writes a token in
      // it but someone hiding one from a pattern might. Not the rest of NFKC,
      // which would turn x\u00b2 into x2 and \u2122 into TM in a real title.
      // Letters, digits and the punctuation tokens use only: fullwidth
      // colons and brackets are how a CJK title is written, and stay.
      out = out.replace(/[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff3f\uff0d\uff0e\uff1d\uff0b\uff0f]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(INVISIBLE, "")
        .replace(IN_TOKEN, "")
        .replace(DASHES, "-")
        .replace(/[\u00a0\u202f]/g, " ");
      // Entities and \_ are folded only in prose: in code they are shown as
      // written, so they are what the reader sees there.
      out = outsideCode(out, (prose) => removeComments(decodeEntities(prose)
        // a\_b reads as a_b, and GitHub draws it so.
        .replace(/(?<=[A-Za-z0-9])\\_(?=[A-Za-z0-9])/g, "_")));
    }
    return out;
  }

  /** strip() then redact(), the text alone. */
  const scrub = (text) => redact(strip(text)).text;

  // What is shown to the person, not changed. Each with the words to count it.
  const HOST = "(?<![A-Za-z0-9.-])(?:(?:[a-z0-9-]{1,63}\\.){0,8}(?:va\\.gov|va\\.ghe\\.com)|[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63}){0,8}\\.(?:internal|intranet|corp|lan|local|localdomain))(?![A-Za-z0-9-])";
  const FLAGS = [
    ["host", "internal host", "internal hosts", new RegExp(HOST, "gi")],
    ["ip", "private address", "private addresses",
      /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|127\.\d{1,3})\.\d{1,3}\.\d{1,3}(?![\d.])/g],
    ["home", "home folder", "home folders",
      /(?<![A-Za-z0-9_/])\/(?:Users|home)\/[^\s/'"`)]{1,64}|(?<![^\s'"`(])~\/[^\s'"`)]{0,128}|(?<![A-Za-z0-9_])[A-Za-z]:\\Users\\[^\s\\'"`)]{1,64}/g],
    ["number", "possible SSN or file number", "possible SSNs or file numbers",
      /(?<![\d-])(?:\d{3}[ .]\d{2}[ .]\d{4}|C[- ]?\d{7,8}|\d{9})(?![\d-])/g],
  ];

  /** Every match to look at, in order: { kind, text, index }, credentials redact() was unsure of among them. */
  function flag(text) {
    const s = String(text == null ? "" : text);
    const found = [];
    for (const [kind, , , shape] of FLAGS) {
      for (const m of s.matchAll(shape)) found.push({ kind, text: m[0], index: m.index });
    }
    // The doubtful credentials, from the same matches redact() judges, each
    // at its own position: never a search for its text, which is slow and
    // finds the first occurrence rather than this one.
    for (const c of contextMatches(s)) {
      if (c.verdict === "maybe") found.push({ kind: "credential", text: c.value, index: c.from });
    }
    return found.sort((a, b) => a.index - b.index);
  }

  const WORDS = { credential: ["possible credential", "possible credentials"] };
  for (const [kind, one, many] of FLAGS) WORDS[kind] = [one, many];

  /** "3 internal hosts, 1 home folder", or "" when there is nothing. */
  function flagWords(found) {
    const out = [];
    for (const [kind, [one, many]] of Object.entries(WORDS)) {
      const n = new Set(found.filter((f) => f.kind === kind).map((f) => f.text)).size;
      if (n) out.push(`${n} ${n === 1 ? one : many}`);
    }
    return out.join(", ");
  }

  /**
   * Everything a preview needs from one pass of each: the text as it would
   * be sent, how many secrets were taken out of it, and what in it is worth
   * a look. The window repaints with this, so a 64KB description costs one
   * strip, one redact and one flag, not two of each.
   */
  function prepare(text) {
    const red = redact(strip(text));
    return { text: red.text, count: red.count, found: flag(red.text) };
  }

  /**
   * The token shapes alone, for second_opinion.js: an agent's answer quoting
   * a key file back, where a key cut short is redacted to the end. JWTs go
   * through jwts(), so one after a hyphen is caught there too.
   */
  function redactShapes(text) {
    let out = String(text == null ? "" : text);
    let count = 0;
    const tokens = jwts(out);
    count += tokens.length;
    out = applyCuts(out, tokens);
    for (const shape of SECRET_SHAPES) {
      if (shape === JWT_SHAPE) continue;
      out = out.replace(shape, (all) => (DIGIT_RICH.has(shape) && !digitRich(all) ? all : (count++, R)));
    }
    return { text: out, count };
  }

  const api = { SECRET_SHAPES, REDACTED: R, redact, strip, scrub, flag, flagWords, prepare, redactShapes };
  root.DelphiScrub = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
