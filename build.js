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
 * esbuild bundles the JS (including ORT) but cannot inline WASM blobs, so we
 * copy only the WASM files that are actually needed at runtime.
 *
 * We set numThreads=1 in embedder.js, so the *-threaded.wasm variants are
 * never loaded and can be omitted — saving ~18 MB.
 * The ORT JS files (ort.js, ort-web.js, ort*.min.js, etc.) are already
 * bundled inside embedder.js by esbuild, so copying them is pure waste.
 */
function copyOnnxWasmBinaries() {
  const onnxSrc = path.join('node_modules', 'onnxruntime-web', 'dist');
  const onnxDest = path.join(DIST, 'offscreen');
  if (!fs.existsSync(onnxSrc)) {
    console.warn('[build] WARNING: onnxruntime-web dist not found, skipping WASM copy.');
    return;
  }

  // Only copy the two single-threaded WASM binaries.
  // ort-wasm-simd.wasm  → used on CPUs with SIMD support (virtually all modern Chrome)
  // ort-wasm.wasm       → fallback for non-SIMD CPUs
  // Threaded variants are skipped because numThreads is pinned to 1 in embedder.js.
  const NEEDED_WASM = new Set([
    'ort-wasm-simd.wasm',
    'ort-wasm.wasm',
  ]);

  const allFiles = fs.readdirSync(onnxSrc);
  let copied = 0;
  let skipped = 0;
  for (const file of allFiles) {
    if (NEEDED_WASM.has(file)) {
      copyFileSync(path.join(onnxSrc, file), path.join(onnxDest, file));
      copied++;
    } else {
      skipped++;
    }
  }
  console.log(`[build] Copied ${copied} WASM file(s) to dist/offscreen/ (skipped ${skipped} unneeded files)`);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
