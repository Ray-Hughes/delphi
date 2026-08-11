#!/usr/bin/env python3
"""PreToolUse guard.

Claude Code runs this before every tool call. Exiting 2 denies the call and shows
the reason to the agent. It runs even under --dangerously-skip-permissions,
which is the whole point: that flag turns off the prompts, not the hooks, so this
is the only thing standing between a bypassed session and an irreversible
mistake.

Design notes:

- Deny narrowly and explain why. A guard that blocks ordinary work gets turned
  off, and a guard that is off protects nothing.
- Match on intent, not on a single spelling. `rm  -rf` with two spaces, or
  `-r -f` split apart, is the same command.
- Anything not recognised is allowed. This is a backstop against catastrophe,
  not a policy engine, and pretending otherwise invites false confidence.
"""

import json
import os
import re
import sys

# Paths that should never be the target of a recursive delete. Home and repo
# roots are here because the realistic accident is a variable that expanded to
# empty, turning "rm -rf $DIR/build" into "rm -rf /build" or worse.
PROTECTED_ROOTS = [
    "/", "/*", "~", "~/", "$HOME", "${HOME}",
    "/Users", "/Users/*", "/System", "/Applications", "/Library",
    "/etc", "/var", "/usr", "/bin", "/opt",
]


def norm(command: str) -> str:
    """Collapse whitespace so spacing tricks do not slip past a pattern."""
    return re.sub(r"\s+", " ", command.strip())


def has_recursive_force(cmd: str) -> bool:
    """True for rm with both recursive and force, however the flags are written."""
    if not re.search(r"\brm\b", cmd):
        return False
    flags = "".join(re.findall(r"\s-([a-zA-Z]+)", cmd))
    return "r" in flags.lower() and "f" in flags.lower()


def rm_targets(cmd: str):
    """Arguments to rm that are not flags."""
    match = re.search(r"\brm\b(.*)", cmd)
    if not match:
        return []
    return [a for a in match.group(1).split() if not a.startswith("-")]


def check_bash(cmd: str):
    """Return a refusal reason, or None to allow."""
    c = norm(cmd)
    low = c.lower()

    # --- catastrophic deletes -------------------------------------------------
    if has_recursive_force(c):
        for target in rm_targets(c):
            clean = target.strip("\"'").rstrip("/")
            if clean in [p.rstrip("/") for p in PROTECTED_ROOTS] or clean in ("", "/"):
                return f"Recursive force delete of {target!r}. This is not recoverable."
            # An unexpanded or empty variable is the classic way this goes wrong.
            if re.fullmatch(r"\$\{?\w+\}?", clean):
                return (
                    f"Recursive force delete of the unexpanded variable {target!r}. "
                    "If it is empty this deletes the working directory. "
                    "Expand it and pass a literal path."
                )
        if re.search(r"\brm\b[^|;&]*\s/\s*$", c):
            return "Recursive force delete of /."

    if re.search(r"\brm\b[^|;&]*\s-[a-zA-Z]*r[a-zA-Z]*\s+[\"']?/?\.git\b", c):
        return "Deleting the .git directory destroys all history and every unpushed commit."

    # --- destroying work that is not committed --------------------------------
    if re.search(r"\bgit\s+clean\b[^|;&]*-[a-zA-Z]*[fd]", c) and "-n" not in c and "--dry-run" not in c:
        return (
            "git clean removes untracked files permanently. "
            "Run it with -n first to see what would go, or name the paths explicitly."
        )

    if re.search(r"\bgit\s+checkout\s+(--)?\s*\.\s*$", c) or re.search(r"\bgit\s+restore\s+\.\s*$", c):
        return "This discards every uncommitted change in the tree. Name the files instead."

    # --- rewriting shared history ---------------------------------------------
    if re.search(r"\bgit\s+push\b", c) and re.search(r"(--force(?!-with-lease)|(?<![\w-])-f(?![\w-]))", c):
        if not re.search(r"--force-with-lease", c):
            return (
                "Force push without --force-with-lease can overwrite commits pushed by "
                "someone else. Use --force-with-lease, which refuses if the remote moved."
            )

    if re.search(r"\bgit\s+push\b[^|;&]*\s(--delete|:)\s*(main|master|develop|staging|production)\b", c):
        return "Deleting a protected branch on the remote."

    if re.search(r"\bgit\s+reset\s+--hard\b", c) and re.search(r"origin/(main|master)", c):
        return (
            "Hard reset onto a remote branch discards local commits with no way back "
            "except the reflog. Confirm this is intended and run it yourself."
        )

    # --- deleting hosted resources --------------------------------------------
    if re.search(r"\bgh\s+repo\s+delete\b", c):
        return "Deleting a GitHub repository. This is not something to do from an agent."
    if re.search(r"\bgh\s+(release|secret)\s+delete\b", c):
        return "Deleting a release or secret on GitHub."

    # --- databases -------------------------------------------------------------
    if re.search(r"\bdrop\s+(table|database|schema)\b", low):
        return "Dropping a table, database or schema."
    if re.search(r"\btruncate\s+table\b", low):
        return "Truncating a table."
    if re.search(r"\bdelete\s+from\b", low) and not re.search(r"\bwhere\b", low):
        return "DELETE FROM with no WHERE clause removes every row."

    # --- infrastructure --------------------------------------------------------
    if re.search(r"\bkubectl\s+delete\b[^|;&]*(namespace|ns)\b", c):
        return "Deleting a Kubernetes namespace takes everything in it with it."
    if re.search(r"\bterraform\s+destroy\b", c) and "-target" not in c:
        return "terraform destroy without a target tears down the whole stack."

    # --- host level ------------------------------------------------------------
    if re.search(r"\b(mkfs|fdisk|diskutil\s+erase)\b", c):
        return "Formatting or partitioning a disk."
    if re.search(r"\bdd\b[^|;&]*\bof=/dev/", c):
        return "Writing directly to a device with dd."
    if re.search(r":\(\)\s*\{.*\}\s*;?\s*:", c):
        return "Fork bomb."
    if re.search(r"\bchmod\b[^|;&]*-R[^|;&]*\s777\s+/", c):
        return "Recursive chmod 777 from a root path."

    # --- piping the internet into a shell ---------------------------------------
    if re.search(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b", c):
        return (
            "Piping a downloaded script straight into a shell runs code nobody has read. "
            "Download it, look at it, then run it."
        )

    if re.search(r"\bsudo\b", c) and re.search(r"\brm\b", c):
        return "sudo combined with rm."

    return None


def check_write(tool: str, tool_input: dict):
    """Guard edits to the files that control the agent's own permissions."""
    path = str(tool_input.get("file_path") or tool_input.get("path") or "")
    if not path:
        return None
    resolved = os.path.realpath(os.path.expanduser(path))
    settings = os.path.realpath(os.path.expanduser("~/.claude/settings.json"))
    guard = os.path.realpath(__file__)
    if resolved == settings:
        return (
            "This file configures the guard itself. Change it by hand rather than "
            "from inside a session it governs."
        )
    if resolved == guard:
        return "This is the guard script. Editing it from a guarded session defeats it."
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Malformed input should not wedge the session. Allow, and say so on stderr
        # so it is visible rather than silent.
        print("guard: could not parse hook payload, allowing", file=sys.stderr)
        sys.exit(0)

    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}

    reason = None
    if tool == "Bash":
        reason = check_bash(str(tool_input.get("command", "")))
    elif tool in ("Write", "Edit", "NotebookEdit"):
        reason = check_write(tool, tool_input)

    if reason:
        print(f"Blocked by guard: {reason}", file=sys.stderr)
        print(
            "If this is genuinely intended, run it yourself in a terminal. "
            "The guard deliberately has no override flag.",
            file=sys.stderr,
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
