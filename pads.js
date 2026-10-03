// Turning a scratchpad into a task list, and back again.
//
// The premise: every agent already keeps a working document with a plan in it,
// and the plan is already written as checkboxes because that is what markdown
// gives you. So the board should not be a second list somebody maintains
// alongside the pad. It should be the pad, read differently.
//
// This module is the reading. It is pure text in, text out, with no database
// access at all, so the rules below can be tested by running tools/pad_test.js
// with plain node and no fixtures. db.js owns the rows; this owns the grammar.
//
// The grammar, in full:
//
//   - [ ] wire the codex adapter  @ray !high      an open task, assigned, urgent
//   - [x] terminal beside the chat                a finished one
//     - [ ] and a busy dot on the tab             a subtask, by indentation
//
// Anything that is not a checkbox line is prose, and prose is left alone. A pad
// is a document first; the task list is what falls out of it.
//
// ---------------------------------------------------------------------------
// Identity, which is the whole problem
//
// Two-way sync needs to know that this line and that task row are the same
// thing, across edits to either. The obvious answer is to hash the line text,
// and it is wrong: an agent rewording its own plan is not an unusual event, it
// is the main thing an agent does to a plan. Every reword would orphan a task
// and create a duplicate.
//
// So the line carries the task id, written back into it as an HTML comment:
//
//   - [ ] wire the codex adapter <!--d:812-->
//
// Invisible everywhere markdown is rendered, survives rewording the line around
// it, and readable from both directions with no guessing. The cost is that
// Delphi writes to a document a person may have open, which is why the anchor is
// the only thing it ever adds unasked.

// A checkbox line. The bullet may be any of the three markdown allows, and the
// capture groups are indent, marker, state, rest.
const CHECKBOX = /^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/;

// The anchor, anywhere in the line. Written at the end, but matched anywhere
// because an agent rewriting the line around it may well move it.
const ANCHOR = /<!--\s*d:(\d+)\s*-->/;

// @name, at a word boundary. Anchored to whitespace or line start rather than
// matched bare, so an email address or a decorator in a code fragment is not
// read as an assignee.
const ASSIGNEE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_.-]*)/;

// !high, !med, !low. Same boundary rule, and no bare "!" shorthand: a line
// ending in an exclamation mark is a sentence, not a priority.
const PRIORITY = /(^|\s)!(high|med|low)\b/i;

const PRIORITIES = ["high", "med", "low"];

/** How deep a line is nested. Tabs count as two spaces, as markdown renderers do. */
function depthOf(indent) {
  const width = indent.replace(/\t/g, "  ").length;
  return Math.floor(width / 2);
}

/**
 * Reads a pad body into the task lines it contains.
 *
 * Returns one entry per checkbox line, in document order, each carrying enough
 * to write the line back: the index into the array of lines, the raw text, and
 * everything parsed out of it. Non-checkbox lines are not represented at all.
 *
 * parentIndex points at the position in this same array, not at a task id,
 * because on a first pass none of these have ids yet.
 */
function parse(body) {
  const lines = String(body == null ? "" : body).split("\n");
  const found = [];
  // Nesting is resolved with a stack of open depths rather than by counting
  // spaces against a fixed unit, so a pad indented with four spaces nests the
  // same way as one indented with two.
  const stack = [];

  lines.forEach((raw, index) => {
    const m = CHECKBOX.exec(raw);
    if (!m) return;
    const [, indent, marker, state, rest] = m;
    const depth = depthOf(indent);

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].at : null;

    const anchorMatch = ANCHOR.exec(rest);
    const assigneeMatch = ASSIGNEE.exec(rest);
    const priorityMatch = PRIORITY.exec(rest);

    const title = rest
      .replace(ANCHOR, "")
      .replace(ASSIGNEE, "$1")
      .replace(PRIORITY, "$1")
      .replace(/\s+/g, " ")
      .trim();

    const entry = {
      index,                      // which line of the body
      at: found.length,           // which entry of this array
      raw,
      indent,
      marker,
      depth,
      done: state.toLowerCase() === "x",
      title,
      taskId: anchorMatch ? Number(anchorMatch[1]) : null,
      assignee: assigneeMatch ? assigneeMatch[2] : null,
      priority: priorityMatch ? priorityMatch[2].toLowerCase() : null,
      parentIndex: parent,
    };
    found.push(entry);
    stack.push({ depth, at: entry.at });
  });

  return found;
}

/** Composes a line from its parts, with the anchor last so it reads as an aside. */
function compose({ indent, marker, done, title, assignee, priority, taskId }) {
  const bits = [`${indent}${marker || "-"} [${done ? "x" : " "}] ${title}`.trimEnd()];
  if (assignee) bits.push(`@${assignee}`);
  if (priority && priority !== "med") bits.push(`!${priority}`);
  if (taskId) bits.push(`<!--d:${taskId}-->`);
  return bits.join(" ");
}

/**
 * Rewrites one checkbox line, found by the entry that described it.
 *
 * Everything not named in `fields` is kept as it was parsed, so writing back a
 * status cannot quietly drop an assignee the pad already carried.
 */
function writeLine(body, entry, fields = {}) {
  const lines = String(body == null ? "" : body).split("\n");
  if (!lines[entry.index] || !CHECKBOX.test(lines[entry.index])) return body;
  lines[entry.index] = compose({
    indent: entry.indent,
    marker: entry.marker,
    done: fields.done !== undefined ? fields.done : entry.done,
    title: fields.title !== undefined ? fields.title : entry.title,
    assignee: fields.assignee !== undefined ? fields.assignee : entry.assignee,
    priority: fields.priority !== undefined ? fields.priority : entry.priority,
    taskId: fields.taskId !== undefined ? fields.taskId : entry.taskId,
  });
  return lines.join("\n");
}

/**
 * Puts a task id into a line that did not have one.
 *
 * Separate from writeLine because this is the one edit Delphi makes to a pad
 * nobody asked it to make, and it should be findable by name when someone asks
 * why their document changed.
 */
function anchorLine(body, entry, taskId) {
  return writeLine(body, entry, { taskId });
}

/** The task ids a pad currently claims, for working out what has been dropped. */
function anchoredIds(body) {
  return new Set(parse(body).map((e) => e.taskId).filter((id) => id != null));
}

/**
 * What a pad line says a task should look like.
 *
 * status is deliberately not a straight mapping from the checkbox. A checkbox
 * has two states and a task has four, so an unticked box cannot mean "todo"
 * unconditionally: a task somebody moved to doing or blocked on the board would
 * be dragged back to todo by the next pad write, and the board would look like
 * it kept forgetting. An unticked box therefore means "not done", and only
 * changes a status that was done.
 */
function statusFor(done, current) {
  if (done) return "done";
  if (current === "done" || !current) return "todo";
  return current;
}

module.exports = {
  CHECKBOX, ANCHOR, PRIORITIES,
  parse, compose, writeLine, anchorLine, anchoredIds, statusFor, depthOf,
};
