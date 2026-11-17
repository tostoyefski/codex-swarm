import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonSettings } from './endpoint.mjs';

const publicDirectory = fileURLToPath(new URL('../web/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css; charset=utf-8']],
  ['/board.js', ['board.js', 'text/javascript; charset=utf-8']],
]);
const bodyLimit = 65536;
const runRoute = /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(posts|control))?$/;

function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function respond(response, status, body, contentType, headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  response.end(body);
}

function json(response, status, payload) {
  respond(response, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

async function readBody(request, origin) {
  if (request.headers.origin && request.headers.origin !== origin) {
    throw problem(403, 'Swarm only accepts changes from its local dashboard.');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw problem(403, 'Cross-site changes are not allowed.');
  }
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw problem(415, 'Expected an application/json body.');
  }
  if (Number(request.headers['content-length']) > bodyLimit) {
    throw problem(413, 'Request body is too large.');
  }
  const chunks = [];
  let length = 0;
  // Leaving the iterator on oversized input must not destroy the socket before
  // the server can send the error response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > bodyLimit) {
      request.resume();
      throw problem(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body;
  } catch {
    // Report malformed JSON and unexpected top-level types the same way.
  }
  throw problem(400, 'Expected a JSON object.');
}

async function serveAsset(response, method, asset, webRoot) {
  const [file, contentType] = asset;
  const bytes = await readFile(join(webRoot, file));
  respond(response, 200, method === 'HEAD' ? undefined : bytes, contentType, {
    'Content-Length': bytes.length,
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}

async function route({ request, response, origin, identity, getScheduler, webRoot }) {
  if (request.headers.host !== new URL(origin).host) {
    throw problem(403, 'Use the loopback address shown by Swarm.');
  }
  const url = new URL(request.url, origin);
  if (url.origin !== origin) throw problem(403, 'Expected a local request.');
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/health') {
    const ready = Boolean(getScheduler());
    return json(response, ready ? 200 : 503, { identity, service: 'codex-swarm', ready, pid: process.pid });
  }
  if ((method === 'GET' || method === 'HEAD') && assets.has(path)) {
    return serveAsset(response, method, assets.get(path), webRoot);
  }

  const match = runRoute.exec(path);
  if (path !== '/api/runs' && !match) throw problem(404, 'Swarm endpoint not found.');
  const scheduler = getScheduler();
  if (!scheduler) throw problem(503, 'Swarm is starting.');
  if (path === '/api/runs') {
    if (method === 'GET') return json(response, 200, await scheduler.listRuns());
    if (method === 'POST') {
      const run = await scheduler.start(await readBody(request, origin));
      const dashboard = new URL('/', origin);
      dashboard.searchParams.set('run', run.id);
      return json(response, 201, { run, url: dashboard.href });
    }
  } else {
    const [, runId, action] = match;
    if (method === 'GET' && action === undefined) {
      const snapshot = await scheduler.snapshot(runId);
      if (!snapshot) throw problem(404, 'Swarm run not found.');
      return json(response, 200, snapshot);
    }
    if (method === 'POST' && action === 'posts') {
      const post = await scheduler.post(runId, await readBody(request, origin));
      return json(response, 201, { post });
    }
    if (method === 'POST' && action === 'control') {
      const run = await scheduler.control(runId, await readBody(request, origin));
      return json(response, 200, { run });
    }
  }
  throw problem(405, 'Method not allowed.');
}

export function createServer({ scheduler, getScheduler = () => scheduler, identity, webRoot = publicDirectory }) {
  const server = createHttpServer({ requestTimeout: 15000 }, (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    route({ request, response, origin, identity, getScheduler, webRoot }).catch(error => {
      if (response.headersSent || response.destroyed) return;
      const status = error.statusCode || 500;
      if (status === 500) console.error(error);
      json(response, status, { error: error.message || 'Swarm request failed.' });
    });
  });
  return server;
}

async function main() {
  const { directory, identity, port, url } = await daemonSettings();
  let scheduler;
  const server = createServer({ getScheduler: () => scheduler, identity });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const { SwarmScheduler } = await import('./scheduler.mjs');
    scheduler = new SwarmScheduler({ directory });
  } catch (error) {
    server.close();
    throw error;
  }
  console.log(`Swarm listening at ${url}`);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    try {
      await scheduler.stop();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
