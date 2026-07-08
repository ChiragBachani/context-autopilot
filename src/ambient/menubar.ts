/**
 * Compile-on-demand launcher for the native menu bar app (menubar.swift),
 * mirroring helper.ts: the Swift source is compiled with the swiftc that ships
 * with Xcode CLT and cached under ~/.ctxlayer/bin, keyed by a source hash so
 * edits recompile automatically. The app self-guards against double launch
 * (pid lock), so calling this repeatedly is safe.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctxlayerHome } from './config.js';

function menubarSourcePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'menubar.swift');
}

function binDir(): string {
  return join(ctxlayerHome(), 'bin');
}

/** Path to a compiled ctxmenubar binary, building it if needed. Null = no swiftc. */
export function menubarBinary(): string | null {
  let source: string;
  try {
    source = readFileSync(menubarSourcePath(), 'utf8');
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = binDir();
  const binary = join(dir, 'ctxmenubar');
  const hashFile = join(dir, 'ctxmenubar.hash');
  if (existsSync(binary) && existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) {
    return binary;
  }
  if (spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status !== 0) return null;
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'ctxmenubar.swift');
  writeFileSync(src, source, 'utf8');
  const compile = spawnSync('swiftc', ['-O', src, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
  if (compile.status !== 0 || !existsSync(binary)) return null;
  chmodSync(binary, 0o755);
  writeFileSync(hashFile, hash, 'utf8');
  return binary;
}

/**
 * Launch the menu bar app detached (it runs its own event loop and outlives
 * this process). Returns false if it couldn't be built. Safe to call when one
 * is already running — the app's pid lock makes a second launch a no-op.
 */
export function launchMenuBar(): boolean {
  const binary = menubarBinary();
  if (!binary) return false;
  spawn(binary, [], { stdio: 'ignore', detached: true, env: process.env }).unref();
  return true;
}
