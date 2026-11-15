// Shared process helpers for the harness: free port, static server lifecycle, node child runs.
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS = path.join(ROOT, 'skill', 'restyle', 'scripts');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const live = new Set();
function killTree(child) {
  if (!child || child.exitCode != null || child.killed) return;
  try { child.kill(); } catch { /* already gone */ }
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const c of live) killTree(c); if (sig !== 'exit') process.exit(130); });
}

/** Serves dir with serve.mjs on a free port. Returns {url, port, stop()}. */
export async function startServer(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'serve.mjs'), dir, String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  live.add(child);
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('serve.mjs did not start within 10 s')), 10000);
    child.stdout.on('data', (d) => { buf += d; const m = buf.match(/"url":"([^"]+)"/); if (m) { clearTimeout(t); resolve(m[1]); } });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`serve.mjs exited ${c}: ${buf.slice(0, 300)}`)); });
  });
  return {
    url, port,
    stop: () => new Promise((resolve) => {
      if (child.exitCode != null) { live.delete(child); return resolve(); }
      child.once('exit', () => { live.delete(child); resolve(); });
      killTree(child);
      setTimeout(() => { live.delete(child); resolve(); }, 3000).unref();
    }),
  };
}

/** Runs `node script args` and resolves {code, stdout, stderr}; rejects on non-zero exit unless allowFail. */
export function runNode(script, args, { allowFail = false, timeoutMs = 300000, echo = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    live.add(child);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (echo) process.stderr.write(d); });
    const t = setTimeout(() => { killTree(child); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t); live.delete(child);
      if (code !== 0 && !allowFail) reject(new Error(`${path.basename(script)} exited ${code}: ${err.trim().slice(-600)}`));
      else resolve({ code, stdout: out, stderr: err });
    });
  });
}

/** Last JSON line printed by a script. */
export function lastJson(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch { /* not json */ } }
  return null;
}
