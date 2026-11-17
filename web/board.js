'use strict';

const element = (id) => document.getElementById(id);
const inPanel = Boolean(window.SWARM_MCP_PANEL) || window.parent !== window;
const initialRun = new URLSearchParams(window.location.search).get('run');
const state = {
  runId: initialRun || null, fixedRun: Boolean(initialRun), pendingRun: null,
  runs: [], snapshot: null, tab: 'board', listAt: 0, reading: false,
  waitingRefresh: false, rendering: false, scroll: true, feedKey: '', memberKey: '',
  filterOptionsKey: '', listKey: '', sending: false, graphKey: '',
  privateKey: '', privateSending: false, controlBusy: false, confirmStop: false,
  replay: null, timer: null, choices: [], choiceIndex: 0, mentionMatch: null,
};

const dateTime = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const statusNames = {
  idle: 'Waiting', queued: 'Queued', running: 'Active', working: 'Active',
  waiting: 'Waiting', paused: 'Paused', stopped: 'Stopped', failed: 'Failed',
  planning: 'Planning', active: 'Active', integrating: 'Integrating', verifying: 'Verifying',
  complete: 'Complete', completed: 'Complete', done: 'Done', canceled: 'Canceled',
  cancelled: 'Canceled', blocked: 'Blocked', initializing: 'Starting',
};
const rank = {running: 0, working: 0, queued: 1, idle: 2, waiting: 2, paused: 3, failed: 4, stopped: 5};
const vars = new Set(['--color-background-primary', '--color-background-secondary',
  '--color-text-primary', '--color-text-secondary', '--color-border-primary']);
const tabNames = ['board', 'members', 'graph', 'private'];

function make(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = content;
  return node;
}

function timestamp(value) {
  if (!value) return null;
  const date = new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function titleCase(value) {
  if (!value) return 'Unknown';
  return value[0].toUpperCase() + value.slice(1).replaceAll(/[_-]/g, ' ');
}

function statusLabel(value) {
  return statusNames[value] || titleCase(value);
}

function statusClass(value) {
  if (['active', 'working', 'running', 'planning', 'integrating', 'verifying'].includes(value)) return 'status-active';
  if (['idle', 'waiting', 'paused', 'queued', 'blocked'].includes(value)) return 'status-wait';
  if (['failed', 'error'].includes(value)) return 'status-error';
  return '';
}

function toArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function isAddressable(item) {
  return item.role !== 'monitor' && !['stopped', 'killed'].includes(item.status);
}

function member(value) {
  const ref = String(value || '').replace(/^@/, '').toLowerCase();
  return state.snapshot?.members.find((item) => item.id.toLowerCase() === ref || item.name.toLowerCase() === ref);
}

function display(value) {
  if (value === 'you') return 'You';
  if (value === 'system') return 'System';
  return member(value)?.name || String(value || 'unknown').replace(/^@/, '');
}

function address(value) {
  return '@' + display(value);
}

function parseToolResult(result) {
  const dict = result?.structuredContent;
  if (result?.isError) {
    throw new Error(dict?.error || result.content?.find((piece) => piece.type === 'text')?.text || 'The panel tool failed.');
  }
  if (dict && typeof dict === 'object') return dict;
  const text = result?.content?.find((piece) => piece.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
}

function applyHostContext(context) {
  const style = document.documentElement.style;
  if (['light', 'dark'].includes(context?.theme)) style.colorScheme = context.theme;
  for (const [name, value] of Object.entries(context?.styles?.variables || {})) {
    if (vars.has(name) && typeof value === 'string' && CSS.supports('color', value)) style.setProperty(name, value);
  }
  const link = context?.['openai/deepLink']?.url;
  if (typeof link === 'string') {
    try {
      receiveRun(new URL(link, window.location.href).searchParams.get('run'));
    } catch { /* The host may not provide a URL. */ }
  }
}

function receiveRun(runId) {
  if (typeof runId !== 'string' || !runId || runId === state.runId) return;
  state.pendingRun = runId;
  state.fixedRun = true;
  void refresh();
}

function panelTransport() {
  let next = 0;
  let connected;
  const outstanding = new Map();
  const prefix = 'swarm-' + Math.random().toString(36).slice(2) + '-';

  function notify(method, params = {}) {
    window.parent.postMessage({jsonrpc: '2.0', method, params}, '*');
  }

  function request(method, params) {
    const id = prefix + ++next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        outstanding.delete(id);
        reject(new Error('The Codex panel did not respond. Open the local board link to continue.'));
      }, 12000);
      outstanding.set(id, {timeout, resolve, reject});
      window.parent.postMessage({jsonrpc: '2.0', id, method, params}, '*');
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
    if (outstanding.has(message.id)) {
      const pending = outstanding.get(message.id);
      outstanding.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || 'Panel request failed.'));
      else pending.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') {
      try {
        const result = parseToolResult(message.params);
        receiveRun(result.runId || result.run?.id);
      } catch (error) {
        setConnection('offline', error.message);
      }
    } else if (message.method === 'ui/notifications/tool-input') {
      receiveRun(message.params?.arguments?.runId);
    } else if (message.method === 'ui/notifications/host-context-changed') {
      applyHostContext(message.params);
    } else if (message.method === 'ping' && message.id !== undefined) {
      window.parent.postMessage({jsonrpc: '2.0', id: message.id, result: {}}, '*');
    }
  });

  function connect() {
    if (!connected) {
      connected = request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: {name: 'Swarm Board', version: '1.0.0'},
        appCapabilities: {availableDisplayModes: ['inline', 'fullscreen']},
      }).then((result) => {
        applyHostContext(result.hostContext);
        notify('ui/notifications/initialized');
        if (!result.hostContext?.containerDimensions?.height) {
          notify('ui/notifications/size-changed', {width: document.documentElement.clientWidth, height: 660});
        }
      }).catch((err) => {
        connected = undefined;
        throw err;
      });
    }
    return connected;
  }

  return {
    async call(name, args) {
      await connect();
      return parseToolResult(await request('tools/call', {name, arguments: args}));
    },
    async open(url) {
      await connect();
      return request('ui/open-link', {url});
    },
  };
}

async function fetchJSON(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  } : {cache: 'no-store'});
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The local Swarm service returned an invalid response.');
  }
  if (!response.ok || result.error) throw new Error(result.error?.message || result.error || response.statusText);
  return result;
}

const panel = inPanel ? panelTransport() : null;
const api = {
  list: () => panel ? panel.call('swarm_list', {}) : fetchJSON('/api/runs'),
  snapshot: (runId) => inPanel
    ? panel.call('swarm_snapshot', {runId})
    : fetchJSON('/api/runs/' + encodeURIComponent(runId)),
  post: (runId, body) => inPanel
    ? panel.call('swarm_post', {runId, ...body})
    : fetchJSON('/api/runs/' + encodeURIComponent(runId) + '/posts', body),
  control: (runId, action) => inPanel
    ? panel.call('swarm_control', {runId, action})
    : fetchJSON('/api/runs/' + encodeURIComponent(runId) + '/control', {action}),
};

function setConnection(status, message) {
  element('connection').dataset.state = status;
  element('connection-label').textContent = {live: 'Live', connecting: 'Connecting', offline: 'Reconnecting'}[status];
  element('connection-error').hidden = !message;
  element('connection-error').textContent = message || '';
}

function posts() {
  return (state.snapshot?.posts || []).filter((entry) => !entry.private);
}

function selectRun(runId) {
  if (runId === state.runId) return;
  stopReplay();
  Object.assign(state, {runId, snapshot: null, replay: null, feedKey: '', memberKey: '', graphKey: '', privateKey: '', filterOptionsKey: '', scroll: true, confirmStop: false});
  element('follow').checked = true;
  element('message').value = '';
  element('send-error').hidden = true;
  element('private-message').value = '';
  element('private-target').value = '';
  element('private-send-error').hidden = true;
  element('run-control-error').hidden = true;
  closeSuggestions();
  if (!inPanel && runId) {
    const location = new URL(window.location.href);
    location.searchParams.set('run', runId);
    history.replaceState(null, '', location);
  }
}

function setOptions(select, options, preserve = true) {
  const value = select.value;
  select.replaceChildren(...options.map(([key, label]) => new Option(label, key)));
  if (preserve && options.some(([key]) => key === value)) select.value = value;
}

function renderRunPicker() {
  const options = state.runs.map((run) => [run.id, (run.title || run.goal || run.id).slice(0, 120)]);
  const snapshot = state.snapshot?.run;
  if (snapshot && !options.some(([id]) => id === snapshot.id)) options.unshift([snapshot.id, snapshot.title || snapshot.id]);
  const key = JSON.stringify(options);
  if (key !== state.listKey) {
    state.listKey = key;
    setOptions(element('run-picker'), options, false);
  }
  element('run-picker').hidden = options.length < 2;
  if (options.some(([id]) => id === state.runId)) element('run-picker').value = state.runId;
}

function ensureRun(next) {
  if (next) return next;
  if (state.fixedRun && state.runId) return state.runId;
  const active = state.runs.find((run) => ['active', 'planning', 'running', 'integrating', 'verifying', 'queued'].includes(run.status));
  return state.runId || active?.id || state.runs[0]?.id || null;
}

async function refresh() {
  if (state.reading) {
    state.waitingRefresh = true;
    return;
  }
  state.reading = true;
  try {
    if (!state.listAt || Date.now() - state.listAt > 7500) {
      const result = await api.list();
      state.runs = result.runs || [];
      state.listAt = Date.now();
    }
    const runId = ensureRun(state.pendingRun);
    state.pendingRun = null;
    selectRun(runId);
    if (runId) {
      const result = await api.snapshot(runId);
      if (!result.run) throw new Error('This swarm run is unavailable.');
      if (state.runId === runId) {
        const entries = (result.posts || []).slice().sort((a, b) => a.seq - b.seq);
        state.snapshot = {
          run: result.run,
          members: result.members || [],
          posts: entries,
          publicSeqs: new Set(entries.filter((post) => !post.private).map((post) => post.seq)),
          events: result.events || [],
        };
      }
    }
    render();
    setConnection('live');
  } catch (error) {
    render();
    setConnection('offline', error.message || String(error));
  } finally {
    state.reading = false;
    if (state.waitingRefresh) {
      state.waitingRefresh = false;
      void refresh();
    }
  }
}

function render() {
  const ready = Boolean(state.snapshot?.run);
  element('waiting').hidden = ready;
  element('run-header').hidden = !ready;
  element('tabbar').hidden = !ready;
  for (const tab of tabNames) element('view-' + tab).hidden = !ready || tab !== state.tab;
  if (!ready) {
    element('waiting-title').textContent = state.runId ? 'Opening swarm…' : 'No swarm yet';
    return;
  }
  const {run, members} = state.snapshot;
  element('run-title').textContent = run.title || run.goal || 'Swarm';
  element('run-state').textContent = statusLabel(run.status);
  const active = members.filter((item) => statusClass(item.status) === 'status-active').length;
  const waiting = members.filter((item) => ['idle', 'waiting', 'queued'].includes(item.status)).length;
  element('run-summary').textContent = active + ' active · ' + waiting + ' waiting';
  if (run.cwd) {
    const path = element('run-path');
    path.textContent = run.cwd.split('/').filter(Boolean).at(-1) || run.cwd;
    path.title = run.cwd;
  } else element('run-path').textContent = '';
  element('post-count').textContent = posts().length;
  element('member-count').textContent = members.length;
  renderRunPicker();
  renderOptions();
  renderControls();
  updateSendState();
  if (state.tab === 'board') renderFeed();
  if (state.tab === 'members') renderMembers();
  if (state.tab === 'graph') renderGraph();
  if (state.tab === 'private') renderPrivate();
}

function renderOptions() {
  const members = state.snapshot.members;
  const labels = members.map((item) => [item.id, address(item.id)]);
  const topical = [...new Set(members.map((entry) => entry.role).filter(Boolean))]
    .filter((role) => !members.some((entry) => entry.name.toLowerCase() === role.toLowerCase()))
    .map((role) => [role, '@' + role]);
  const key = JSON.stringify([labels, topical, members.map((item) => item.status)]);
  if (key === state.filterOptionsKey) return;
  state.filterOptionsKey = key;
  setOptions(element('sender-filter'), [['', 'All senders'], ['you', 'You'], ['system', 'System'], ...labels]);
  setOptions(element('recipient-filter'), [['', 'All recipients'], ['all', '@all'], ...labels, ...topical]);
  const available = members.filter((item) => isAddressable(item) || privatePosts(item.id).length > 0);
  const select = element('private-target');
  setOptions(select, [['', 'Choose member'], ...available.map((item) => [item.id, address(item.id)])]);
  if (!select.value && available.length === 1) select.value = available[0].id;
}

function renderControls() {
  const status = state.snapshot?.run.status;
  const canControl = status === 'running' || status === 'paused';
  if (!canControl) state.confirmStop = false;
  element('run-controls').hidden = !canControl;
  element('run-actions').hidden = state.confirmStop;
  element('confirm-stop').hidden = !state.confirmStop;
  element('pause-resume').textContent = status === 'paused' ? 'Resume' : 'Pause';
  for (const id of ['pause-resume', 'stop-run', 'confirm-stop-run', 'cancel-stop']) {
    element(id).disabled = state.controlBusy;
  }
}

async function controlRun(action) {
  if (state.controlBusy || !state.runId) return;
  const runId = state.runId;
  const errorBox = element('run-control-error');
  errorBox.hidden = true;
  state.controlBusy = true;
  renderControls();
  try {
    const {run} = await api.control(runId, action);
    if (run && state.runId === runId && state.snapshot?.run.id === run.id) {
      state.snapshot.run = run;
      state.confirmStop = false;
      render();
    }
    await refresh();
  } catch (error) {
    if (state.runId === runId) {
      errorBox.textContent = error.message || String(error);
      errorBox.hidden = false;
    }
  } finally {
    state.controlBusy = false;
    renderControls();
  }
}

function addMentions(target, value, followReferences = true) {
  const source = String(value || '');
  const matcher = /(?<![\w@])@[\p{L}\p{N}_-]+|(?<![\w#])#(\d+)\b/gu;
  let last = 0;
  for (const token of source.matchAll(matcher)) {
    target.append(document.createTextNode(source.slice(last, token.index)));
    if (token[0][0] === '@') {
      target.append(make('span', 'mention', token[0]));
    } else if (followReferences && state.snapshot?.publicSeqs.has(Number(token[1]))) {
      const button = make('button', 'reference', token[0]);
      button.type = 'button';
      button.title = 'Open board post ' + token[0];
      button.addEventListener('click', () => openReference(Number(token[1])));
      target.append(button);
    } else {
      target.append(document.createTextNode(token[0]));
    }
    last = token.index + token[0].length;
  }
  target.append(document.createTextNode(source.slice(last)));
}

function renderPost(post, showId = true) {
  const article = make('article', 'post');
  article.dataset.seq = post.seq;
  const head = make('header', 'post-heading');
  const from = display(post.from);
  head.append(make('span', 'author', ['You', 'System'].includes(from) ? from : '@' + from));
  const recipients = toArray(post.to);
  if (recipients.length) head.append(make('span', 'recipient', '→ ' + recipients.map(address).join(', ')));
  if (showId) head.append(make('span', 'post-id', '#' + post.seq));
  const date = timestamp(post.at);
  if (date) {
    const time = make('time', 'post-time', dateTime.format(date));
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
    head.append(time);
  }
  const text = make('p', 'post-body');
  addMentions(text, post.text, showId);
  article.append(head, text);
  return article;
}

function privatePosts(memberId) {
  if (!memberId) return [];
  return (state.snapshot?.posts || []).filter((entry) => {
    if (!entry.private) return false;
    const recipients = toArray(entry.to);
    if (entry.from === 'you') return recipients.includes(memberId);
    return entry.from === memberId && (recipients.includes('you') || recipients.length === 0);
  });
}

function renderPrivate() {
  const recipient = element('private-target').value;
  const entries = privatePosts(recipient);
  const key = JSON.stringify([state.runId, recipient, entries.length, entries.at(-1)?.seq]);
  if (key === state.privateKey) return;
  const feed = element('private-feed');
  const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 24;
  const oldScroll = feed.scrollTop;
  const previous = state.privateKey ? JSON.parse(state.privateKey)[1] : null;
  state.privateKey = key;
  if (!entries.length) {
    feed.replaceChildren(make('p', 'empty', recipient ? 'No private messages with ' + address(recipient) + '.' : 'Choose a member to open a private conversation.'));
  } else {
    feed.replaceChildren(...entries.map((post) => renderPost(post, false)));
  }
  feed.scrollTop = wasAtBottom || previous !== recipient ? feed.scrollHeight : oldScroll;
}

function showPrivate(memberId) {
  selectTab('private');
  if (memberId) element('private-target').value = memberId;
  renderPrivate();
  updateSendState();
  element('private-message').focus();
}

function matchesRecipient(post, value) {
  if (!value) return true;
  const wanted = display(value).toLowerCase();
  const mentioned = toArray(post.to).some((to) => display(to).toLowerCase() === wanted || String(to).toLowerCase() === String(value).toLowerCase());
  if (mentioned) return true;
  const names = [...String(post.text || '').matchAll(/(?<![\w@])@([\p{L}\p{N}_-]+)/gu)].map((item) => item[1].toLowerCase());
  return names.includes(wanted) || (wanted !== 'all' && names.includes('all'));
}

function renderFeed() {
  const feed = element('feed');
  const query = element('post-search').value.trim().toLowerCase();
  const from = element('sender-filter').value;
  const to = element('recipient-filter').value;
  const all = posts();
  const {run, members} = state.snapshot;
  const key = JSON.stringify([state.runId, query, from, to, all.length, all.at(-1)?.seq, run.status, run.final, run.lastError, run.integration, members.map((item) => [item.id, item.name])]);
  if (key === state.feedKey) return;
  state.feedKey = key;
  const currentScroll = feed.scrollTop;
  const included = all.filter((post) => {
    if (from && post.from !== from && display(post.from).toLowerCase() !== display(from).toLowerCase()) return false;
    if (!matchesRecipient(post, to)) return false;
    return !query || [post.text, display(post.from), ...toArray(post.to).map(display)].some((value) => String(value || '').toLowerCase().includes(query));
  });
  const children = included.length
    ? included.map((post) => renderPost(post))
    : [make('p', 'empty', all.length ? 'No messages match.' : 'No board messages yet.')];
  const outcome = !query && !from && !to && renderOutcome(run);
  if (outcome) children.push(outcome);
  feed.replaceChildren(...children);
  state.rendering = true;
  if (state.scroll || included.length === 0) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = currentScroll;
  requestAnimationFrame(() => {
    state.rendering = false;
    renderLatestButton();
  });
}

function renderOutcome(run) {
  const result = typeof run.final === 'string' ? run.final : run.final?.summary || run.final?.text;
  const error = typeof run.lastError === 'string' ? run.lastError : run.lastError?.message;
  const directory = typeof run.integration === 'string' ? run.integration : run.integration?.path || run.integration?.cwd;
  if (!result && !error && !directory) return null;
  const card = make('aside', 'result');
  card.append(make('strong', '', result ? 'Result' : error ? 'Attention needed' : 'Integration worktree'));
  if (result) card.append(make('p', '', result));
  if (error) card.append(make('p', 'inline-error', error));
  if (directory) {
    const line = make('p');
    line.append(make('code', '', directory));
    card.append(line);
  }
  return card;
}

function nearBottom() {
  const feed = element('feed');
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 24;
}

function renderLatestButton() {
  element('jump-latest').hidden = nearBottom();
}

function goLatest() {
  state.scroll = true;
  element('follow').checked = true;
  const feed = element('feed');
  feed.scrollTop = feed.scrollHeight;
  renderLatestButton();
}

function openReference(seq) {
  selectTab('board');
  element('post-search').value = '';
  element('sender-filter').value = '';
  element('recipient-filter').value = '';
  state.scroll = false;
  element('follow').checked = false;
  renderFeed();
  const article = element('feed').querySelector('[data-seq="' + seq + '"]');
  if (article) {
    article.scrollIntoView({block: 'center', behavior: 'smooth'});
    article.classList.add('referred');
    setTimeout(() => article.classList.remove('referred'), 1300);
  }
}

function memberHistory(id) {
  return state.snapshot.events.filter((event) => {
    if (event.memberId !== id || event.private || event.data?.private) return false;
    return !/^post[./:_-]|(?:delta|private)/.test(event.kind);
  }).slice(-10);
}

function describeEvent(event) {
  const data = event.data;
  const detail = typeof data === 'string' ? data : data?.message || data?.error?.message || data?.text || data?.status;
  return titleCase(event.kind) + (typeof detail === 'string' ? ' · ' + detail.slice(0, 460) : '');
}

function threadLink(item) {
  const threadId = item.threadId;
  if (typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) return null;
  const link = make('a', 'button compact', 'Open chat');
  const href = 'codex://threads/' + threadId;
  link.href = href;
  link.setAttribute('aria-label', 'Open ' + address(item.id) + ' in Codex');
  if (panel) link.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await panel.open(href);
    } catch {
      const fallback = make('code', '', href);
      fallback.title = 'Open this link in Codex';
      link.replaceWith(fallback);
    }
  });
  return link;
}

function renderMembers() {
  const {members, events} = state.snapshot;
  const needle = element('member-search').value.trim().toLowerCase();
  const key = JSON.stringify([state.runId, needle, members, events.length, events.at(-1)?.seq, posts().at(-1)?.seq]);
  if (key === state.memberKey) return;
  state.memberKey = key;
  const wrap = element('member-list');
  const lastScroll = wrap.scrollTop;
  const shown = members.filter((item) => [item.name, item.role, item.model, item.task, statusLabel(item.status)]
    .some((value) => String(value || '').toLowerCase().includes(needle)))
    .slice().sort((a, b) => (rank[a.status] ?? 6) - (rank[b.status] ?? 6) || a.name.localeCompare(b.name));
  const openNames = new Set(Array.from(wrap.querySelectorAll('details[open]'), (item) => item.dataset.member));
  wrap.replaceChildren();
  if (!shown.length) wrap.append(make('p', 'empty', needle ? 'No members match.' : 'No members yet.'));
  const totals = new Map();
  for (const entry of posts()) totals.set(entry.from, (totals.get(entry.from) || 0) + 1);
  for (const item of shown) {
    const card = make('article', 'member');
    const heading = make('header', 'member-heading');
    heading.append(make('strong', '', '@' + item.name));
    const chip = make('span', 'member-state ' + statusClass(item.status));
    chip.append(make('span', 'status-dot'), make('span', '', statusLabel(item.status)));
    heading.append(chip);
    const controls = make('div', 'member-actions');
    const link = threadLink(item);
    if (link) controls.append(link);
    if (isAddressable(item) || privatePosts(item.id).length) {
      const button = make('button', 'button compact', 'Private');
      button.type = 'button';
      button.addEventListener('click', () => showPrivate(item.id));
      controls.append(button);
    }
    if (controls.childNodes.length) heading.append(controls);
    const meta = make('div', 'member-meta');
    if (item.role) meta.append(make('span', 'pill', titleCase(item.role)));
    if (item.model) meta.append(make('span', 'member-model', item.model));
    const count = totals.get(item.id) || 0;
    meta.append(make('span', '', count + (count === 1 ? ' post' : ' posts')));
    card.append(heading, meta);
    if (item.task) card.append(make('p', 'member-activity', item.task));
    if (item.activity && item.activity !== item.task) card.append(make('p', 'member-activity', item.activity));
    if (item.lastError) card.append(make('p', 'inline-error', item.lastError.message || String(item.lastError)));
    const activity = memberHistory(item.id);
    if (activity.length) {
      const detail = make('details', 'member-events');
      detail.dataset.member = item.id;
      detail.open = openNames.has(item.id);
      const list = make('ol');
      for (const entry of activity) list.append(make('li', '', describeEvent(entry)));
      detail.append(make('summary', '', 'Recent activity'), list);
      card.append(detail);
    }
    wrap.append(card);
  }
  wrap.scrollTop = lastScroll;
}

function svgNode(tag, attrs = {}, value) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, property] of Object.entries(attrs)) node.setAttribute(name, String(property));
  if (value !== undefined) node.textContent = value;
  return node;
}

function graphPeople(entries) {
  const people = new Map(state.snapshot.members.map((item) => [item.id, item]));
  for (const post of entries) {
    if (!people.has(post.from) && post.from !== 'system') {
      const known = member(post.from);
      if (!known && post.from) people.set(post.from, {id: post.from, name: display(post.from), status: 'unknown'});
    }
  }
  return [...people.values()].slice().sort((a, b) => {
    if (a.role === 'coordinator' && b.role !== 'coordinator') return -1;
    if (a.role !== 'coordinator' && b.role === 'coordinator') return 1;
    return a.name.localeCompare(b.name);
  });
}

function graphLinks(visible, people) {
  const ids = new Set(people.map((person) => person.id));
  const links = new Map();
  const active = new Set();
  const broadcasts = new Map();
  const expand = element('expand-all')?.checked;
  for (const post of visible) {
    const from = member(post.from)?.id || post.from;
    const labels = [...String(post.text || '').matchAll(/(?<![\w@])@([\p{L}\p{N}_-]+)/gu)].map((item) => item[1]);
    const targets = toArray(post.to);
    const all = [...labels, ...targets].some((name) => String(name).toLowerCase().replace(/^@/, '') === 'all');
    if (all) broadcasts.set(from, (broadcasts.get(from) || 0) + 1);
    const addressable = new Map();
    const forms = targets.length ? targets : labels;
    if (all && expand) {
      const candidates = targets.filter((id) => ids.has(id));
      for (const id of candidates.length ? candidates : ids) if (id !== from && id !== 'you') addressable.set(id, true);
    } else if (!all) {
      for (const label of forms) {
        const direct = member(label);
        if (direct?.id && direct.id !== from) addressable.set(direct.id, false);
        else for (const person of people) {
          const key = String(label).toLowerCase().replace(/^@/, '');
          if (person.id !== from && (person.role?.toLowerCase() === key || person.name.toLowerCase().startsWith(key + '-'))) addressable.set(person.id, false);
        }
      }
    }
    active.add(from);
    for (const [id, viaAll] of addressable) {
      active.add(id);
      const key = JSON.stringify([from, id]);
      const previous = links.get(key);
      links.set(key, {from, to: id, count: (previous?.count || 0) + 1, viaAll: viaAll && (previous?.viaAll ?? true)});
    }
  }
  return {links, active, broadcasts};
}

function ellipsePositions(people, width, height) {
  const positions = new Map();
  const center = people.find((item) => item.role === 'coordinator');
  const others = people.filter((item) => item !== center);
  if (center) positions.set(center.id, {x: width / 2, y: height / 2});
  if (!others.length) return positions;
  if (others.length === 1) {
    positions.set(others[0].id, center ? {x: width / 2, y: height / 5} : {x: width / 2, y: height / 2});
    return positions;
  }
  for (const [index, person] of others.entries()) {
    const angle = index * 2 * Math.PI / others.length - Math.PI / 2;
    positions.set(person.id, {
      x: width / 2 + Math.cos(angle) * (width / 2 - 80),
      y: height / 2 + Math.sin(angle) * (height / 2 - 36),
    });
  }
  return positions;
}

function graphLink(svg, from, to, link) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const boundary = (node) => Math.min(node.halfWidth / Math.abs(ux), 20 / Math.abs(uy), distance * .42);
  const start = boundary(from);
  const end = boundary(to) + 2;
  const sx = from.x + ux * start;
  const sy = from.y + uy * start;
  const tx = to.x - ux * end;
  const ty = to.y - uy * end;
  const mx = (sx + tx) / 2 - uy * 18;
  const my = (sy + ty) / 2 + ux * 18;
  const edge = svgNode('path', {
    d: 'M ' + sx + ' ' + sy + ' Q ' + mx + ' ' + my + ' ' + tx + ' ' + ty,
    class: 'graph-edge' + (link.viaAll ? ' broadcast' : ''),
    'stroke-width': Math.min(4.6, 1 + Math.log2(link.count + 1)),
    'marker-end': 'url(#arrowhead)',
  });
  edge.append(svgNode('title', {}, address(link.from) + ' → ' + address(link.to) + ' · ' + link.count + ' mentions'));
  svg.append(edge, svgNode('text', {x: mx, y: my, class: 'graph-edge-count'}, link.count));
}

function renderGraph() {
  const entries = posts();
  const index = state.replay === null ? entries.length : Math.min(entries.length, state.replay);
  const range = element('replay-position');
  range.max = entries.length;
  range.value = index;
  range.disabled = entries.length === 0;
  element('replay-count').textContent = index + ' / ' + entries.length;
  element('step-back').disabled = index === 0;
  element('step-forward').disabled = index === entries.length;
  element('playback').disabled = entries.length === 0;
  element('playback').textContent = state.timer ? 'Pause' : 'Play';
  element('live-graph').setAttribute('aria-pressed', String(state.replay === null));
  const key = JSON.stringify([state.runId, state.replay, entries.length, entries.at(-1)?.seq, element('expand-all').checked, state.snapshot.members.map((item) => [item.id, item.name, item.role, item.status])]);
  if (key === state.graphKey) return;
  state.graphKey = key;
  const visible = entries.slice(0, index);
  const people = graphPeople(entries);
  const {links, active, broadcasts} = graphLinks(visible, people);
  const canvas = element('graph');
  canvas.replaceChildren();
  if (people.length) {
    const width = Math.max(380, people.length > 8 ? 520 : 480);
    const height = Math.max(240, Math.min(450, 155 + people.length * 19));
    const graph = svgNode('svg', {viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Directed mentions between swarm members'});
    const defs = svgNode('defs');
    const arrow = svgNode('marker', {id: 'arrowhead', markerWidth: 6, markerHeight: 5, refX: 5, refY: 2.5, orient: 'auto'});
    arrow.append(svgNode('path', {d: 'M0 0 L6 2.5 L0 5 Z', class: 'graph-arrow'}));
    defs.append(arrow);
    graph.append(defs);
    const positions = ellipsePositions(people, width, height);
    for (const person of people) {
      const position = positions.get(person.id);
      position.label = person.name.length > 17 ? person.name.slice(0, 15) + '…' : person.name;
      position.halfWidth = Math.max(90, Math.min(155, 38 + position.label.length * 6.2)) / 2;
    }
    for (const link of links.values()) {
      const to = positions.get(link.to);
      const from = positions.get(link.from);
      if (from && to) graphLink(graph, from, to, link);
    }
    for (const person of people) {
      const {x, y, label, halfWidth} = positions.get(person.id);
      const inactive = state.replay !== null && !active.has(person.id);
      const node = svgNode('g', {class: ['graph-node', state.replay === null ? statusClass(person.status) : '', inactive ? 'inactive' : ''].join(' ')});
      const badge = broadcasts.get(person.id);
      const nodeText = svgNode('text', {x: x - halfWidth + 23, y: y + 1}, label);
      const subtitle = person.id === 'you' ? 'Human' : state.replay === null ? statusLabel(person.status) : titleCase(person.role);
      node.append(
        svgNode('title', {}, address(person.id) + ' · ' + subtitle + (badge ? ' · @all ' + badge : '')),
        svgNode('rect', {x: x - halfWidth, y: y - 19, width: halfWidth * 2, height: 39, rx: 10}),
        svgNode('circle', {cx: x - halfWidth + 13, cy: y - 3, r: 3.4, class: 'graph-dot'}),
        nodeText,
        svgNode('text', {x: x - halfWidth + 23, y: y + 13, class: 'node-status'}, subtitle + (badge ? ' · @all ' + badge : '')),
      );
      graph.append(node);
    }
    canvas.append(graph);
  } else {
    canvas.append(make('p', 'empty', 'The mention graph appears when members join.'));
  }
  element('graph-caption').textContent = links.size ? 'Arrow weight shows mention count.' : 'No member-to-member mentions at this point.';
  const output = element('replay-message');
  output.replaceChildren();
  if (visible.length) output.append(renderPost(visible.at(-1)));
}

function stopReplay() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function seek(position) {
  stopReplay();
  state.replay = Math.max(0, Math.min(position, posts().length));
  renderGraph();
}

function playReplay() {
  if (state.timer) {
    stopReplay();
    renderGraph();
    return;
  }
  const count = posts().length;
  if (!count) return;
  if (state.replay === null || state.replay >= count) state.replay = 0;
  const rate = parseFloat(element('playback-speed').value) || 1;
  state.timer = setInterval(() => {
    state.replay = Math.min(posts().length, state.replay + 1);
    if (state.replay >= posts().length) stopReplay();
    renderGraph();
  }, 680 / rate);
  renderGraph();
}

function selectTab(id, focus = false) {
  if (!tabNames.includes(id)) return;
  if (id !== 'graph') stopReplay();
  state.tab = id;
  for (const name of tabNames) {
    const tab = element('tab-' + name);
    tab.setAttribute('aria-selected', String(id === name));
    tab.tabIndex = id === name ? 0 : -1;
  }
  if (id === 'board') state.feedKey = '';
  render();
  if (focus) element('tab-' + id).focus();
}

function closeSuggestions() {
  element('suggestions').hidden = true;
  state.mentionMatch = null;
  state.choices = [];
  state.choiceIndex = 0;
  element('message').removeAttribute('aria-activedescendant');
}

function updateSuggestions() {
  const input = element('message');
  if (!state.snapshot || document.activeElement !== input) {
    closeSuggestions();
    return;
  }
  const part = input.value.slice(0, input.selectionStart);
  const match = /(?:^|[^\w@])@([\p{L}\p{N}_-]*)$/u.exec(part);
  if (!match) {
    closeSuggestions();
    return;
  }
  const q = match[1].toLowerCase();
  const options = new Map([['all', 'Everyone']]);
  for (const item of state.snapshot.members) {
    if (!isAddressable(item)) continue;
    options.set(item.name, statusLabel(item.status));
    const group = item.name.match(/^(.+)-\d+$/)?.[1];
    if (group && !options.has(group)) options.set(group, 'Group');
    if (item.role && !options.has(item.role)) options.set(item.role, 'Group');
  }
  state.choices = [...options].filter(([name]) => name.toLowerCase().startsWith(q)).slice(0, 10);
  if (!state.choices.length) {
    closeSuggestions();
    return;
  }
  state.mentionMatch = {start: part.length - q.length - 1, end: input.selectionStart};
  state.choiceIndex = 0;
  renderSuggestions();
}

function renderSuggestions() {
  const panel = element('suggestions');
  panel.replaceChildren(...state.choices.map(([name, description], index) => {
    const row = make('button', '');
    row.type = 'button';
    row.id = 'mention-choice-' + index;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === state.choiceIndex));
    row.append(make('span', 'mention', '@' + name), make('span', 'recipient', description));
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => insertMention(name));
    return row;
  }));
  panel.hidden = false;
  element('message').setAttribute('aria-activedescendant', 'mention-choice-' + state.choiceIndex);
}

function insertMention(name) {
  if (!state.mentionMatch) return;
  const input = element('message');
  const {start, end} = state.mentionMatch;
  input.setRangeText('@' + name + ' ', start, end, 'end');
  closeSuggestions();
  input.focus();
  updateSendState();
}

function updateSendState() {
  const blocked = !state.snapshot || state.snapshot.run.status === 'stopped';
  const recipient = member(element('private-target').value);
  element('send-message').disabled = blocked || state.sending || !element('message').value.trim();
  element('send-private').disabled = blocked || state.privateSending || !recipient || !isAddressable(recipient) || !element('private-message').value.trim();
}

async function submit(event, personal = false) {
  event.preventDefault();
  if (element(personal ? 'send-private' : 'send-message').disabled) return;
  const field = element(personal ? 'private-message' : 'message');
  const text = field.value.trim();
  const runId = state.runId;
  const body = personal ? {text, to: element('private-target').value, private: true} : {text};
  const errorBox = element(personal ? 'private-send-error' : 'send-error');
  const busy = personal ? 'privateSending' : 'sending';
  state[busy] = true;
  updateSendState();
  errorBox.hidden = true;
  try {
    await api.post(runId, body);
    if (state.runId === runId && field.value.trim() === text) field.value = '';
    closeSuggestions();
    if (!personal) {
      state.scroll = true;
      element('follow').checked = true;
    }
    await refresh();
  } catch (error) {
    if (state.runId === runId) {
      errorBox.textContent = error.message || String(error);
      errorBox.hidden = false;
    }
  } finally {
    state[busy] = false;
    updateSendState();
  }
}

for (const id of tabNames) element('tab-' + id).addEventListener('click', () => selectTab(id));
element('tabbar').addEventListener('keydown', (event) => {
  const index = tabNames.indexOf(state.tab);
  const key = {ArrowLeft: (index - 1 + tabNames.length) % tabNames.length, ArrowRight: (index + 1) % tabNames.length, Home: 0, End: tabNames.length - 1}[event.key];
  if (key === undefined) return;
  event.preventDefault();
  selectTab(tabNames[key], true);
});
element('run-picker').addEventListener('change', (event) => receiveRun(event.target.value));
element('pause-resume').addEventListener('click', () => controlRun(state.snapshot?.run.status === 'paused' ? 'resume' : 'pause'));
element('stop-run').addEventListener('click', () => {
  state.confirmStop = true;
  renderControls();
  element('cancel-stop').focus();
});
element('cancel-stop').addEventListener('click', () => {
  state.confirmStop = false;
  renderControls();
  element('stop-run').focus();
});
element('confirm-stop-run').addEventListener('click', () => controlRun('stop'));
element('filter-toggle').addEventListener('click', () => {
  const filters = element('board-filters');
  filters.hidden = !filters.hidden;
  element('filter-toggle').setAttribute('aria-expanded', String(!filters.hidden));
});
for (const id of ['post-search', 'sender-filter', 'recipient-filter']) element(id).addEventListener('input', renderFeed);
element('member-search').addEventListener('input', renderMembers);
element('follow').addEventListener('change', (event) => {
  state.scroll = event.target.checked;
  if (state.scroll) goLatest();
});
element('jump-latest').addEventListener('click', goLatest);
element('feed').addEventListener('scroll', () => {
  if (state.rendering) return;
  if (!nearBottom() && state.scroll) {
    state.scroll = false;
    element('follow').checked = false;
  }
  renderLatestButton();
}, {passive: true});
element('replay-position').addEventListener('input', (event) => seek(Number(event.target.value)));
element('step-back').addEventListener('click', () => seek((state.replay ?? posts().length) - 1));
element('step-forward').addEventListener('click', () => seek((state.replay ?? posts().length) + 1));
element('playback').addEventListener('click', playReplay);
element('playback-speed').addEventListener('change', () => {
  if (state.timer) {
    stopReplay();
    playReplay();
  }
});
element('expand-all')?.addEventListener('change', renderGraph);
element('live-graph').addEventListener('click', () => {
  stopReplay();
  state.replay = null;
  renderGraph();
});
element('message').addEventListener('input', () => {
  element('send-error').hidden = true;
  updateSuggestions();
  updateSendState();
});
element('message').addEventListener('click', updateSuggestions);
element('message').addEventListener('blur', closeSuggestions);
element('message').addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    element('compose').requestSubmit();
  } else if (state.choices.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    state.choiceIndex = (state.choiceIndex + (event.key === 'ArrowDown' ? 1 : -1) + state.choices.length) % state.choices.length;
    renderSuggestions();
    element('mention-choice-' + state.choiceIndex).scrollIntoView({block: 'nearest'});
  } else if (state.choices.length && (event.key === 'Enter' || event.key === 'Tab')) {
    event.preventDefault();
    insertMention(state.choices[state.choiceIndex][0]);
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});
element('private-message').addEventListener('input', () => {
  element('private-send-error').hidden = true;
  updateSendState();
});
element('private-message').addEventListener('keydown', (event) => {
  if (!event.isComposing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    element('private-compose').requestSubmit();
  }
});
element('private-target').addEventListener('change', () => {
  element('private-send-error').hidden = true;
  renderPrivate();
  updateSendState();
});
element('compose').addEventListener('submit', (event) => submit(event));
element('private-compose').addEventListener('submit', (event) => submit(event, true));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

async function poll() {
  if (!document.hidden) await refresh();
  setTimeout(poll, inPanel ? 1700 : 1100);
}
void poll();
