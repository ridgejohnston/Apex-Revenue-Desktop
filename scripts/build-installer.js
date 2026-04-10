/**
 * build-installer.js — Full build pipeline for Apex Revenue Desktop
 *
 * Steps:
 *   1. Verify/download obs-studio-node binaries into osn/
 *   2. Verify node_modules are installed
 *   3. Run electron-builder to create the platform installer
 *
 * Usage:
 *   node scripts/build-installer.js          (auto-detect platform)
 *   node scripts/build-installer.js --win    (force Windows build)
 *   node scripts/build-installer.js --mac    (force macOS build)
 *   node scripts/build-installer.js --dir    (unpackaged directory for testing)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OSN_DIR = path.join(PROJECT_ROOT, 'osn');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

// Parse CLI args
const args = process.argv.slice(2);
const forceWin = args.includes('--win');
const forceMac = args.includes('--mac');
const dirOnly = args.includes('--dir');
const skipOsn = args.includes('--skip-osn');

function log(msg) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${msg}`);
  console.log('='.repeat(60));
}

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    ...opts
  });
}

async function main() {
  const platform = os.platform();
  const startTime = Date.now();

  console.log('');
  console.log('  Apex Revenue Desktop — Installer Builder');
  console.log(`  Platform: ${platform} | Node: ${process.version}`);
  console.log(`  Project:  ${PROJECT_ROOT}`);
  console.log('');

  // ── Step 1: Ensure obs-studio-node binaries ──
  if (!skipOsn) {
    log('Step 1: Checking obs-studio-node binaries');

    const hasOsn = fs.existsSync(path.join(OSN_DIR, 'index.js'))
      || fs.existsSync(path.join(OSN_DIR, 'obs_studio_node.node'));

    if (hasOsn) {
      const files = fs.readdirSync(OSN_DIR);
      console.log(`  osn/ already present (${files.length} files)`);
    } else {
      console.log('  osn/ not found — downloading binaries...');
      run('node scripts/setup-osn.js');

      // Verify it worked
      const afterFiles = fs.existsSync(OSN_DIR) ? fs.readdirSync(OSN_DIR) : [];
      if (afterFiles.length === 0) {
        console.error('  ERROR: setup-osn.js produced no files. Cannot build installer.');
        console.error('  Try manually downloading from:');
        console.error('    https://github.com/streamlabs/obs-studio-node/releases');
        console.error('  Extract into the osn/ directory and re-run this script with --skip-osn');
        process.exit(1);
      }

      // Check if it's a stub
      const isStub = fs.existsSync(path.join(OSN_DIR, 'package.json'))
        && JSON.parse(fs.readFileSync(path.join(OSN_DIR, 'package.json'), 'utf8')).version === '0.0.0-stub';

      if (isStub) {
        console.warn('');
        console.warn('  WARNING: Only a stub module was created (real binaries failed to download).');
        console.warn('  The installer will build but OBS features will NOT work.');
        console.warn('  To fix: manually download binaries into osn/ and rebuild.');
        console.warn('');
      }
    }
  } else {
    log('Step 1: Skipping OSN check (--skip-osn)');
  }

  // ── Step 2: Ensure node_modules ──
  log('Step 2: Checking dependencies');

  if (!fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
    console.log('  node_modules not found — installing...');
    // Use --ignore-scripts to avoid re-running setup-osn during npm install
    run('npm install --ignore-scripts');
  } else {
    console.log('  node_modules present');
  }

  // Verify electron is available
  try {
    const electronPath = require.resolve('electron', { paths: [PROJECT_ROOT] });
    console.log(`  Electron found: ${electronPath.substring(0, 60)}...`);
  } catch (e) {
    console.log('  Electron not found — installing...');
    run('npm install --ignore-scripts');
  }

  // ── Step 3: Create assets directory with placeholder icon if missing ──
  log('Step 3: Checking assets');

  const assetsDir = path.join(PROJECT_ROOT, 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  // Create a minimal PNG icon if no icon exists (electron-builder requires it)
  const iconPng = path.join(assetsDir, 'icon.png');
  if (!fs.existsSync(iconPng)) {
    console.log('  Creating placeholder icon (replace with your real icon later)');
    createPlaceholderIcon(iconPng);
  }

  // ── Step 4: Build installer ──
  log('Step 4: Building installer');

  let buildCmd = 'npx electron-builder';

  if (forceWin) {
    buildCmd += ' --win';
  } else if (forceMac) {
    buildCmd += ' --mac';
  } else if (dirOnly) {
    buildCmd += ' --dir';
  }
  // else: auto-detect platform (electron-builder default)

  buildCmd += ' --config electron-builder.config.js';

  run(buildCmd);

  // ── Done ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Build complete in ${elapsed}s`);

  if (fs.existsSync(DIST_DIR)) {
    const outputs = fs.readdirSync(DIST_DIR).filter(f => {
      return f.endsWith('.exe') || f.endsWith('.dmg') || f.endsWith('.AppImage')
        || f.endsWith('.msi') || f.endsWith('.zip') || f === 'win-unpacked' || f === 'mac';
    });
    console.log('  Output files:');
    outputs.forEach(f => console.log(`    dist/${f}`));
  }

  console.log('');
}

/**
 * Create a minimal 256x256 PNG icon (orange "AR" placeholder).
 * This is a valid 1x1 orange PNG so electron-builder doesn't fail.
 * Replace with a real icon before shipping.
 */
function createPlaceholderIcon(filePath) {
  // Minimal valid PNG: 1x1 pixel, orange (#f05d23)
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xd7, 0x63, 0xe8, 0xb2, 0x4c, 0x00, // compressed pixel
    0x00, 0x00, 0x04, 0x00, 0x01, 0xf4, 0xd2, 0xc5,
    0x40, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
    0x44, 0xae, 0x42, 0x60, 0x82
  ]);
  fs.writeFileSync(filePath, png);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
