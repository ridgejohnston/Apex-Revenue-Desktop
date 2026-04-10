/**
 * setup-osn.js — Downloads and extracts obs-studio-node binaries
 *
 * This script runs during `npm install` (postinstall) or `npm run setup`.
 * It downloads the pre-built obs-studio-node binaries from the Streamlabs
 * S3 bucket and extracts them into the `osn/` directory.
 *
 * This mirrors how Streamlabs Desktop installs obs-studio-node — they don't
 * use npm for it either, they pull the tarball directly from S3.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

const OSN_VERSION = '0.3.46'; // Latest stable release
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OSN_DIR = path.join(PROJECT_ROOT, 'osn');
const TEMP_DIR = path.join(os.tmpdir(), 'apex-osn-download');

// S3 download URLs — same bucket Streamlabs uses
const DOWNLOAD_URLS = {
  win32: `https://obsstudionodes3.streamlabs.com/osn-${OSN_VERSION}-release-win64.tar.gz`,
  darwin: `https://obsstudionodes3.streamlabs.com/osn-${OSN_VERSION}-release-osx.tar.gz`
};

// Fallback: GitHub release assets
const GITHUB_URLS = {
  win32: `https://github.com/streamlabs/obs-studio-node/releases/download/v${OSN_VERSION}/osn-${OSN_VERSION}-release-win64.tar.gz`,
  darwin: `https://github.com/streamlabs/obs-studio-node/releases/download/v${OSN_VERSION}/osn-${OSN_VERSION}-release-osx.tar.gz`
};

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  const platform = os.platform();

  if (platform !== 'win32' && platform !== 'darwin') {
    console.log(`[setup-osn] Skipping — obs-studio-node only supports Windows and macOS (current: ${platform})`);
    console.log('[setup-osn] Creating stub module for development...');
    createStubModule();
    return;
  }

  // Check if already downloaded
  if (fs.existsSync(path.join(OSN_DIR, 'index.js')) || fs.existsSync(path.join(OSN_DIR, 'obs_studio_node.node'))) {
    console.log('[setup-osn] obs-studio-node binaries already present in osn/ — skipping download');
    console.log('[setup-osn] To re-download, delete the osn/ folder and run: npm run setup');
    return;
  }

  console.log(`[setup-osn] Platform: ${platform}`);
  console.log(`[setup-osn] OSN Version: ${OSN_VERSION}`);

  // Create temp directory
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const tarPath = path.join(TEMP_DIR, `osn-${OSN_VERSION}.tar.gz`);

  // Try S3 first, then GitHub releases as fallback
  const urls = [
    { name: 'Streamlabs S3', url: DOWNLOAD_URLS[platform] },
    { name: 'GitHub Releases', url: GITHUB_URLS[platform] }
  ];

  let downloaded = false;

  for (const source of urls) {
    console.log(`[setup-osn] Trying ${source.name}: ${source.url}`);
    try {
      await downloadFile(source.url, tarPath);
      console.log(`[setup-osn] Downloaded from ${source.name}`);
      downloaded = true;
      break;
    } catch (err) {
      console.log(`[setup-osn] ${source.name} failed: ${err.message}`);
    }
  }

  if (!downloaded) {
    console.error('[setup-osn] Failed to download obs-studio-node from all sources.');
    console.error('[setup-osn] Creating stub module for development...');
    console.error('');
    console.error('  To manually install obs-studio-node:');
    console.error(`  1. Download from: ${GITHUB_URLS[platform]}`);
    console.error('  2. Extract the contents into the osn/ directory');
    console.error('');
    createStubModule();
    return;
  }

  // Extract
  console.log('[setup-osn] Extracting...');

  if (!fs.existsSync(OSN_DIR)) {
    fs.mkdirSync(OSN_DIR, { recursive: true });
  }

  try {
    if (platform === 'win32') {
      // Use tar on Windows (available in Win10+)
      execSync(`tar -xzf "${tarPath}" -C "${OSN_DIR}"`, { stdio: 'inherit' });
    } else {
      execSync(`tar -xzf "${tarPath}" -C "${OSN_DIR}"`, { stdio: 'inherit' });
    }

    // Some archives extract into a subdirectory — flatten if needed
    const entries = fs.readdirSync(OSN_DIR);
    if (entries.length === 1 && fs.statSync(path.join(OSN_DIR, entries[0])).isDirectory()) {
      const subdir = path.join(OSN_DIR, entries[0]);
      const subEntries = fs.readdirSync(subdir);
      for (const entry of subEntries) {
        fs.renameSync(path.join(subdir, entry), path.join(OSN_DIR, entry));
      }
      fs.rmdirSync(subdir);
    }

    console.log('[setup-osn] Extraction complete');
  } catch (err) {
    console.error('[setup-osn] Extraction failed:', err.message);
    createStubModule();
    return;
  }

  // Cleanup temp
  try {
    fs.unlinkSync(tarPath);
    fs.rmdirSync(TEMP_DIR, { recursive: true });
  } catch (e) { /* ignore cleanup errors */ }

  // Verify
  const hasIndex = fs.existsSync(path.join(OSN_DIR, 'index.js'));
  const hasNative = fs.existsSync(path.join(OSN_DIR, 'obs_studio_node.node'));
  const files = fs.readdirSync(OSN_DIR);

  console.log(`[setup-osn] osn/ contents: ${files.length} files`);

  if (hasIndex || hasNative) {
    console.log('[setup-osn] obs-studio-node installed successfully!');
  } else {
    console.log('[setup-osn] Warning: Expected files not found. Contents:', files.slice(0, 10).join(', '));
    console.log('[setup-osn] The module may need manual configuration.');
  }
}

// ─────────────────────────────────────────────
// DOWNLOAD HELPER
// ─────────────────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      // Handle redirects (GitHub uses these)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`[setup-osn] Following redirect...`);
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      let lastPercent = 0;

      const file = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.floor((downloadedBytes / totalBytes) * 100);
          if (percent >= lastPercent + 10) {
            process.stdout.write(`[setup-osn] ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)\n`);
            lastPercent = percent;
          }
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(destPath);
        if (stats.size < 1000) {
          // Too small — probably an error page
          const content = fs.readFileSync(destPath, 'utf8').substring(0, 200);
          fs.unlinkSync(destPath);
          reject(new Error(`Download too small (${stats.size} bytes). Content: ${content}`));
        } else {
          console.log(`[setup-osn] Downloaded ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        }
      });

      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

// ─────────────────────────────────────────────
// STUB MODULE (for development on unsupported platforms)
// ─────────────────────────────────────────────

function createStubModule() {
  if (!fs.existsSync(OSN_DIR)) {
    fs.mkdirSync(OSN_DIR, { recursive: true });
  }

  const stubCode = `/**
 * obs-studio-node STUB MODULE
 *
 * This is a development stub created because the real obs-studio-node
 * binaries could not be downloaded. The app will run but OBS features
 * will not work.
 *
 * To install the real binaries:
 *   1. Ensure you're on Windows or macOS
 *   2. Delete the osn/ folder
 *   3. Run: npm run setup
 *
 * Or manually download from:
 *   https://github.com/streamlabs/obs-studio-node/releases
 */

const STUB_WARNING = '[obs-studio-node STUB] This is a development stub. OBS features are not available.';

const handler = {
  get(target, prop) {
    if (prop === 'NodeObs') {
      return new Proxy({}, {
        get(t, p) {
          if (p === 'IPC') {
            return { host: () => console.warn(STUB_WARNING), disconnect: () => {} };
          }
          return (...args) => {
            console.warn(STUB_WARNING, 'Called:', p);
            return 0;
          };
        }
      });
    }
    if (['SceneFactory', 'InputFactory', 'FilterFactory', 'TransitionFactory'].includes(prop)) {
      return new Proxy({}, {
        get(t, p) {
          return (...args) => {
            console.warn(STUB_WARNING, 'Called:', prop + '.' + p);
            return new Proxy({}, {
              get: () => () => ({})
            });
          };
        }
      });
    }
    return undefined;
  }
};

module.exports = new Proxy({}, handler);
`;

  fs.writeFileSync(path.join(OSN_DIR, 'index.js'), stubCode);
  fs.writeFileSync(path.join(OSN_DIR, 'package.json'), JSON.stringify({
    name: 'obs-studio-node-stub',
    version: '0.0.0-stub',
    main: 'index.js'
  }, null, 2));

  console.log('[setup-osn] Stub module created in osn/');
  console.log('[setup-osn] The app will launch but OBS features will be disabled.');
}

// Run
main().catch(err => {
  console.error('[setup-osn] Fatal error:', err);
  createStubModule();
});
