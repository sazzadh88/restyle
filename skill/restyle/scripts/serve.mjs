#!/usr/bin/env node
// Tiny static file server for a build dir. Usage: node serve.mjs <dir> [port] | node serve.mjs --stop <port>
// With a port: serves on exactly that port, or exits 1 with a clear message when it is busy (another
// server answering on 127.0.0.1 or ::1, or the bind failing) - never silently on another port, so a
// capture never measures some other site. Without a port: picks a free port. Prints {url,port,dir,pidFile}.
// Each running server records {pid, port, dir} in <os temp>/restyle-serve-<port>.json (removed when it
// exits). --stop <port> stops the server serve.mjs started on that port (works on Windows, where a
// background job cannot be sent Ctrl+C) by asking it to shut down (POST with the token from its pid record:
// the server exits 0), killing it only if that fails: prints {stopped:true, port, pid, dir, graceful}; exits 1 with
// {stopped:false, port, why} when nothing was stopped (no record, process gone, or not a node process).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const pidFileOf = (port) => path.join(os.tmpdir(), `restyle-serve-${port}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg) { console.error('usage: node serve.mjs <dir> [port] | node serve.mjs --stop <port>'); process.exit(2); }
if (dirArg === '--stop') await stop(portArg);
const root = path.resolve(dirArg);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`serve: directory not found: ${root}`); process.exit(1);
}
const asked = portArg !== undefined && portArg !== '' ? Number(portArg) : null;
if (asked !== null && (!Number.isInteger(asked) || asked < 1 || asked > 65535)) {
  console.error(`serve: invalid port: ${portArg}`); process.exit(2);
}
const busyMsg = (p, why) => `serve: port ${p} is already in use (${why}); nothing was started. Stop the other server, pass another port, or omit the port to get a free one.`;

function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404 Not Found'); }

// true when something accepts TCP connections on host:port (a server bound to 127.0.0.1 only can coexist
// with our wildcard bind on Windows, and then answers "localhost" requests instead of us)
// (a function declaration: --stop runs before the rest of this module is evaluated)
function answers(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// graceful stop: --stop POSTs STOP_PATH with the token from the pid record; the server answers, then exits 0
// (a killed process exits 1, which a background task runner reports as a failure)
const STOP_PATH = '/__restyle-serve-stop', TOKEN = crypto.randomBytes(16).toString('hex');
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === STOP_PATH) {
    if (req.headers['x-restyle-token'] !== TOKEN) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ stopping: true, pid: process.pid }), () => { server.close(); setTimeout(() => process.exit(0), 50); });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return notFound(res); }
  if (rel.includes('\0')) return notFound(res);
  let file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return notFound(res);
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const st = fs.statSync(file);
    if (!st.isFile()) return notFound(res);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size, 'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { notFound(res); }
});

async function main() {
  if (asked !== null) {
    for (const host of ['127.0.0.1', '::1']) if (await answers(host, asked)) { console.error(busyMsg(asked, `another server answers on ${host}:${asked}`)); process.exit(1); }
  }
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(busyMsg(asked ?? '?', 'bind failed: EADDRINUSE'));
    else console.error(`serve: ${err.message}`);
    process.exit(1);
  });
  server.on('listening', () => {
    const port = server.address().port;
    const pidFile = pidFileOf(port);
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, dir: root, token: TOKEN, started: new Date().toISOString() })); } catch { /* temp dir not writable: --stop cannot find it */ }
    const cleanup = () => { try { if (JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === process.pid) fs.unlinkSync(pidFile); } catch { /* gone */ } };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => process.exit(0));
    console.log(JSON.stringify({ url: `http://localhost:${port}`, port, dir: root, pidFile }));
  });
  server.listen(asked ?? 0);
}

// a live process with that pid whose image is node (a recycled pid of another program is never killed)
function isNodePid(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const r = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return r.status === 0 && /node/i.test(r.stdout || '');
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function stop(portArg) {
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`serve: --stop needs the port the server printed (got ${portArg ?? 'nothing'})`); process.exit(2); }
  const file = pidFileOf(port);
  const fail = (why) => { console.log(JSON.stringify({ stopped: false, port, why })); console.error(`serve: nothing stopped on port ${port}: ${why}`); process.exit(1); };
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`no server started by serve.mjs is recorded for this port (${file})`); }
  if (!rec || rec.port !== port || !Number.isInteger(rec.pid)) { try { fs.unlinkSync(file); } catch { /* ignore */ } fail('unreadable record (removed)'); }
  if (!isNodePid(rec.pid)) { try { fs.unlinkSync(file); } catch { /* ignore */ } fail(`process ${rec.pid} is not running (stale record removed)`); }
  // graceful first (the server exits 0), then kill as a fallback
  let graceful = false;
  if (rec.token) {
    try { const r = await fetch(`http://127.0.0.1:${port}/__restyle-serve-stop`, { method: 'POST', headers: { 'x-restyle-token': rec.token }, signal: AbortSignal.timeout(2000) }); graceful = r.ok; } catch { /* not answering: kill below */ }
    for (let k = 0; graceful && k < 30 && isAlive(rec.pid); k++) await sleep(100);
  }
  if (!graceful || isAlive(rec.pid)) {
    graceful = false;
    try { process.kill(rec.pid); } catch (e) { if (isAlive(rec.pid)) fail(`could not stop process ${rec.pid}: ${e.message}`); }
  }
  for (let k = 0; k < 30 && (await answers('127.0.0.1', port)); k++) await sleep(100);
  try { fs.unlinkSync(file); } catch { /* the server removed it */ }
  console.log(JSON.stringify({ stopped: true, port, pid: rec.pid, dir: rec.dir, graceful }));
  process.exit(0);
}
main();
