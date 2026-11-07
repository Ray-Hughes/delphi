// The one Markdown renderer: the drawer, notes, pads, Sheet entries, the chat
// and the Memory tab's notes all draw through here.
//
// It replaces the small renderer that lived in app.js, which drew the subset
// agents happened to write and nothing else (no nested lists, no task lists, no
// language on a fence). Two things shaped this one.
//
// Safety. Everything shown here was written by an agent over MCP or pasted by a
// person, so it is built as DOM nodes and never assigned as HTML. Raw HTML is
// not passed through: a tag is text, and an HTML comment is dropped, which is
// what keeps a pad's <!--d:123--> anchors out of sight without editing the
// text. A link goes out only when it is http(s) or mailto, and even then not by
// navigating this window: it carries no href, and a click goes through the
// main process (window.delphi.openExternal). No element gets an attribute this
// file did not choose, so nothing a note says can become an on* handler, a
// style or a src. Nesting is capped, so a note that is ten thousand ">" deep
// renders as text instead of overflowing the stack.
//
// Source lines. Every task-list checkbox carries the line of the source it came
// from, and a tick edits that line and only that line. Text is not a key: two
// lines reading "- [ ] check the logs" are two different checkboxes, and
// matching by text ticks the wrong one. So the parser keeps the line number on
// everything it reads, through blockquotes and nested lists, and toggleTask
// changes the one character at that line, after checking the line still says
// what it said when it was drawn.
//
// parse() and toggleTask() are pure. render() takes a document, so
// tools/markdown_test.js can run all of it under plain Node with a small fake
// one, as well as in a real window.

globalThis.DelphiMarkdown = (() => {
  const HL = typeof globalThis.DelphiHighlight !== "undefined" ? globalThis.DelphiHighlight
    : typeof require === "function" ? require("./highlight.js") : null;

  // Deeper than anyone writes on purpose, shallow enough that a hostile note
  // cannot exhaust the stack. Past it the rest is drawn as text.
  const MAX_BLOCK_DEPTH = 16;
  const MAX_INLINE_DEPTH = 8;

  const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  const HR = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  // Leading whitespace is allowed. The old renderer anchored this at column 0
  // while its paragraph loop refused any indented "# x", and the line that was
  // neither spun the window. Nothing here can do that (see the loop guard),
  // but the two still agree.
  const HEADING = /^[ \t]*(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const QUOTE = /^[ \t]*>/;
  const QUOTE_STRIP = /^[ \t]*> ?/;
  const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
  const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
  const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  // The checkbox of a task line, wherever the line nests: inside quotes and
  // after a bullet or a number. Group 1 runs up to the character a tick flips.
  const TASK_AT = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)[ xX]\]/;

  const blank = (t) => !t.trim();
  /** Columns of leading whitespace, a tab to the next multiple of four. */
  function indentOf(t) {
    let col = 0;
    for (const ch of t) {
      if (ch === " ") col += 1;
      else if (ch === "\t") col += 4 - (col % 4);
      else break;
    }
    return col;
  }
  /** The text with up to `cols` columns of leading whitespace taken off. */
  function stripCols(t, cols) {
    let col = 0;
    let i = 0;
    while (i < t.length && col < cols && (t[i] === " " || t[i] === "\t")) {
      col += t[i] === "\t" ? 4 - (col % 4) : 1;
      i += 1;
    }
    return t.slice(i);
  }

  const splitCells = (line) => {
    const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
    const cells = [];
    let cur = "";
    let tick = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "\\" && t[i + 1] === "|") { cur += "|"; i += 1; continue; }
      if (c === "`") tick = !tick;
      if (c === "|" && !tick) { cells.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  };
  const isTableStart = (L, i) => {
    if (i + 1 >= L.length || !L[i].t.includes("|") || !TABLE_SEP.test(L[i + 1].t) || !L[i + 1].t.includes("-")) return false;
    return splitCells(L[i].t).length === splitCells(L[i + 1].t).length;
  };
  const listItemStarts = (t) => {
    const m = LIST.exec(t);
    return Boolean(m) && !HR.test(t);
  };
  /** A line that ends a paragraph because a block starts on it. */
  const startsBlock = (L, i) => {
    const t = L[i].t;
    return FENCE.test(t) || HR.test(t) || HEADING.test(t) || QUOTE.test(t) || (listItemStarts(t) && !blank(LIST.exec(t)[4])) || isTableStart(L, i);
  };

  // --- blocks ---------------------------------------------------------------

  /**
   * The source as a tree of blocks. Each block that a person can act on
   * carries `n`, the 0-based line of the source it starts on.
   *
   * Lines travel as { t, n }: the text as this level sees it (quote marks and
   * list indentation taken off by the level above) and the line it was in the
   * source, which never changes on the way down.
   */
  function parse(source) {
    const lines = String(source == null ? "" : source).replace(/\r\n/g, "\n").split("\n");
    return blocks(lines.map((t, n) => ({ t, n })), 0);
  }

  function blocks(L, depth) {
    const out = [];
    if (depth >= MAX_BLOCK_DEPTH) {
      const text = L.map((l) => l.t.trim()).filter(Boolean).join("\n");
      if (text) out.push({ type: "para", text, n: L[0].n });
      return out;
    }
    let i = 0;
    while (i < L.length) {
      // Every branch must consume at least one line. The one in the old
      // renderer that did not hung the window, so the guarantee is checked at
      // the bottom rather than trusted to each branch.
      const started = i;
      const t = L[i].t;

      if (blank(t)) { i += 1; continue; }

      const fence = FENCE.exec(t);
      if (fence) {
        const [, indent, mark, info] = fence;
        const close = new RegExp(`^[ \\t]*${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
        const body = [];
        let j = i + 1;
        // An unterminated fence runs to the end rather than throwing away the
        // rest of the note.
        while (j < L.length && !close.test(L[j].t)) { body.push(stripCols(L[j].t, indentOf(indent))); j += 1; }
        out.push({ type: "code", lang: info || "", text: body.join("\n"), n: L[i].n });
        i = Math.min(L.length, j + 1);
        continue;
      }

      if (HR.test(t)) { out.push({ type: "hr", n: L[i].n }); i += 1; continue; }

      const heading = HEADING.exec(t);
      if (heading) {
        out.push({ type: "heading", level: heading[1].length, text: (heading[2] || "").trim(), n: L[i].n });
        i += 1;
        continue;
      }

      if (isTableStart(L, i)) {
        const head = splitCells(t);
        const align = splitCells(L[i + 1].t).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : null));
        const rows = [];
        let j = i + 2;
        while (j < L.length && !blank(L[j].t) && L[j].t.includes("|")) {
          const cells = splitCells(L[j].t);
          rows.push(head.map((_, k) => cells[k] || ""));
          j += 1;
        }
        out.push({ type: "table", head, align, rows, n: L[i].n });
        i = j;
        continue;
      }

      if (QUOTE.test(t)) {
        const inner = [];
        let j = i;
        while (j < L.length) {
          const u = L[j].t;
          if (QUOTE.test(u)) inner.push({ t: u.replace(QUOTE_STRIP, ""), n: L[j].n });
          // A lazy line: prose straight after a quoted line belongs to it.
          else if (!blank(u) && inner.length && !blank(inner[inner.length - 1].t) && !startsBlock(L, j)) inner.push({ t: u, n: L[j].n });
          else break;
          j += 1;
        }
        out.push({ type: "quote", children: blocks(inner, depth + 1), n: L[i].n });
        i = j;
        continue;
      }

      if (listItemStarts(t)) {
        const got = list(L, i, depth);
        out.push(got.block);
        i = got.next;
        if (i > started) continue;
      }

      // A paragraph: until a blank line or the start of another block.
      const para = [];
      let j = i;
      // Trailing spaces are kept to the end, because two of them before a
      // line break are a hard break.
      while (j < L.length && !blank(L[j].t) && (j === i || !startsBlock(L, j))) { para.push(L[j].t.replace(/^[ \t]+/, "")); j += 1; }
      if (para.length) out.push({ type: "para", text: para.join("\n").trimEnd(), n: L[i].n });
      i = Math.max(j, i);

      if (i === started) {
        out.push({ type: "para", text: t.trim(), n: L[i].n });
        i += 1;
      }
    }
    return out;
  }

  /**
   * A list from line i: its items, each with the blocks inside it.
   *
   * Lenient on indentation, because pads are written by agents and agents
   * indent by two, by four and by a tab in the same file: a line belongs to an
   * item when it is indented further than the item's marker, and a marker at
   * the same indent or less is the next item, or the end of the list when it is
   * the other kind (bullets against numbers).
   */
  function list(L, i, depth) {
    const first = LIST.exec(L[i].t);
    const ordered = /\d/.test(first[2][0]);
    const block = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [], n: L[i].n };
    while (i < L.length) {
      const m = LIST.exec(L[i].t);
      if (!m || HR.test(L[i].t) || /\d/.test(m[2][0]) !== ordered) break;
      const mi = indentOf(m[1]);
      const sp = m[3].length;
      const contentCol = mi + m[2].length + (sp === 0 || sp > 4 ? 1 : indentOf(m[1] + m[2] + m[3]) - mi - m[2].length);
      const content = [{ t: m[4], n: L[i].n }];
      let j = i + 1;
      while (j < L.length) {
        const u = L[j].t;
        if (blank(u)) {
          // Blank lines belong to the item only when what follows them does.
          let k = j;
          while (k < L.length && blank(L[k].t)) k += 1;
          if (k < L.length && indentOf(L[k].t) > mi) {
            for (; j < k; j++) content.push({ t: "", n: L[j].n });
            continue;
          }
          break;
        }
        const ind = indentOf(u);
        if (ind > mi) { content.push({ t: stripCols(u, Math.min(ind, contentCol)), n: L[j].n }); j += 1; continue; }
        // A lazy line: prose straight after the item's own prose.
        if (!listItemStarts(u) && !blank(L[j - 1].t) && !startsBlock(L, j) && !FENCE.test(content[content.length - 1].t)) {
          content.push({ t: u.trim(), n: L[j].n });
          j += 1;
          continue;
        }
        break;
      }
      const task = TASK.exec(content[0].t);
      const item = { n: L[i].n, task: null, children: [] };
      if (task) {
        item.task = { checked: task[1] !== " ", n: L[i].n };
        content[0] = { t: content[0].t.slice(task[0].length), n: content[0].n };
      }
      item.children = blocks(content, depth + 1);
      block.items.push(item);
      i = j;
      // Blank lines between items keep the list going.
      let k = i;
      while (k < L.length && blank(L[k].t)) k += 1;
      if (k < L.length && listItemStarts(L[k].t)) {
        const next = LIST.exec(L[k].t);
        if (/\d/.test(next[2][0]) === ordered && indentOf(next[1]) <= indentOf(first[1]) + 3) { i = k; continue; }
      }
      break;
    }
    return { block, next: i };
  }

  // --- inline ---------------------------------------------------------------

  const PUNCT = /[!-/:-@[-`{-~]/;
  const BARE_URL = /https?:\/\/[^\s<>]+/iy;
  const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;
  const AUTOMAIL = /<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/y;
  const REF = /#(\d{1,9})(?![\w])/y;

  /**
   * A destination this window may open, or null. http(s) and mailto only.
   * Whitespace and control characters anywhere refuse it outright rather than
   * being stripped, because "java\tscript:" is javascript: to a browser, and a
   * URL that needs cleaning to pass is one nobody meant to write.
   */
  function safeHref(raw) {
    const url = String(raw == null ? "" : raw).trim();
    if (!url || /[\s\x00-\x1f\x7f-\x9f]/.test(url)) return null;
    if (/^https?:\/\/[^/?#]/i.test(url)) return url;
    // A bare address only: no ?subject or &body, which some mail clients on
    // Windows have read as arguments.
    if (/^mailto:[^\s<>"'?&]+@[^\s<>"'?&]+$/i.test(url)) return url;
    return null;
  }

  /** A bare URL's end: trailing punctuation and an unmatched ")" are prose, not URL. */
  function trimUrl(u) {
    let url = u.replace(/[.,;:!?'"*_~]+$/, "");
    while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, "");
    return url;
  }

  /**
   * Inline text as tokens: { t: "text"|"code"|"strong"|"em"|"del"|"link"|"ref"|"br" }.
   * Emphasis follows the old renderer's rule that a delimiter may not be
   * flanked by a space, so "2 * 3 * 4" and shell globs stay as written.
   */
  function inline(s, depth = 0) {
    const out = [];
    let buf = "";
    const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
    // A delimiter that found no closer from some point finds none from any
    // later point either, so it is not searched for again. Without this a line
    // of a thousand unmatched "**a" is a thousand searches to its end.
    const noClose = new Map();
    const noTicks = new Set();
    let noBracket = false;
    const n = s.length;
    let i = 0;

    const codeEnd = (from, run) => {
      if (noTicks.has(run)) return -1;
      let k = s.indexOf("`", from);
      while (k >= 0) {
        let e = k;
        while (s[e] === "`") e += 1;
        if (e - k === run) return k;
        k = s.indexOf("`", e);
      }
      noTicks.add(run);
      return -1;
    };

    const closer = (from, delim) => {
      if ((noClose.get(delim) ?? Infinity) <= from) return -1;
      const c = delim[0];
      let k = from;
      while (k < n) {
        const ch = s[k];
        if (ch === "\\") { k += 2; continue; }
        if (ch === "`") {
          let run = 1;
          while (s[k + run] === "`") run += 1;
          const e = codeEnd(k + run, run);
          k = e >= 0 ? e + run : k + run;
          continue;
        }
        if (ch === c) {
          let run = 1;
          while (s[k + run] === c) run += 1;
          const fits = delim.length === 1 ? run === 1 || run === 3 : run >= 2;
          if (fits && k > from && !/\s/.test(s[k - 1]) && !(c === "_" && /\w/.test(s[k + run] || ""))) {
            // "***" closing "*" or "**": the delimiter takes its own share
            // and leaves the rest inside, to close the other one.
            return run === 3 ? (delim.length === 1 ? k + 2 : k + 1) : k;
          }
          k += run;
          continue;
        }
        k += 1;
      }
      noClose.set(delim, Math.min(noClose.get(delim) ?? Infinity, from));
      return -1;
    };

    // [text](dest "title"), from the "[" at i. Null when it is not a link.
    const link = (at) => {
      if (noBracket) return null;
      let k = at + 1;
      let level = 0;
      // Link text is short. Capped, so a line of ten thousand "[" is not ten
      // thousand scans to its end.
      const stop = Math.min(n, at + 1000);
      for (; k < stop; k++) {
        const ch = s[k];
        if (ch === "\\") { k += 1; continue; }
        if (ch === "[") level += 1;
        else if (ch === "]") { if (!level) break; level -= 1; }
      }
      if (k >= stop) { if (stop === n && !s.includes("]", at)) noBracket = true; return null; }
      if (s[k + 1] !== "(") return null;
      let p = k + 2;
      while (s[p] === " ") p += 1;
      let dest = "";
      if (s[p] === "<") {
        const e = s.indexOf(">", p + 1);
        if (e < 0 || s.slice(p + 1, e).includes("\n")) return null;
        dest = s.slice(p + 1, e);
        p = e + 1;
      } else {
        let parens = 0;
        const start = p;
        for (; p < n; p++) {
          const ch = s[p];
          if (ch === "\\" && PUNCT.test(s[p + 1] || "")) { p += 1; continue; }
          if (/\s/.test(ch)) break;
          if (ch === "(") parens += 1;
          else if (ch === ")") { if (!parens) break; parens -= 1; }
        }
        dest = s.slice(start, p).replace(/\\([!-/:-@[-`{-~])/g, "$1");
      }
      while (s[p] === " " || s[p] === "\n") p += 1;
      let title = null;
      const q = s[p];
      if (q === '"' || q === "'" || q === "(") {
        const e = s.indexOf(q === "(" ? ")" : q, p + 1);
        if (e < 0) return null;
        title = s.slice(p + 1, e);
        p = e + 1;
        while (s[p] === " ") p += 1;
      }
      if (s[p] !== ")") return null;
      return { text: s.slice(at + 1, k), dest, title, end: p + 1 };
    };

    const sub = (text) => (depth < MAX_INLINE_DEPTH ? inline(text, depth + 1) : [{ t: "text", v: text }]);

    while (i < n) {
      const c = s[i];

      if (c === "\\" && i + 1 < n) {
        if (s[i + 1] === "\n") { flush(); out.push({ t: "br" }); i += 2; continue; }
        if (PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      }

      if (c === "\n") {
        if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ""); flush(); out.push({ t: "br" }); }
        else buf += "\n";
        i += 1;
        continue;
      }

      if (c === "`") {
        let run = 1;
        while (s[i + run] === "`") run += 1;
        const e = codeEnd(i + run, run);
        if (e < 0) { buf += "`".repeat(run); i += run; continue; }
        let code = s.slice(i + run, e).replace(/\n/g, " ");
        if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
        flush();
        out.push({ t: "code", v: code });
        i = e + run;
        continue;
      }

      if (c === "<") {
        // An HTML comment is dropped: it is how a pad keeps its anchors, and
        // what a note author meant to be invisible.
        if (s.startsWith("<!--", i)) {
          const e = s.indexOf("-->", i + 4);
          if (e >= 0) { i = e + 3; continue; }
        }
        AUTOLINK.lastIndex = i;
        let m = AUTOLINK.exec(s);
        if (m && safeHref(m[1])) { flush(); out.push({ t: "link", href: m[1], kids: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }] }); i += m[0].length; continue; }
        AUTOMAIL.lastIndex = i;
        m = AUTOMAIL.exec(s);
        if (m) { flush(); out.push({ t: "link", href: `mailto:${m[1]}`, kids: [{ t: "text", v: m[1] }] }); i += m[0].length; continue; }
      }

      if ((c === "[" || (c === "!" && s[i + 1] === "[")) && depth < MAX_INLINE_DEPTH) {
        const image = c === "!";
        const got = link(image ? i + 1 : i);
        if (got) {
          flush();
          const href = safeHref(got.dest);
          // An image is shown as a link to it: the window's CSP loads nothing
          // remote, and a tracking pixel in a note should not phone home.
          const kids = image ? [{ t: "text", v: got.text || got.dest }] : sub(got.text);
          if (href) out.push({ t: "link", href, title: got.title, image, kids });
          else out.push(...kids);
          i = got.end;
          continue;
        }
      }

      if (c === "*" || c === "_" || c === "~") {
        let run = 1;
        while (s[i + run] === c) run += 1;
        const delim = c === "~" ? (run === 2 ? "~~" : null) : run >= 2 ? c + c : c;
        const after = delim ? s[i + delim.length] : "";
        const intraword = c === "_" && i > 0 && /\w/.test(s[i - 1]);
        if (delim && after && !/\s/.test(after) && !intraword) {
          const e = closer(i + delim.length, delim);
          if (e >= 0) {
            flush();
            const tag = c === "~" ? "del" : delim.length === 2 ? "strong" : "em";
            out.push({ t: tag, kids: sub(s.slice(i + delim.length, e)) });
            i = e + delim.length;
            continue;
          }
        }
        buf += s.slice(i, i + (delim ? delim.length : run));
        i += delim ? delim.length : run;
        continue;
      }

      if ((c === "h" || c === "H") && (i === 0 || !/[\w/]/.test(s[i - 1]))) {
        BARE_URL.lastIndex = i;
        const m = BARE_URL.exec(s);
        if (m) {
          const url = trimUrl(m[0]);
          if (safeHref(url)) { flush(); out.push({ t: "link", href: url, kids: [{ t: "text", v: url }] }); i += url.length; continue; }
        }
      }

      // #123 is a task, by the same rule the Flag dialog and the note's
      // Linked list read it: not after a word character, & or /.
      if (c === "#" && (i === 0 || !/[\w&/]/.test(s[i - 1]))) {
        REF.lastIndex = i;
        const m = REF.exec(s);
        if (m) { flush(); out.push({ t: "ref", id: Number(m[1]), v: m[0] }); i += m[0].length; continue; }
      }

      buf += c;
      i += 1;
    }
    flush();
    return out;
  }

  // --- the source, changed by a tick ---------------------------------------

  /**
   * The source with the checkbox on `line` set to `checked`, or null when that
   * line is not a task line, or no longer says `expect` (the text it had when
   * the checkbox was drawn). One character changes; the rest of the line, its
   * <!--d:N--> anchor included, is kept exactly, and so are the line endings.
   */
  function toggleTask(source, line, checked, expect = null) {
    const text = String(source == null ? "" : source);
    const lines = text.split("\n");
    if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
    const cur = lines[line];
    const bare = cur.replace(/\r$/, "");
    if (expect != null && bare !== String(expect).replace(/\r$/, "")) return null;
    const m = TASK_AT.exec(bare);
    if (!m) return null;
    const at = m[1].length;
    lines[line] = cur.slice(0, at) + (checked ? "x" : " ") + cur.slice(at + 1);
    return lines.join("\n");
  }

  /** The source's lines, as the checkboxes name them. */
  const linesOf = (source) => String(source == null ? "" : source).replace(/\r\n/g, "\n").split("\n");

  // --- nodes ----------------------------------------------------------------

  /**
   * The source as a <div class="md">.
   *
   * opts.onToggle({ line, checked, text })  a checkbox was clicked. Without it
   *   checkboxes are drawn disabled, as in a Sheet entry, which nobody edits.
   * opts.openExternal(url)                  where a link goes; nothing without it.
   * opts.onRef(id), opts.refTitle(id)        #123 as a link to the task, when
   *   refTitle knows it (a title, or true). Plain text otherwise.
   * opts.copy(text)                         the clipboard; navigator.clipboard
   *   when not given.
   * opts.document                           for tests.
   */
  function render(source, opts = {}) {
    const doc = opts.document || globalThis.document;
    const ctx = { doc, opts, lines: linesOf(source), inLink: false, live: new Set() };
    const root = h(doc, "div", "md");
    appendBlocks(root, parse(source), ctx);
    return root;
  }

  function h(doc, tag, cls = null, ...kids) {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute("class", cls);
    for (const k of kids) if (k != null) node.append(typeof k === "string" ? doc.createTextNode(k) : k);
    return node;
  }

  function appendBlocks(parent, list, ctx) {
    for (const b of list) parent.append(blockNode(b, ctx));
  }

  function blockNode(b, ctx) {
    const { doc } = ctx;
    switch (b.type) {
      case "heading": return h(doc, `h${b.level}`, null, ...inlineNodes(inline(b.text), ctx));
      case "para": return h(doc, "p", null, ...inlineNodes(inline(b.text), ctx));
      case "hr": return h(doc, "hr");
      case "code": return codeNode(b, ctx);
      case "quote": { const q = h(doc, "blockquote"); appendBlocks(q, b.children, ctx); return q; }
      case "table": return tableNode(b, ctx);
      case "list": return listNode(b, ctx);
      default: return doc.createTextNode("");
    }
  }

  function codeNode(b, ctx) {
    const { doc, opts } = ctx;
    const lang = HL ? HL.languageOf(b.lang) : null;
    const code = h(doc, "code", lang ? `hl lang-${lang}` : "hl");
    for (const node of HL ? HL.render(b.text, lang, doc) : [doc.createTextNode(b.text)]) code.append(node);
    const label = h(doc, "span", "md-code-lang", b.lang ? String(b.lang).slice(0, 24) : "text");
    const copy = h(doc, "button", "md-copy", "Copy");
    copy.setAttribute("type", "button");
    copy.setAttribute("aria-label", "Copy this code");
    // Said once, to a screen reader, rather than only shown on the button.
    const live = h(doc, "span", "md-live");
    live.setAttribute("aria-live", "polite");
    let timer = null;
    copy.addEventListener("click", (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const write = opts.copy || ((text) => globalThis.navigator.clipboard.writeText(text));
      let pending;
      try { pending = Promise.resolve(write(b.text)); } catch (error) { pending = Promise.reject(error); }
      pending.then(() => say("Copied", "Copied to the clipboard"), () => say("Could not copy", "Could not copy"));
    });
    function say(words, spoken) {
      copy.textContent = words;
      copy.setAttribute("data-done", "1");
      live.textContent = spoken;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { copy.textContent = "Copy"; copy.removeAttribute("data-done"); live.textContent = ""; }, 1600);
    }
    return h(doc, "div", "md-code", h(doc, "div", "md-code-bar", label, copy, live), h(doc, "pre", null, code));
  }

  function tableNode(b, ctx) {
    const { doc } = ctx;
    const al = (k) => (b.align[k] ? `al-${b.align[k]}` : null);
    const head = h(doc, "tr");
    b.head.forEach((cell, k) => head.append(h(doc, "th", al(k), ...inlineNodes(inline(cell), ctx))));
    const body = h(doc, "tbody");
    for (const row of b.rows) {
      const tr = h(doc, "tr");
      row.forEach((cell, k) => tr.append(h(doc, "td", al(k), ...inlineNodes(inline(cell), ctx))));
      body.append(tr);
    }
    return h(doc, "div", "table-wrap", h(doc, "table", null, h(doc, "thead", null, head), body));
  }

  function listNode(b, ctx) {
    const { doc, opts } = ctx;
    const tasks = b.items.some((it) => it.task);
    const list = h(doc, b.ordered ? "ol" : "ul", tasks ? "md-tasks" : null);
    if (b.ordered && b.start !== 1 && Number.isFinite(b.start)) list.setAttribute("start", String(b.start));
    for (const it of b.items) {
      const li = h(doc, "li", it.task ? `md-task${it.task.checked ? " done" : ""}` : null);
      let rest = it.children;
      // The item's first paragraph sits in the <li> itself, so a tight list
      // reads as a list and not as a column of paragraphs.
      const lead = rest[0] && rest[0].type === "para" ? rest[0] : null;
      if (lead) rest = rest.slice(1);
      const leadNodes = lead ? inlineNodes(inline(lead.text), ctx) : [];
      if (it.task) {
        const box = doc.createElement("input");
        box.setAttribute("type", "checkbox");
        box.setAttribute("class", "md-check");
        box.setAttribute("data-line", String(it.task.n));
        if (it.task.checked) { box.setAttribute("checked", ""); box.checked = true; }
        const words = lead ? lead.text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().slice(0, 140) : "";
        box.setAttribute("aria-label", words || "Task");
        // "- [ ] - [ ] x" is two boxes on one line, and a tick can only name
        // the line, which toggleTask reads as its first box. So only the first
        // box on a line is live.
        const first = !ctx.live.has(it.task.n);
        ctx.live.add(it.task.n);
        if (opts.onToggle && first) {
          const line = it.task.n;
          const text = ctx.lines[line];
          box.addEventListener("change", () => opts.onToggle({ line, checked: Boolean(box.checked), text, box }));
        } else {
          box.setAttribute("disabled", "");
          box.disabled = true;
        }
        li.append(box, h(doc, "span", "md-task-text", ...leadNodes));
      } else {
        for (const node of leadNodes) li.append(node);
      }
      appendBlocks(li, rest, ctx);
      list.append(li);
    }
    return list;
  }

  function inlineNodes(tokens, ctx) {
    const { doc, opts } = ctx;
    const out = [];
    for (const tk of tokens) {
      switch (tk.t) {
        case "text": out.push(doc.createTextNode(tk.v)); break;
        case "br": out.push(doc.createElement("br")); break;
        case "code": out.push(h(doc, "code", null, tk.v)); break;
        case "strong": case "em": case "del": out.push(h(doc, tk.t, null, ...inlineNodes(tk.kids, ctx))); break;
        case "link": {
          // A link inside a link's text is drawn as its text.
          if (ctx.inLink) { out.push(...inlineNodes(tk.kids, ctx)); break; }
          ctx.inLink = true;
          const kids = inlineNodes(tk.kids, ctx);
          ctx.inLink = false;
          out.push(linkNode(doc, tk.href, tk.title, kids, () => { if (opts.openExternal) opts.openExternal(tk.href); }, "md-link"));
          break;
        }
        case "ref": {
          const known = opts.onRef && !ctx.inLink ? (opts.refTitle ? opts.refTitle(tk.id) : true) : null;
          if (!known) { out.push(doc.createTextNode(tk.v)); break; }
          out.push(linkNode(doc, null, typeof known === "string" ? `#${tk.id} ${known}` : `Open task #${tk.id}`, [doc.createTextNode(tk.v)], () => opts.onRef(tk.id), "md-ref"));
          break;
        }
        default: break;
      }
    }
    return out;
  }

  /**
   * An <a> with no href: focusable, announced as a link, and opened by its own
   * handler. With an href a stray middle-click or a failed handler would
   * navigate the window itself to the page.
   */
  function linkNode(doc, href, title, kids, go, cls) {
    const a = h(doc, "a", cls, ...kids);
    a.setAttribute("role", "link");
    a.setAttribute("tabindex", "0");
    if (href || title) a.setAttribute("title", title ? (href ? `${title}\n${href}` : title) : href);
    a.addEventListener("click", (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); go(); });
    a.addEventListener("keydown", (e) => { if (e && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); go(); } });
    return a;
  }

  return { parse, inline, render, toggleTask, safeHref, linesOf, MAX_BLOCK_DEPTH, MAX_INLINE_DEPTH };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.DelphiMarkdown;
