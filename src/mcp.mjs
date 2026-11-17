import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { call, ensureDaemon } from './endpoint.mjs';

const BOARD_URI = 'ui://codex-swarm/board.html';
const MIME = 'text/html;profile=mcp-app';
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'codex-swarm', title: 'Codex Swarm', version: '0.1.0' };
const CAPABILITIES = {
  tools: {},
  resources: {},
  extensions: { 'openai/mentions': { searchTool: 'swarm_mentions' } },
};
const INSTRUCTIONS = 'Use swarm_start to delegate a requested task. Use swarm_board to present the live board. Direct user instructions to a named worker are private unless the user asks to post them publicly.';
const RUN_ID = { type: 'string', minLength: 1 };
const STRING = { type: 'string', minLength: 1 };
const RECIPIENTS = { anyOf: [STRING, { type: 'array', items: STRING, minItems: 1 }] };
const ACTIONS = ['pause', 'resume', 'stop', 'interrupt', 'change-model'];

function tool(name, title, description, properties, required, options = {}) {
  const { readOnly = false, destructive = false, meta } = options;
  return {
    name,
    title,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false },
    ...(meta ? { _meta: meta } : {}),
  };
}

const TOOLS = [
  tool('swarm_board', 'Swarm Board', 'Open the live Codex Swarm panel and return its local browser URL. Omit runId to show the run picker.', {
    runId: RUN_ID,
  }, [], {
    readOnly: true,
    meta: {
      ui: { resourceUri: BOARD_URI, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
    },
  }),
  tool('swarm_start', 'Start Swarm', 'Start a persistent Codex-only swarm for the user’s requested task in the given local project.', {
    goal: STRING, cwd: STRING, title: STRING,
    workers: { type: 'integer', minimum: 1, maximum: 6 },
    isolate: { type: 'boolean' }, model: STRING,
  }, ['goal', 'cwd']),
  tool('swarm_list', 'List Swarm Runs', 'List Swarm runs and their status.', {}, [], { readOnly: true }),
  tool('swarm_snapshot', 'Read Swarm Run', 'Read current members, board messages, and events for a run.', { runId: RUN_ID }, ['runId'], { readOnly: true }),
  tool('swarm_post', 'Send Swarm Message', 'Post to the board or send a private message. Address one or more worker names, @group, or @all. An idle recipient wakes in the same conversation.', {
    runId: RUN_ID, to: RECIPIENTS, text: STRING, private: { type: 'boolean' },
  }, ['runId', 'text']),
  tool('swarm_control', 'Control Swarm', 'Pause, resume, or stop a run, interrupt a member, or change a member’s model.', {
    runId: RUN_ID, action: { type: 'string', enum: ACTIONS }, memberId: STRING, model: STRING,
  }, ['runId', 'action'], { destructive: true }),
  tool('swarm_mentions', 'Find Swarm Members', 'Find named workers for the desktop composer’s mention picker.', {
    query: { type: 'string' },
  }, ['query'], {
    readOnly: true,
    meta: { ui: { visibility: ['app'] }, 'openai/extensions': { 'mentions/search': {} } },
  }),
];
const TOOL_MAP = new Map(TOOLS.map(definition => [definition.name, definition]));

function matches(spec, value) {
  if (spec.anyOf) return spec.anyOf.some(option => matches(option, value));
  if (spec.type === 'array') {
    return Array.isArray(value) && value.length >= spec.minItems && value.every(item => matches(spec.items, item));
  }
  if (spec.type === 'integer') {
    return Number.isInteger(value) && value >= spec.minimum && value <= spec.maximum;
  }
  return typeof value === spec.type
    && (!spec.minLength || Boolean(value.trim()))
    && (!spec.enum || spec.enum.includes(value));
}

function argsFor(name, args) {
  const schema = TOOL_MAP.get(name)?.inputSchema;
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an argument object.');
  for (const key of schema.required) {
    if (!(key in args)) throw new Error(`Missing ${key}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unexpected argument ${key}.`);
    if (!matches(schema.properties[key], value)) throw new Error(`Invalid ${key}.`);
  }
  return args;
}

function runPath(runId) {
  return `/api/runs/${encodeURIComponent(runId)}`;
}

function panelLink(runId) {
  const panel = new URL('codex://plugins/codex-swarm@codex-swarm/app/swarm_board');
  if (runId) panel.searchParams.set('path', `/?run=${encodeURIComponent(runId)}`);
  return panel.href;
}

async function browserLink(runId) {
  const url = new URL('/', await ensureDaemon());
  if (runId) url.searchParams.set('run', runId);
  return url.href;
}

function memberUri(runId, memberId) {
  return `codex-swarm://member/${encodeURIComponent(runId)}/${encodeURIComponent(memberId)}`;
}

function memberMention(run, member) {
  const handle = member.name ?? member.id;
  const runTitle = run.title || 'Swarm run';
  return {
    type: 'resource_link',
    uri: memberUri(run.id, member.id),
    name: handle,
    title: `@${handle} · ${runTitle}`,
    description: `Codex Swarm member ${handle} in ${runTitle}`,
    mimeType: 'application/json',
  };
}

async function findMentions(query) {
  const { runs } = await call('/api/runs');
  const current = runs.filter(run => !['stopped', 'cancelled'].includes(run.status)).slice(0, 8);
  const search = query.trim().replace(/^@/, '').toLowerCase();
  const snapshots = await Promise.allSettled(current.map(run => call(runPath(run.id))));
  const items = snapshots.flatMap(result => {
    if (result.status !== 'fulfilled') return [];
    const { run, members } = result.value;
    return members
      .filter(member => !['stopped', 'removed', 'retired'].includes(member.status)
        && `${member.name ?? member.id} ${member.role ?? ''} ${run.title ?? ''}`.toLowerCase().includes(search))
      .map(member => memberMention(run, member));
  });
  return { items: items.slice(0, 24) };
}

async function callTool(name, input) {
  const args = argsFor(name, input);
  const { runId, ...body } = args;
  switch (name) {
    case 'swarm_board':
      return { runId, url: await browserLink(runId), panelUrl: panelLink(runId) };
    case 'swarm_start': {
      const result = await call('/api/runs', { method: 'POST', body });
      return { ...result, panelUrl: panelLink(result.run.id) };
    }
    case 'swarm_list':
      return await call('/api/runs');
    case 'swarm_snapshot':
      return await call(runPath(runId));
    case 'swarm_post':
      return await call(`${runPath(runId)}/posts`, { method: 'POST', body });
    case 'swarm_control':
      return await call(`${runPath(runId)}/control`, { method: 'POST', body });
    case 'swarm_mentions':
      return await findMentions(args.query);
  }
}

async function boardHtml() {
  const [html, css, js] = await Promise.all(['index.html', 'board.css', 'board.js'].map(
    file => readFile(new URL(`../web/${file}`, import.meta.url), 'utf8'),
  ));
  const stylesheet = '<link rel="stylesheet" href="board.css">';
  const script = '<script src="board.js" defer></script>';
  if (!html.includes(stylesheet) || !html.includes(script) || !html.includes('</body>')) {
    throw new Error('Swarm board asset tags do not match the MCP panel.');
  }
  return html
    .replace(stylesheet, () => `<style>${css}</style>`)
    .replace(script, '')
    .replace('</body>', () => `<script>window.SWARM_MCP_PANEL = true;\n${js.replace(/<\/script/gi, '<\\/script')}</script></body>`);
}

async function readResource(uri) {
  if (uri === BOARD_URI) {
    return { contents: [{ uri, mimeType: MIME, text: await boardHtml(), _meta: { ui: { csp: {} } } }] };
  }
  const memberPattern = /^codex-swarm:\/\/member\/([^/]+)\/([^/]+)$/;
  const match = typeof uri === 'string' && uri.match(memberPattern);
  if (!match) throw Object.assign(new Error('No such resource.'), { code: -32002 });
  const [, encodedRun, encodedMember] = match;
  const runId = decodeURIComponent(encodedRun);
  const memberId = decodeURIComponent(encodedMember);
  const { run, members } = await call(runPath(runId));
  const member = members.find(current => current.id === memberId);
  if (!member) throw Object.assign(new Error('No such member.'), { code: -32002 });
  const details = { runId: run.id, run: run.title, memberId, handle: member.name ?? member.id, role: member.role, status: member.status };
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(details) }] };
}

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
        capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS,
      };
    case 'server/discover':
      return {
        supportedVersions: VERSIONS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        return {
          content: params.name === 'swarm_mentions' ? [] : [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    case 'resources/list':
      return { resources: [{ uri: BOARD_URI, name: 'Swarm Board', mimeType: MIME, _meta: { ui: { csp: {} } } }] };
    case 'resources/templates/list':
      return { resourceTemplates: [{ uriTemplate: 'codex-swarm://member/{runId}/{memberId}', name: 'Swarm member', mimeType: 'application/json' }] };
    case 'resources/read':
      return await readResource(params.uri);
    default:
      throw Object.assign(new Error(`Unknown MCP method: ${method}`), { code: -32601 });
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } });
    return;
  }
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    send({ id: request?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
    return;
  }
  if (!Object.hasOwn(request, 'id')) return;
  try {
    send({ id: request.id, result: await handle(request.method, request.params ?? {}) });
  } catch (error) {
    send({ id: request.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
