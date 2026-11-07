// Colouring code blocks: a small tokenizer per language, and nothing else.
//
// Agents paste code into Sheets, notes and pads all day, mostly shell, Ruby
// (the owner's VA work is Rails), JavaScript, SQL and YAML. Coloured, a block
// reads at a glance; flat, it is a wall. It does not have to be right, only
// never wrong in a way that hides text: every character of the input comes
// back exactly once, in order, either plain or inside one token.
//
// No dependencies and no library, because the window runs under a strict CSP
// with no CDN and nothing is bundled. Each language is a list of sticky
// regexes tried in order at the current position, so the work is one pass
// over the text. Every pattern either consumes at least one character or is
// skipped, and none of them nests a quantifier inside a quantifier, so a
// pasted 50,000-character minified line costs a pass, never a hang.
//
// Colours are design tokens (styles/markdown.css, styles/tokens.css), one per
// token type, and tools/contrast_test.js holds each to AA on the code ground in
// both themes.

globalThis.DelphiHighlight = (() => {
  // Past this the block is drawn plain. A file someone pasted whole is read
  // by scrolling, not by colour, and thousands of spans cost a frame.
  const MAX = 60000;

  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const JS_KW = words(`async await break case catch class const continue debugger default delete do else
    enum export extends finally for from function get if implements import in instanceof interface let new
    of package private protected public readonly return set static super switch this throw try type typeof
    var void while with yield declare namespace abstract as satisfies keyof infer is`);
  const JS_LIT = words("true false null undefined NaN Infinity");
  const PY_KW = words(`and as assert async await break class continue def del elif else except finally for
    from global if import in is lambda match case nonlocal not or pass raise return try while with yield self`);
  const PY_LIT = words("True False None");
  const RB_KW = words(`alias and begin break case class def defined? do else elsif end ensure for if in module
    next not or redo rescue retry return self super then undef unless until when while yield require
    require_relative include extend attr_reader attr_writer attr_accessor private protected public
    raise lambda proc loop puts`);
  const RB_LIT = words("true false nil");
  const SH_KW = words(`if then else elif fi for while until do done case esac function in return export
    local readonly declare unset shift exit set source alias`);
  const SH_FN = words(`echo printf cd ls cat grep sed awk find xargs git npm npx node yarn make sudo rm cp mv
    mkdir chmod chown curl wget ssh docker kubectl bundle rails rake ruby python python3 pip brew jq tar
    sqlite3 test`);
  const SQL_KW = words(`select from where and or not insert into values update set delete create table
    index view drop alter add column primary key foreign references join left right inner outer full cross
    on as group by order having limit offset distinct union all case when then else end is null in exists
    between like returning with recursive pragma begin commit rollback transaction default unique check
    constraint if asc desc count sum avg min max coalesce cast integer text real blob varchar boolean
    timestamp date`);
  const SQL_LIT = words("true false null");
  const CSS_KW = words("important inherit initial unset auto none");

  /**
   * A word rule: identifiers, then keyword, literal or call by lookup. One
   * regex for every identifier rather than one alternation per keyword list,
   * so a long keyword list costs a Set lookup instead of a longer pattern.
   */
  const ident = (re, { kw, lit = new Set(), fn = null, call = true, upperType = false, fold = false }) => ({
    re, kind: (m, s, end) => {
      const w = fold ? m.toLowerCase() : m;
      if (kw.has(w)) return "kw";
      if (lit.has(w)) return "num";
      if (fn && fn.has(w)) return "fn";
      if (upperType && /^[A-Z]/.test(m)) return "type";
      if (call && s[end] === "(") return "fn";
      return null;
    },
  });

  const STR_D = /"(?:\\[\s\S]|[^"\\\n])*"?/y;
  const STR_S = /'(?:\\[\s\S]|[^'\\\n])*'?/y;
  const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)(?![\w$])/y;
  const LINE_SLASH = /\/\/[^\n]*/y;
  const BLOCK_C = /\/\*[\s\S]*?(?:\*\/|$)/y;
  const HASH_COM = /(?<![^\s;|&(){}])#[^\n]*/y;

  const LANGS = {
    js: [
      ["com", LINE_SLASH], ["com", BLOCK_C],
      ["str", /`(?:\\[\s\S]|[^`\\])*`?/y], ["str", STR_D], ["str", STR_S],
      ["num", NUM],
      ident(/[A-Za-z_$][\w$]*/y, { kw: JS_KW, lit: JS_LIT, upperType: false }),
    ],
    json: [
      ["key", /"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y], ["str", STR_D],
      ["num", /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
      ["com", LINE_SLASH], ["com", BLOCK_C],
      ident(/[A-Za-z_]\w*/y, { kw: new Set(), lit: JS_LIT, call: false }),
    ],
    sh: [
      ["com", HASH_COM],
      ["str", STR_D], ["str", /'[^']*'?/y],
      ["key", /\$\{[^}\n]*\}?|\$\(|\$[\w@#?$!*-]/y],
      ["meta", /(?<![\w-])--?[A-Za-z][\w-]*/y],
      ["num", /\d+(?![\w.])/y],
      ident(/[A-Za-z_][\w.-]*/y, { kw: SH_KW, fn: SH_FN, call: false }),
    ],
    py: [
      ["com", /#[^\n]*/y],
      ["str", /[rRbBuUfF]{0,2}"""[\s\S]*?(?:"""|$)/y], ["str", /[rRbBuUfF]{0,2}'''[\s\S]*?(?:'''|$)/y],
      ["str", /[rRbBuUfF]{1,2}(?=["'])/y], ["str", STR_D], ["str", STR_S],
      ["meta", /@[\w.]+/y],
      ["num", NUM],
      ident(/[A-Za-z_]\w*/y, { kw: PY_KW, lit: PY_LIT }),
    ],
    rb: [
      ["com", /^=begin[\s\S]*?(?:^=end[^\n]*|$(?![\s\S]))/my], ["com", HASH_COM],
      ["str", STR_D], ["str", STR_S],
      ["str", /%[qQwWiI]?(?:\([^)]*\)?|\[[^\]]*\]?|\{[^}]*\}?)/y],
      ["key", /(?<![\w:]):[A-Za-z_]\w*[?!]?|[A-Za-z_]\w*:(?=\s)/y],
      ["key", /@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*/y],
      ["num", NUM],
      ident(/[A-Za-z_]\w*[?!]?/y, { kw: RB_KW, lit: RB_LIT, upperType: true }),
    ],
    sql: [
      ["com", /--[^\n]*/y], ["com", BLOCK_C],
      ["str", /'(?:''|[^'])*'?/y], ["key", /"(?:""|[^"])*"?/y],
      ["num", /\d+(?:\.\d+)?(?![\w])/y],
      ["key", /[:@$?]\w*/y],
      ident(/[A-Za-z_]\w*/y, { kw: SQL_KW, lit: SQL_LIT, fold: true }),
    ],
    yaml: [
      ["com", HASH_COM],
      ["meta", /^(?:---|\.\.\.)(?=\s|$)/my],
      ["key", /^[ \t]*(?:- +)?[^\s#:'"\-][^\n:#]*?(?=:(?:\s|$))/my],
      ["str", STR_D], ["str", /'(?:''|[^'\n])*'?/y],
      ["meta", /[&*][\w-]+|![\w!-]+/y],
      ["num", /-?\d+(?:\.\d+)?(?![\w.-])/y],
      ident(/[A-Za-z_][\w-]*/y, { kw: new Set(), lit: words("true false null yes no on off ~ True False Null"), call: false }),
    ],
    html: [
      ["com", /<!--[\s\S]*?(?:-->|$)/y],
      ["meta", /<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$)/y],
      ["tag", /<\/?[A-Za-z][\w:.-]*|\/?>/y],
      ["key", /(?<=\s)[A-Za-z_:@][\w:.@-]*(?=\s*=)/y],
      ["str", /"[^"]*"?|'[^']*'?/y],
      ["num", /&#?\w+;/y],
    ],
    css: [
      ["com", BLOCK_C],
      ["kw", /@[\w-]+/y],
      ["str", STR_D], ["str", STR_S],
      ["num", /#[\da-fA-F]{3,8}(?![\w-])/y],
      ["key", /--?[A-Za-z][\w-]*(?=\s*:(?!:))|(?<=[{;\s])[A-Za-z][\w-]*(?=\s*:[^:{]*[;}])/y],
      ["num", /-?(?:\d*\.)?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|s|ms|deg|fr|dpi)?(?![\w])/y],
      ["kw", /!important/y],
      ident(/[A-Za-z_-][\w-]*/y, { kw: CSS_KW }),
    ],
    diff: [
      ["meta", /^(?:diff |index |\+\+\+ |--- |@@)[^\n]*/my],
      ["add", /^\+[^\n]*/my],
      ["del", /^-[^\n]*/my],
    ],
    md: [
      ["kw", /^[ \t]*#{1,6}[ \t][^\n]*/my],
      ["str", /```[^\n]*|`[^`\n]*`/y],
      ["meta", /^[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])/my],
      ["com", /^[ \t]*>[^\n]*/my],
      ["key", /\*\*[^*\n]+\*\*|__[^_\n]+__/y],
      ["tag", /\[[^[\]\n]{0,500}\]\([^()\n]{0,2048}\)/y],
    ],
  };

  const ALIAS = {
    js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
    ts: "js", typescript: "js", tsx: "js", mts: "js",
    json: "json", jsonc: "json", json5: "json",
    sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", shellsession: "sh", fish: "sh",
    py: "py", python: "py", python3: "py",
    rb: "rb", ruby: "rb", rails: "rb", rake: "rb", gemfile: "rb", erb: "html",
    sql: "sql", sqlite: "sql", postgres: "sql", postgresql: "sql", psql: "sql", mysql: "sql", plsql: "sql",
    yaml: "yaml", yml: "yaml",
    html: "html", htm: "html", xml: "html", svg: "html", xhtml: "html", plist: "html",
    css: "css", scss: "css", less: "css",
    diff: "diff", patch: "diff", udiff: "diff",
    md: "md", markdown: "md",
  };

  /** The language a fence's info string names, or null for plain. */
  function languageOf(info) {
    const word = (/^\.?([\w+#-]+)/.exec(String(info || "").trim()) || ["", ""])[1].toLowerCase();
    return Object.hasOwn(ALIAS, word) ? ALIAS[word] : null;
  }

  /**
   * The code as [type, text] pairs. type is null for plain text. Joined, the
   * texts are exactly the input: nothing is dropped, added or reordered.
   */
  function tokenize(code, lang) {
    const src = String(code == null ? "" : code);
    const key = languageOf(lang) || lang;
    // Own keys only, so a fence named "constructor" is plain, not a crash.
    const rules = Object.hasOwn(LANGS, key) ? LANGS[key] : null;
    if (!rules || src.length > MAX) return src ? [[null, src]] : [];
    const out = [];
    let plain = "";
    const push = (type, text) => {
      if (!type) { plain += text; return; }
      if (plain) { out.push([null, plain]); plain = ""; }
      const last = out[out.length - 1];
      if (last && last[0] === type) last[1] += text;
      else out.push([type, text]);
    };
    let i = 0;
    while (i < src.length) {
      let took = false;
      for (const rule of rules) {
        const re = Array.isArray(rule) ? rule[1] : rule.re;
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m || !m[0].length) continue;
        const end = i + m[0].length;
        push(Array.isArray(rule) ? rule[0] : rule.kind(m[0], src, end), m[0]);
        i = end;
        took = true;
        break;
      }
      if (took) continue;
      // Nothing matched here: the rest of the word, or the run of spaces, as
      // plain, so plain text is not walked one rule set per character. A
      // newline is always taken alone, because the line-anchored rules (a
      // diff's +, a YAML key) have to be tried at the start of every line.
      let j = i + 1;
      if (/\w/.test(src[i])) while (j < src.length && /\w/.test(src[j])) j++;
      else if (src[i] === " " || src[i] === "\t") while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      push(null, src.slice(i, j));
      i = j;
    }
    if (plain) out.push([null, plain]);
    return out;
  }

  /** The tokens as nodes for a <code>, built rather than written as HTML. */
  function render(code, lang, doc = globalThis.document) {
    const nodes = [];
    for (const [type, text] of tokenize(code, lang)) {
      if (!type) { nodes.push(doc.createTextNode(text)); continue; }
      const span = doc.createElement("span");
      span.setAttribute("class", `hl-${type}`);
      span.append(doc.createTextNode(text));
      nodes.push(span);
    }
    return nodes;
  }

  return { tokenize, render, languageOf, LANGUAGES: Object.keys(LANGS), MAX };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiHighlight;
