/**
 * scripts/download-models.js
 *
 * Downloads the quantized all-MiniLM-L6-v2 model from Hugging Face
 * into models/Xenova/all-MiniLM-L6-v2/ so the extension can run offline.
 *
 * Usage:  node scripts/download-models.js
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIR = path.join('models', 'Xenova', 'all-MiniLM-L6-v2');
const ONNX_DIR = path.join(MODEL_DIR, 'onnx');

// Files to download from HuggingFace
const FILES = [
  { remote: 'config.json',           local: path.join(MODEL_DIR, 'config.json') },
  { remote: 'tokenizer.json',        local: path.join(MODEL_DIR, 'tokenizer.json') },
  { remote: 'tokenizer_config.json', local: path.join(MODEL_DIR, 'tokenizer_config.json') },
  { remote: 'special_tokens_map.json', local: path.join(MODEL_DIR, 'special_tokens_map.json') },
  { remote: 'onnx/model_quantized.onnx', local: path.join(ONNX_DIR, 'model_quantized.onnx') },
];

const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // Skip if already present and non-empty
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  [skip] ${dest} already exists`);
      return resolve();
    }

    console.log(`  [↓] ${url}`);
    const file = fs.createWriteStream(dest);

    const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

    const request = (targetUrl, redirectsLeft = 10) => {
      https.get(targetUrl, (res) => {
        if (REDIRECT_CODES.has(res.statusCode)) {
          if (redirectsLeft === 0) {
            file.close();
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            return reject(new Error(`Too many redirects for ${targetUrl}`));
          }
          // Consume and discard the redirect body to free the socket
          res.resume();
          // Resolve relative redirect locations against the current URL
          const location = res.headers.location;
          const nextUrl = location.startsWith('http')
            ? location
            : new URL(location, targetUrl).toString();
          return request(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`  [✓] ${dest}`);
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
    };

    request(url);
  });
}

async function main() {
  console.log(`Downloading model: ${MODEL_ID}`);
  console.log(`Destination: ${path.resolve(MODEL_DIR)}\n`);

  for (const { remote, local } of FILES) {
    await download(`${HF_BASE}${remote}`, local);
  }

  console.log('\nModel download complete.');
  console.log('Run "npm run build" to package the extension.');
}

main().catch(err => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
