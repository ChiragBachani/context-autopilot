/**
 * Wrapper around the native ctxhelper binary (see helper.swift): on-device
 * OCR via Apple Vision, Screen Recording permission preflight, and fixture
 * screenshot rendering. The binary is compiled on demand with the swiftc
 * that ships with Xcode Command Line Tools and cached under ~/.ctxlayer/bin,
 * keyed by a hash of the source so upgrades recompile automatically.
 *
 * Everything degrades gracefully: no swiftc → OCR returns nothing and the
 * pipeline falls back to window-title-only records.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctxlayerHome } from './config.js';

function helperSourcePath(): string {
  // helper.swift is copied next to the compiled JS by the build script.
  return join(dirname(fileURLToPath(import.meta.url)), 'helper.swift');
}

function binDir(): string {
  return join(ctxlayerHome(), 'bin');
}

let cachedBinary: string | null | undefined;

/**
 * Path to a ready-to-run ctxhelper binary, compiling it first if needed.
 * Returns null when the helper can't be built on this machine (no swiftc).
 */
export function helperBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  cachedBinary = buildHelper();
  return cachedBinary;
}

function buildHelper(): string | null {
  let source: string;
  try {
    source = readFileSync(helperSourcePath(), 'utf8');
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = binDir();
  const binary = join(dir, 'ctxhelper');
  const hashFile = join(dir, 'ctxhelper.hash');
  if (existsSync(binary) && existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) {
    return binary;
  }
  const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (swiftc.status !== 0) return null;
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'ctxhelper.swift');
  writeFileSync(src, source, 'utf8');
  const compile = spawnSync('swiftc', ['-O', src, '-o', binary], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (compile.status !== 0 || !existsSync(binary)) return null;
  chmodSync(binary, 0o755);
  writeFileSync(hashFile, hash, 'utf8');
  return binary;
}

function run(args: string[], timeout = 30_000): string | null {
  const binary = helperBinary();
  if (!binary) return null;
  const res = spawnSync(binary, args, { encoding: 'utf8', timeout });
  if (res.status !== 0) return null;
  return res.stdout ?? '';
}

/** Extract text lines from an image, entirely on-device. Null = helper unavailable. */
export function ocr(imagePath: string): string[] | null {
  const out = run(['ocr', imagePath]);
  if (out === null) return null;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Screen Recording permission state without prompting. 'unknown' = helper unavailable. */
export function screenPermission(): 'granted' | 'denied' | 'unknown' {
  const out = run(['perm', 'screen'], 10_000);
  if (out === null) return 'unknown';
  return out.trim() === 'granted' ? 'granted' : 'denied';
}

/** Render a fake-app screenshot (title bar + text lines) for tests and the demo. */
export function renderFixture(outPath: string, title: string, lines: string[]): boolean {
  return run(['fixture', outPath, title, ...lines], 30_000) !== null;
}
