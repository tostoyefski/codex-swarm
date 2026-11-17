import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./server.mjs', import.meta.url));
const starting = new Map();

export async function daemonSettings() {
  const configured = resolve(process.env.CODEX_SWARM_HOME || join(homedir(), '.codex', 'codex-swarm'));
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const directory = await realpath(configured);
  const identity = createHash('sha256').update(`codex-swarm\0${directory}`).digest('hex');
  const port = Number(process.env.CODEX_SWARM_PORT || 15000 + Number.parseInt(identity.slice(0, 8), 16) % 30000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('CODEX_SWARM_PORT must be a port between 1024 and 65535.');
  }
  return { directory, identity, port, url: `http://127.0.0.1:${port}` };
}

async function probe({ url, identity }) {
  let response;
  try {
    response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(700),
      redirect: 'manual',
    });
  } catch {
    return 'unreachable';
  }
  try {
    const data = await response.json();
    if (data?.identity !== identity || data?.service !== 'codex-swarm') return 'occupied';
    return response.ok && data.ready === true ? 'ready' : 'starting';
  } catch {
    return 'occupied';
  }
}

async function startDaemon(settings) {
  const state = await probe(settings);
  if (state === 'ready') return settings.url;
  const { port, directory, url } = settings;
  if (state === 'occupied') {
    throw new Error(`Port ${port} is in use. Set CODEX_SWARM_PORT to a different loopback port.`);
  }

  const logPath = join(directory, 'server.log');
  let spawnError;
  if (state === 'unreachable') {
    const log = openSync(logPath, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [runner], {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, CODEX_SWARM_HOME: directory, CODEX_SWARM_PORT: String(port) },
      });
      child.once('error', error => { spawnError = error; });
      child.unref();
    } finally {
      closeSync(log);
    }
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not launch the Swarm daemon: ${spawnError.message}`);
    const next = await probe(settings);
    if (next === 'ready') return url;
    if (next === 'occupied') {
      throw new Error(`Port ${port} is in use. Set CODEX_SWARM_PORT to a different loopback port.`);
    }
    await delay(180);
  }
  throw new Error(`Swarm did not start at ${url}. See ${logPath} for details.`);
}

export async function ensureDaemon() {
  const settings = await daemonSettings();
  const key = `${settings.url}/${settings.identity}`;
  if (!starting.has(key)) {
    starting.set(key, startDaemon(settings).finally(() => starting.delete(key)));
  }
  return starting.get(key);
}

export async function call(path, { method = 'GET', body } = {}) {
  if (!/^\/api\/(?!\/)/.test(path)) throw new Error('Expected a Swarm API path.');
  const url = new URL(await ensureDaemon());
  const target = new URL(path, url);
  if (target.origin !== url.origin || !target.pathname.startsWith('/api/')) {
    throw new Error('Expected a local Swarm API path.');
  }
  const response = await fetch(target, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error || `Swarm request failed (${response.status}).`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}
