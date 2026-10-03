// How Delphi is packaged into things people can download.
//
// A JavaScript config rather than the YAML it replaces, for one reason: whether
// the mac build is signed has to be decided at build time. Signing cannot be
// left permanently on, because without a certificate electron-builder would fail
// the build rather than skip it, and it cannot be left permanently off, because
// `identity: null` disables signing even when a certificate is present. It has to
// look at the environment, and YAML cannot.

const signing = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

module.exports = {
  appId: "com.rayhughes.delphi",
  productName: "Delphi",
  copyright: "Copyright 2026 Ray Hughes",

  directories: {
    output: "release",
    buildResources: "build",
  },

  // Named explicitly rather than by exclusion. The default is everything that is
  // not ignored, which in this repository means a populated database, the
  // markdown vault and the personal seeding scripts would all be shipped to
  // strangers.
  files: [
    "main.js",
    "preload.js",
    "app.js",
    "index.html",
    "db.js",
    "paths.js",
    "version.js",
    "vault.js",
    "oracle.js",
    "embeddings.js",
    // The pad grammar. Also in extraResources below, because the MCP server
    // needs a copy it can read from outside the archive.
    "pads.js",
    // These three arrived after this list was last touched and were missing from
    // it, which meant a packaged build had a main process requiring files that
    // were not in the archive. Nothing catches that at build time.
    "ai.js",
    "git.js",
    "terminal.js",
    "harness.js",
    // Sheets and Workbenches. Listed before the files exist, because a missing
    // entry here is not an error: electron-builder skips it without a word, and
    // the first anyone hears of it is a packaged app that cannot start.
    // tools/package_test.js is what checks this list against the main process's
    // requires, so a gap shows up in `npm test` rather than on someone's Mac.
    "agent/schema_later.js",
    "agent/launch.js",
    "sheet/",
    "workbench/",
    "schema.sql",
    "oracle.sql",
    "package.json",
    // The tray icons and the mark in the sidebar, needed while the app is
    // running. build/ is not in this list: that holds what the installer
    // consumes, and none of it is read after installation.
    "assets/",
  ],

  // The MCP server is launched by an editor using its own Node, and a plain Node
  // cannot read inside an asar archive. So it is copied out as an ordinary file
  // that something other than Electron can actually run.
  //
  // Only files the app itself never requires belong here. electron-builder
  // treats every extraResources source as excluded from app.asar, silently, so a
  // file listed here and in `files` ends up outside the archive and missing from
  // it. That is how 1.6.0 shipped a main process that died on require("./pads")
  // before it could open a window. The modules both sides need (pads.js, git.js,
  // harness.js, agent/schema_later.js, agent/launch.js, sheet/, workbench/) are
  // copied out by tools/after-pack.js instead, from its OUTSIDE_TOO list, after
  // the archive is written. tools/package_test.js reads both lists and the real
  // archive, so neither half can go missing again without a test failing.
  //
  // The layout under Resources/ mirrors the checkout on purpose. The server and
  // the CLI find their modules by relative require (`../sheet/store`, `../git`,
  // `../agent/mcp_server.js`), so a require that works in a checkout works in an
  // installed build.
  extraResources: [
    { from: "agent/mcp_server.js", to: "agent/mcp_server.js" },
    { from: "agent/guard.py", to: "agent/guard.py" },
    // The server requires ./directives. It was left out of this list when that
    // file arrived, and every installed build since shipped a server that died
    // at its first require.
    { from: "agent/directives.js", to: "agent/directives.js" },
    // The command line tool. Resources/bin/delphi spawns ../agent/mcp_server.js,
    // the same server an editor uses. tools/after-pack.js makes sure it is still
    // executable once it lands here.
    { from: "bin/delphi", to: "bin/delphi" },
  ],

  // No version in the filename, on purpose. It makes
  // github.com/Ray-Hughes/delphi/releases/latest/download/Delphi-mac-arm64.dmg a
  // permanent address, so the download page and the README never go stale and
  // never need editing on release day.
  artifactName: "${productName}-${os}-${arch}.${ext}",

  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    darkModeSupport: true,
    // Both architectures as separate files rather than one universal binary. A
    // universal build is twice the download for every user so that neither has
    // to pick, and the download page can work out which one to offer.
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],

    // With a certificate: sign properly, harden the runtime, and notarise, which
    // is what removes the Gatekeeper detour and is also the only way Squirrel
    // will ever install an update over this app.
    //
    // Without one: identity null, so electron-builder skips signing rather than
    // failing, and tools/after-pack.js applies an ad-hoc signature instead.
    // Apple Silicon refuses to start a binary carrying no signature at all.
    ...(signing
      ? {
          hardenedRuntime: true,
          gatekeeperAssess: false,
          entitlements: "build/entitlements.mac.plist",
          entitlementsInherit: "build/entitlements.mac.plist",
          notarize: true,
        }
      : { identity: null }),
  },

  dmg: {
    title: "Delphi",
    // Window layout of the drag-to-install panel. The Applications alias on the
    // right is the whole instruction, so it is the only other thing in the
    // window.
    contents: [
      { x: 138, y: 200, type: "file" },
      { x: 402, y: 200, type: "link", path: "/Applications" },
    ],
  },

  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
  },

  nsis: {
    // A wizard rather than a one-click installer. One-click writes to Program
    // Files, which needs administrator rights, and a download that opens a UAC
    // prompt with a publisher of "Unknown" is where most people stop.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Delphi",
    artifactName: "${productName}-Setup.exe",
  },

  // Ad-hoc signs the mac build when there is no certificate. Without it an
  // unsigned app will not launch at all on Apple Silicon, quarantine or no
  // quarantine. It stands down as soon as CSC_LINK is set.
  afterPack: "./tools/after-pack.js",

  publish: [
    {
      provider: "github",
      owner: "Ray-Hughes",
      repo: "delphi",
      // Published outright rather than left as a draft, which is the default.
      // The download page and the README link to /releases/latest/download/, and
      // a draft is not "latest": it is invisible to everyone without push
      // access, so every download link on the site stays broken until someone
      // remembers to press publish. Pushing a version tag is already the
      // deliberate step.
      releaseType: "release",
    },
  ],
};
