/**
 * Electron Builder Configuration
 *
 * Separated from package.json for cleaner management and support
 * for the obs-studio-node binary bundling workflow.
 */

const path = require('path');
const fs = require('fs');

// Check which icon formats are available
const hasIco = fs.existsSync(path.join(__dirname, 'assets', 'icon.ico'));
const hasPng = fs.existsSync(path.join(__dirname, 'assets', 'icon.png'));
const iconPath = hasIco ? 'assets/icon.ico' : (hasPng ? 'assets/icon.png' : undefined);

module.exports = {
  appId: 'com.apexrevenue.desktop',
  productName: 'Apex Revenue',
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

  // Disable asar — obs-studio-node loads DLLs dynamically
  // and they need to be on the real filesystem
  asar: false,

  // ── Windows Installer (NSIS) ──
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ],
    icon: iconPath,
    artifactName: 'ApexRevenueDesktop-Setup-${version}.${ext}',
    publisherName: 'Ridge Johnston',
    // Azure Trusted Signing (Microsoft Artifact Signing) — $10/mo
    // Signing is activated when AZURE_TENANT_ID is set in CI env.
    // When not set, CSC_IDENTITY_AUTO_DISCOVERY=false skips signing.
    ...(process.env.AZURE_TENANT_ID ? {
      azureSignOptions: {
        publisherName: 'Ridge Johnston',
        endpoint: process.env.AZURE_SIGN_ENDPOINT || 'https://eus.codesigning.azure.net/',
        certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME || 'apex-revenue',
        codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT || 'apex-revenue-signing'
      }
    } : {
      signDlls: false
    }),
  },

  nsis: {
    oneClick: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Apex Revenue',
    deleteAppDataOnUninstall: false,
    perMachine: false,
    allowElevation: true,
    // Custom NSIS include for VC++ check and firewall rule
    include: 'scripts/installer.nsh'
  },

  // ── macOS Installer (DMG) ──
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      }
    ],
    icon: iconPath,
    category: 'public.app-category.video',
    artifactName: 'ApexRevenueDesktop-${version}-${arch}.${ext}',
    hardenedRuntime: true,
    entitlements: 'scripts/entitlements.mac.plist',
    entitlementsInherit: 'scripts/entitlements.mac.plist',
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
    icon: iconPath,
    category: 'AudioVideo',
    artifactName: 'ApexRevenueDesktop-${version}.${ext}'
  },

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
