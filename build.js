/**
 * build.js — esbuild bundler for the extension.
 *
 * Only offscreen/embedder.js needs bundling (it imports @xenova/transformers).
 * Everything else (popup, content scripts, service worker, utils, storage)
 * is copied verbatim so it stays debuggable and readable in devtools.
 */

import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const isWatch = process.argv.includes('--watch');
const SRC = '.';
const DIST = 'dist';

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Directories / files that are copied as-is (no bundling needed)
const COPY_TARGETS = [
  'manifest.json',
  'popup',
  'content',
  'background',
  'storage',
  'utils',
  'icons',
  'models',
  'offscreen/offscreen.html',
];

function copyStaticAssets() {
  for (const target of COPY_TARGETS) {
    const src = path.join(SRC, target);
    const dest = path.join(DIST, target);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copyDirSync(src, dest);
    } else {
      copyFileSync(src, dest);
    }
  }
  console.log('[build] Static assets copied to dist/');
}

// ---------------------------------------------------------------------------
// esbuild — bundle offscreen/embedder.js
// ---------------------------------------------------------------------------

const buildOptions = {
  entryPoints: ['offscreen/embedder.js'],
  bundle: true,
  outdir: path.join(DIST, 'offscreen'),
  format: 'esm',
  platform: 'browser',
  target: ['chrome109'],
  // Keep model WASM paths as-is so they resolve correctly at runtime
  external: [],
  // transformers.js uses dynamic import for WASM — mark onnxruntime as external
  // so it resolves from the bundled node_modules path we copy below
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
};

async function build() {
  // Clean dist
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST, { recursive: true });

  copyStaticAssets();

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[build] Watching offscreen/embedder.js…');
  } else {
    await esbuild.build(buildOptions);
    console.log('[build] offscreen/embedder.js bundled.');

    // Copy ONNX Runtime WASM binaries required by @xenova/transformers
    copyOnnxWasmBinaries();
    console.log('[build] Done. Extension ready in dist/');
  }
}

/**
 * @xenova/transformers relies on onnxruntime-web WASM binaries.
 * esbuild bundles the JS but cannot inline the WASM blobs, so we copy them.
 */
function copyOnnxWasmBinaries() {
  const onnxSrc = path.join('node_modules', 'onnxruntime-web', 'dist');
  const onnxDest = path.join(DIST, 'offscreen');
  if (!fs.existsSync(onnxSrc)) {
    console.warn('[build] WARNING: onnxruntime-web dist not found, skipping WASM copy.');
    return;
  }
  const wasmFiles = fs.readdirSync(onnxSrc).filter(f => f.endsWith('.wasm') || f.endsWith('.mjs') || f.endsWith('.js'));
  for (const file of wasmFiles) {
    copyFileSync(path.join(onnxSrc, file), path.join(onnxDest, file));
  }
  console.log(`[build] Copied ${wasmFiles.length} ONNX WASM/JS files to dist/offscreen/`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
