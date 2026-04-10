/**
 * Electron Builder Configuration
 *
 * Separated from package.json for cleaner management and support
 * for the obs-studio-node binary bundling workflow.
 */

const path = require('path');

module.exports = {
  appId: 'com.apexrevenue.desktop',
  productName: 'Apex Revenue Desktop',
  copyright: 'Copyright 2026 Ridge Johnston',

  directories: {
    output: 'dist',
    buildResources: 'assets'
  },

  // ── Files to include in the app ──
  files: [
    'src/**/*',
    'assets/**/*',
    '!**/*.map',
    '!**/node_modules/.cache/**'
  ],

  // ── OSN binaries go into resources (not asar) ──
  // The osn/ folder contains native .node binaries and DLLs that
  // cannot be packed into an asar archive.
  extraResources: [
    {
      from: 'osn',
      to: 'osn',
      filter: ['**/*']
    }
  ],

  // Disable asar for now — obs-studio-node loads many DLLs
  // dynamically and they need to be on the real filesystem
  asar: false,

  // ── Windows Installer (NSIS) ──
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ],
    icon: 'assets/icon.png',
    // Sign if certificate is available (set CSC_LINK and CSC_KEY_PASSWORD env vars)
    // sign: null,
    artifactName: 'ApexRevenueDesktop-Setup-${version}.${ext}'
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    installerHeaderIcon: 'assets/icon.ico',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Apex Revenue Desktop',
    // Custom NSIS script for additional installer pages
    include: 'scripts/installer.nsh',
    deleteAppDataOnUninstall: false,
    // Require admin for installing native OBS libraries
    perMachine: true,
    allowElevation: true,
    // Install VC++ redistributable if needed (OBS requires it)
    installerSidebar: null,
    license: null
  },

  // ── macOS Installer (DMG) ──
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      }
    ],
    icon: 'assets/icon.png',
    category: 'public.app-category.video',
    artifactName: 'ApexRevenueDesktop-${version}-${arch}.${ext}',
    hardenedRuntime: true,
    entitlements: 'scripts/entitlements.mac.plist',
    entitlementsInherit: 'scripts/entitlements.mac.plist',
    // Camera and microphone access required for OBS
    extendInfo: {
      NSCameraUsageDescription: 'Apex Revenue Desktop needs camera access for streaming.',
      NSMicrophoneUsageDescription: 'Apex Revenue Desktop needs microphone access for streaming.',
      NSScreenCaptureUsageDescription: 'Apex Revenue Desktop needs screen capture access for streaming.'
    }
  },

  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' }
    ]
  },

  // ── Linux (AppImage) ──
  linux: {
    target: ['AppImage'],
    icon: 'assets/icon.png',
    category: 'AudioVideo',
    artifactName: 'ApexRevenueDesktop-${version}.${ext}'
  },

  // ── Publish (auto-update) ──
  // Uncomment and configure when ready for auto-updates
  // publish: [
  //   {
  //     provider: 'github',
  //     owner: 'ridgejohnston',
  //     repo: 'Apex-Revenue-Desktop'
  //   }
  // ],

  // ── Build hooks ──
  afterPack: async (context) => {
    console.log(`[afterPack] Platform: ${context.electronPlatformName}`);
    console.log(`[afterPack] App out: ${context.appOutDir}`);

    // Verify osn was copied to resources
    const osnInResources = path.join(context.appOutDir, 'resources', 'osn');
    const fs = require('fs');
    if (fs.existsSync(osnInResources)) {
      const files = fs.readdirSync(osnInResources);
      console.log(`[afterPack] osn/ in resources: ${files.length} files`);
    } else {
      console.warn('[afterPack] WARNING: osn/ not found in resources!');
    }
  }
};
