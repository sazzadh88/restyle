#!/usr/bin/env node
// Asserts serve.mjs port handling: no port -> a free port, printed; a given busy port (bound by another
// server, also one listening on 127.0.0.1 only) -> exit 1 with a clear message, never another port; a
// given free port -> exactly that port; --stop <port> stops it (exit 0; the server itself exits 0, a
// graceful shutdown, not a kill), a second --stop exits 1, a bad
// port exits 2. Prints one line per assertion, then one JSON summary line.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(root, 'skill', 'restyle', 'scripts', 'serve.mjs');
const DIR = path.join(root, 'harness', 'fixtures', 'known');
const results = [];
const pidFiles = [];
const check = (name, ok, got, want) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`); };

// starts serve.mjs; resolves {child, json} once it prints its JSON line, or {code, err} when it exits first
function serve(args, waitMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVE, DIR, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => resolve({ child, timeout: true }), waitMs);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/\{.*\}/); if (m) { clearTimeout(t); try { const json = JSON.parse(m[0]); if (json.pidFile) pidFiles.push(json.pidFile); resolve({ child, json }); } catch { resolve({ child, out }); } } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, err: err.trim() }); });
  });
}
const listen = (port, host) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => resolve(s)); });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const get = async (url) => { try { const r = await fetch(url); return r.status; } catch { return null; } };
// node serve.mjs --stop <args>: {code, json}
const runStop = (args) => {
  const r = spawnSync(process.execPath, [SERVE, '--stop', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  let json = null; try { json = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* none */ }
  return { code: r.status, json };
};

async function main() {
  const kids = [];
  try {
    const a = await serve([]);
    if (a.child) kids.push(a.child);
    check('no port: starts and prints a port', a.json && Number.isInteger(a.json.port) && a.json.url === `http://localhost:${a.json.port}`, a.json || a, '{url,port}');
    check('no port: serves the dir', a.json && (await get(a.json.url + '/')) === 200, a.json && a.json.url, 200);
    if (a.json) {
      const b = await serve([String(a.json.port)]);
      if (b.child) kids.push(b.child);
      check('busy port (our own server): exit 1, no other port', b.code === 1 && /already in use/.test(b.err || ''), b.json || { code: b.code, err: (b.err || '').slice(0, 90) }, 'exit 1 + message');
    }
    const p1 = await freePort();
    const holder = await listen(p1, '127.0.0.1');
    const c = await serve([String(p1)]);
    if (c.child) kids.push(c.child);
    check('busy port (127.0.0.1-only listener): exit 1', c.code === 1 && /already in use/.test(c.err || ''), c.json || { code: c.code, err: (c.err || '').slice(0, 90) }, 'exit 1 + message');
    holder.close();
    const p2 = await freePort();
    const d = await serve([String(p2)]);
    if (d.child) kids.push(d.child);
    check('free given port: exactly that port', d.json && d.json.port === p2 && (await get(d.json.url + '/')) === 200, d.json || d, p2);
    const e = await serve(['notaport']);
    check('invalid port: exit 2', e.code === 2, e.code, 2);
    // --stop <port>: stops the server serve.mjs started there (pid record in the OS temp dir), one JSON line;
    // exit 1 when nothing was stopped, 2 on a bad port
    const f = await serve([]);
    if (f.child) kids.push(f.child);
    check('pid record written on start', f.json && f.json.pidFile && fs.existsSync(f.json.pidFile), f.json && f.json.pidFile, 'existing file');
    if (f.json) {
      // resolves the server's exit code (null = still running after 5 s)
      const exited = new Promise((r) => { if (f.child.exitCode != null) r(f.child.exitCode); else f.child.once('exit', (code) => r(code)); setTimeout(() => r(null), 5000); });
      const s1 = runStop([String(f.json.port)]);
      check('--stop <port>: exit 0, {stopped:true}', s1.code === 0 && s1.json && s1.json.stopped === true && s1.json.port === f.json.port, { code: s1.code, json: s1.json }, 'exit 0 + stopped');
      const code = await exited;
      check('--stop: the server process exited and the port is free', code !== null && (await get(f.json.url + '/')) === null, f.json.url, 'no answer');
      check('--stop: graceful, the server process exits 0', code === 0 && s1.json && s1.json.graceful === true, { exitCode: code, graceful: s1.json && s1.json.graceful }, { exitCode: 0, graceful: true });
      check('--stop: pid record removed', !fs.existsSync(f.json.pidFile), f.json.pidFile, 'gone');
      const s2 = runStop([String(f.json.port)]);
      check('--stop again: exit 1, {stopped:false}', s2.code === 1 && s2.json && s2.json.stopped === false, { code: s2.code, json: s2.json }, 'exit 1 + stopped:false');
    }
    const s3 = runStop(['notaport']);
    check('--stop invalid port: exit 2', s3.code === 2, s3.code, 2);
  } finally {
    for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
    // killed servers (no exit handler on Windows) leave their pid records: remove them
    for (const f of pidFiles) { try { if (JSON.parse(fs.readFileSync(f, 'utf8')).pid && kids.some((k) => k.pid === JSON.parse(fs.readFileSync(f, 'utf8')).pid)) fs.unlinkSync(f); } catch { /* gone */ } }
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(JSON.stringify({ ok: !failed.length, checks: results.length, failed }));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(`check-serve: ${e.message}`); process.exit(1); });
