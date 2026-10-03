// Ad-hoc signs the macOS build.
//
// Apple Silicon will not run an executable with no signature at all. Not a
// warning, not a Gatekeeper prompt that can be clicked through: the kernel
// refuses to start it. Electron's own binaries arrive ad-hoc signed, but packaging
// rewrites Info.plist, renames the executable and adds resources, and any one of
// those invalidates the signature that was there.
//
// So an unsigned release still has to be signed, just with the ad-hoc identity
// ("-") rather than a Developer ID. That produces an app that launches once the
// user clears quarantine, which is the step the install page walks through.
//
// This is skipped entirely when a real certificate is configured, because then
// electron-builder has already signed it properly and re-signing would undo that.

//
// Before signing, and on every platform, it does two things to Resources/,
// because changing a file after signing it would be the wrong order:
//
// - copies out the modules that the app needs inside app.asar and the MCP server
//   and the CLI need outside it (OUTSIDE_TOO below), and
// - makes sure the command line tool is still executable.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Modules required both by the main process, from inside app.asar, and by the
 * MCP server and bin/delphi, which run under a plain Node from Resources/ and
 * cannot read the archive.
 *
 * They cannot go in extraResources. electron-builder excludes every
 * extraResources source from the app, without a warning, so listing a file
 * there takes it out of app.asar. 1.6.0 shipped like that and its main process
 * died on require("./pads") before it opened a window. So these stay in `files`
 * only, and are copied out here once the archive has been written.
 *
 * Paths are relative to the project and land at the same relative path under
 * Resources/, which keeps the layout the server's relative requires expect.
 * tools/package_test.js reads this list, so it is exported.
 */
const OUTSIDE_TOO = [
  "pads.js",
  "git.js",
  "harness.js",
  "agent/schema_later.js",
  "agent/launch.js",
  "sheet",
  "workbench",
];

function resourcesDir(context) {
  return context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
}

/** Copies OUTSIDE_TOO from projectDir into resources. Throws if one is missing. */
function copyOutsideToo(projectDir, resources) {
  for (const rel of OUTSIDE_TOO) {
    const from = path.join(projectDir, rel);
    // Loud and fatal, unlike signing below. A build without one of these has an
    // MCP server that cannot start, and that is not a release worth finishing.
    if (!fs.existsSync(from)) throw new Error(`after-pack: ${rel} is listed in OUTSIDE_TOO but does not exist`);
    fs.cpSync(from, path.join(resources, rel), { recursive: true });
  }
  console.log(`  after-pack: copied ${OUTSIDE_TOO.length} shared modules out beside app.asar`);
}

/**
 * Resources/bin/delphi has to carry its executable bit, because `make cli` and
 * anyone following the README symlink it onto PATH and run it directly. Git
 * records the bit and electron-builder normally keeps it, but "normally" is the
 * word that hides a broken install, so it is checked here and put back if lost.
 */
function ensureCliExecutable(context) {
  if (context.electronPlatformName === "win32") return;
  const resources = resourcesDir(context);
  const cli = path.join(resources, "bin", "delphi");
  if (!fs.existsSync(cli)) {
    console.log("  after-pack: no bin/delphi in this build, nothing to make executable");
    return;
  }
  const mode = fs.statSync(cli).mode;
  if ((mode & 0o111) === 0o111) return;
  fs.chmodSync(cli, mode | 0o755);
  console.warn("  after-pack: bin/delphi arrived without its executable bit, and has been given it back");
}

exports.default = async function afterPack(context) {
  copyOutsideToo(context.packager.projectDir, resourcesDir(context));
  ensureCliExecutable(context);
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log("  after-pack: a signing certificate is configured, leaving the signature alone");
    return;
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  try {
    // Nested code first, then the bundle. Signing the outside before the inside
    // leaves the outer signature stale the moment the inner one is written, which
    // is the failure --deep exists to paper over and does not reliably fix.
    execFileSync("/usr/bin/codesign", [
      "--force", "--deep", "--sign", "-", "--timestamp=none", app,
    ], { stdio: "pipe" });
    console.log(`  after-pack: ad-hoc signed ${path.basename(app)}`);
  } catch (error) {
    // Loud, but not fatal. A build that produced an unlaunchable app is worth
    // knowing about, and stopping the release for it helps nobody.
    console.error(`  after-pack: ad-hoc signing failed, the mac build may not launch: ${error.message}`);
  }
};

exports.OUTSIDE_TOO = OUTSIDE_TOO;
exports.copyOutsideToo = copyOutsideToo;
