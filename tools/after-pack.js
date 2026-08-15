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

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
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
