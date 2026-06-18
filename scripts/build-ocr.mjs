#!/usr/bin/env node
// Builds the optional macOS OCR helper (Swift + Vision framework).
//
// This is a best-effort postinstall step. It is skipped cleanly on any platform
// without the Swift toolchain — for example Windows or Linux — so `npm install`
// never fails because of it. It is written in Node rather than bash so it runs
// the same way regardless of the shell npm happens to use (cmd.exe on Windows
// has no `bash`). When the binary is absent, image attachments are still saved
// to disk; only OCR text extraction is unavailable.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = path.join(repoRoot, 'vendor', 'ocr', 'ocr.swift');
const out = path.join(repoRoot, 'vendor', 'ocr', 'ocr-bin');

const skip = (message) => {
  console.log(`[build-ocr] ${message}`);
  process.exit(0);
};

if (process.platform !== 'darwin') {
  skip('Non-macOS platform; skipping OCR build. Image attachments will save to disk but not extract text.');
}

// Probe for swiftc without throwing if it is not installed.
if (spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).error) {
  skip('swiftc not found; skipping OCR build. Image attachments will save to disk but not extract text.');
}

if (!existsSync(src)) {
  skip(`source missing at ${src}; skipping.`);
}

console.log(`[build-ocr] compiling ${src} -> ${out}`);
const result = spawnSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' });
if (result.status !== 0) {
  // Do not fail the whole install over the optional OCR helper.
  skip('swiftc failed; continuing without the OCR binary.');
}
console.log('[build-ocr] done.');
