#!/usr/bin/env bash
# Builds a double-clickable Delphi launcher on the Desktop.
#
# A real .app bundle rather than a .command file, because a .command opens a
# Terminal window that stays open behind the panel, which looks broken to
# anyone who did not expect it. LSUIElement keeps the launcher itself out of
# the dock; the panel it starts has its own tray icon.
#
# Safe to re-run. It replaces the bundle rather than failing on one already
# being there, so an upgrade is the same command as an install.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/Desktop}"
BUNDLE="$DEST/Delphi.app"

if [ ! -d "$DEST" ]; then
  echo "  No such folder: $DEST" >&2
  exit 1
fi

# Resolved now rather than at launch: an app bundle starts with a bare PATH,
# so a version manager shim that works in a terminal is not on it.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "  node was not found on PATH. Install Node 18 or newer first." >&2
  exit 1
fi
# The real binary, not a version manager shim. A shim needs the manager itself
# on PATH, which an app bundle launched from the Finder does not have.
NODE_REAL="$("$NODE_BIN" -e 'console.log(process.execPath)' 2>/dev/null || echo "$NODE_BIN")"

if [ ! -x "$APP_DIR/node_modules/.bin/electron" ]; then
  echo "  Dependencies are not installed yet. Run: make install" >&2
  exit 1
fi

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Delphi</string>
  <key>CFBundleDisplayName</key><string>Delphi</string>
  <key>CFBundleIdentifier</key><string>com.delphi.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Delphi</string>
  <key>CFBundleIconFile</key><string>Delphi</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cat > "$BUNDLE/Contents/MacOS/Delphi" <<LAUNCHER
#!/usr/bin/env bash
# Starts Delphi, or brings the running one forward.
set -uo pipefail
cd "$APP_DIR" || exit 1
export PATH="\$(dirname "$NODE_REAL"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

ELECTRON="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# Already up: the panel has no dock icon, so this is checked by process.
if pgrep -f "\$ELECTRON" >/dev/null 2>&1; then
  osascript -e 'display notification "Already running. Press your hotkey to show it." with title "Delphi"' 2>/dev/null
  exit 0
fi

# The embedding model is optional. Search falls back to lexical without it,
# so a missing ollama must not stop the app from starting.
if command -v ollama >/dev/null 2>&1; then
  curl -s --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 || \\
    (nohup ollama serve >/tmp/delphi-ollama.log 2>&1 &)
fi

# Electron directly rather than through npm. npm here resolves to a version
# manager shim on many machines, and a shim cannot run without its manager on
# PATH, which is not the case for a bundle launched from the Finder.
nohup "$APP_DIR/node_modules/.bin/electron" . >/tmp/delphi.log 2>&1 &

for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  pgrep -f "\$ELECTRON" >/dev/null 2>&1 && break
done

if pgrep -f "\$ELECTRON" >/dev/null 2>&1; then
  osascript -e 'display notification "Press your hotkey to show the panel." with title "Delphi is running"' 2>/dev/null
else
  osascript -e 'display notification "Failed to start. See /tmp/delphi.log" with title "Delphi"' 2>/dev/null
fi
LAUNCHER

chmod +x "$BUNDLE/Contents/MacOS/Delphi"

# An icon if one is in the repository; the generic app icon otherwise, which
# is cosmetic rather than a failure.
if [ -f "$APP_DIR/build/icon.icns" ]; then
  cp "$APP_DIR/build/icon.icns" "$BUNDLE/Contents/Resources/Delphi.icns"
fi

# Without this the Finder can keep showing the previous icon and name.
touch "$BUNDLE"

echo "  Created $BUNDLE"
echo "  Double-click it to start Delphi."
