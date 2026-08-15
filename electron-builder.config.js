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
  extraResources: [
    { from: "agent/mcp_server.js", to: "agent/mcp_server.js" },
    { from: "agent/guard.py", to: "agent/guard.py" },
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
