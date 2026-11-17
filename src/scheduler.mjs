import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Codex } from './codex.mjs';
import { SwarmState } from './state.mjs';
import { integrateWorkspace, memberWorkspace, prepareWorkspace } from './worktrees.mjs';
import { memberPrompt, planSchema, reviewSchema, swarmTools } from './protocol.mjs';

const active = new Set(['queued', 'running']);
const controls = new Set(['pause', 'resume', 'stop', 'interrupt', 'change-model']);
const verificationLimit = 5;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const errorText = error => error instanceof Error ? error.message : String(error);

function text(value, label, max = 24000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw failure(`${label} must contain 1–${max} characters.`);
  }
  return value.trim();
}

function member(id, role, model, task, cwd) {
  return { id, name: id, role, model, task, cwd, group: role === 'worker' ? 'worker' : null,
    status: 'idle', pending: [], inflight: [], threadId: null, completedTurns: 0,
    activity: '', lastError: null, interrupt: null };
}

export class SwarmScheduler {
  constructor({ directory, codex, workspace = { prepareWorkspace, memberWorkspace, integrateWorkspace } }) {
    this.directory = directory;
    this.state = new SwarmState(directory);
    this.workspace = workspace;
    this.contexts = new Map();
    this.threads = new Map();
    this.hydrated = new Set();
    this.stopping = false;
    this.codex = codex ?? new Codex({
      command: process.env.SWARM_CODEX_BIN,
      onEvent: event => this.handleEvent(event),
      onToolCall: call => this.handleTool(call),
    });
    for (const run of this.state.runs()) {
      const rows = this.state.members(run.id);
      const posts = this.state.events(run.id).filter(event => event.kind === 'post').map(event => ({
        ...event.data, id: event.seq, seq: event.seq, at: event.at,
      }));
      const ctx = this.context(run, rows, posts);
      for (const item of rows) {
        if (item.threadId) this.threads.set(item.threadId, { ctx, item });
        if (item.status === 'running') {
          const stopped = run.status === 'stopped' || item.interrupt === 'stop';
          this.saveMember(ctx, item, {
            status: stopped ? 'stopped' : run.status === 'running' && item.interrupt !== 'interrupt' ? 'queued' : 'paused',
            pending: [...new Set([...item.inflight, ...item.pending])], inflight: [],
            interrupt: null, activity: 'Restored from the last saved turn',
          });
        }
      }
      this.kick(ctx);
    }
  }

  context(run, rows, posts = []) {
    const ctx = {
      run, members: new Map(rows.map(item => [item.id, item])),
      posts: new Map(posts.map(post => [post.seq, post])), jobs: new Map(),
      steering: new Set(), pumping: false, again: false,
    };
    this.contexts.set(run.id, ctx);
    return ctx;
  }

  requireRun(id) {
    const ctx = this.contexts.get(id);
    if (!ctx) throw failure('Swarm run not found.', 404);
    return ctx;
  }

  listRuns() {
    return { runs: this.state.runs().map(({ workspace, verifyRevision, ...run }) => run) };
  }

  snapshot(runId) {
    const ctx = this.requireRun(runId);
    const { workspace, verifyRevision, ...run } = ctx.run;
    return { run, members: [...ctx.members.values()].map(({ pending, inflight, interrupt, ...item }) => item),
      posts: [...ctx.posts.values()], events: this.state.events(runId) };
  }

  start({ goal, cwd, title, workers = 2, model, isolate = true } = {}) {
    goal = text(goal, 'Goal');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw failure('Choose an existing absolute project directory.');
    }
    if (!Number.isInteger(workers) || workers < 1 || workers > 6) throw failure('Choose between 1 and 6 workers.');
    if (typeof isolate !== 'boolean') throw failure('isolate must be true or false.');
    model = model === undefined ? null : text(model, 'Model', 100);
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), title: title === undefined ? goal.split('\n')[0].slice(0, 100) : text(title, 'Title', 100),
      goal, cwd: resolve(cwd), workerCount: workers, model, isolate, createdAt: now, updatedAt: now,
      status: 'running', phase: 'planning', revision: 0, verifyRevision: null, verificationRounds: 0,
      checks: [], workspace: null, integration: null, final: null, lastError: null,
    };
    const coordinator = member('coordinator', 'coordinator', model, 'Plan and coordinate the work', run.cwd);
    const verifier = member('verifier', 'verifier', model, 'Verify the combined result', null);
    const monitor = member('monitor', 'monitor', null, 'Report when work is blocked', null);
    const ctx = this.context(run, [coordinator, verifier, monitor]);
    this.state.atomic(() => {
      this.state.saveRun(run);
      for (const item of ctx.members.values()) this.state.saveMember(run.id, item);
      this.event(ctx, 'run.started', null, { title: run.title });
      this.recordPost(ctx, 'you', { text: goal, kind: 'goal' });
      this.saveMember(ctx, coordinator, { status: 'queued' });
    });
    this.kick(ctx);
    return run;
  }

  event(ctx, kind, item, data) {
    return this.state.append(ctx.run.id, kind, item?.id ?? null, data);
  }

  saveRun(ctx, patch) {
    Object.assign(ctx.run, patch, { updatedAt: new Date().toISOString() });
    this.state.saveRun(ctx.run);
    if ('status' in patch || 'phase' in patch) {
      this.event(ctx, 'run.state', null, { status: ctx.run.status, phase: ctx.run.phase });
    }
  }

  saveMember(ctx, item, patch) {
    const status = item.status;
    Object.assign(item, patch);
    this.state.saveMember(ctx.run.id, item);
    if (status !== item.status) this.event(ctx, 'member.state', item, { status: item.status, activity: item.activity });
  }

  recordPost(ctx, from, { to = [], text: body, private: personal = false, kind = 'message', route = true }) {
    const data = { from, to, text: body, private: personal, kind };
    const event = this.event(ctx, 'post', ctx.members.get(from), data);
    const post = { ...data, id: event.seq, seq: event.seq, at: event.at };
    ctx.posts.set(post.seq, post);
    if (route) {
      for (const id of to) {
        const item = ctx.members.get(id);
        const status = ctx.run.status === 'running' && item.status !== 'running' ? 'queued' : item.status;
        this.saveMember(ctx, item, { pending: [...item.pending, post.seq], status });
      }
    }
    return post;
  }

  addressed(ctx, from, { to, text: body, private: personal } = {}) {
    const value = text(body, 'Message');
    const explicit = typeof to === 'string' ? to.split(/[,\s]+/).filter(Boolean) : to;
    if (explicit !== undefined && (!Array.isArray(explicit) || explicit.some(name => typeof name !== 'string'))) {
      throw failure('Recipients must be names or a list of names.');
    }
    const names = new Set(explicit?.length
      ? explicit.map(name => name.replace(/^@/, '').toLowerCase())
      : [...value.matchAll(/(?<![\w@/])@([a-z][a-z0-9-]*)/gi)].map(match => match[1].toLowerCase()));
    const recipients = [...ctx.members.values()].filter(item => item.id !== from && item.role !== 'monitor'
      && item.status !== 'stopped' && (names.has('all') || names.has(item.id) || names.has(item.group))).map(item => item.id);
    if (explicit?.length && !recipients.length) throw failure('No active members match those recipients.');
    if (personal && recipients.length !== 1) throw failure('Choose one recipient for a private message.');
    return { text: value, to: recipients, private: personal === true };
  }

  async post(runId, input) {
    const ctx = this.requireRun(runId);
    if (ctx.run.status === 'stopped') throw failure('This swarm is stopped.', 409);
    const data = this.addressed(ctx, 'you', input);
    const post = this.state.atomic(() => {
      if (ctx.run.status === 'complete' && data.to.length) {
        this.saveRun(ctx, { status: 'running', phase: 'working', lastError: null, verificationRounds: 0 });
      }
      return this.recordPost(ctx, 'you', data);
    });
    const recipient = data.private ? ctx.members.get(data.to[0]) : null;
    if (recipient?.status === 'running' && recipient.purpose === 'work' && recipient.activeTurnId && ctx.run.status === 'running'
      && !ctx.steering.has(recipient.id)) {
      await this.steer(ctx, recipient, post);
    }
    this.kick(ctx);
    return post;
  }

  async steer(ctx, item, post) {
    ctx.steering.add(item.id);
    const expectedTurnId = item.activeTurnId;
    this.saveMember(ctx, item, { privateTurn: expectedTurnId });
    try {
      const delivered = await this.codex.steer({
        threadId: item.threadId, expectedTurnId,
        text: `Private instruction for @${item.id} from the user. Keep it out of the public board.\n${post.text}`,
      });
      if (delivered && !this.stopping) {
        const inflight = item.status === 'running' && item.activeTurnId === expectedTurnId
          ? [...item.inflight, post.seq] : item.inflight;
        this.saveMember(ctx, item, { pending: item.pending.filter(seq => seq !== post.seq), inflight });
        this.event(ctx, 'turn.steered', item, { turnId: expectedTurnId, postSeq: post.seq });
      }
    } catch {
      // The recorded post remains queued if the target finished or lost its connection.
    } finally {
      ctx.steering.delete(item.id);
    }
  }

  async control(runId, { action, memberId, model } = {}) {
    const ctx = this.requireRun(runId);
    if (!controls.has(action)) throw failure('Unknown control action.');
    const item = memberId ? ctx.members.get(memberId) : null;
    if (memberId && (!item || item.role === 'monitor')) throw failure('Member not found.', 404);
    if (ctx.run.status === 'stopped') throw failure('A stopped run cannot be reopened.', 409);
    if (action === 'change-model') {
      if (!item) throw failure('Choose a member to change its next turn model.');
      this.saveMember(ctx, item, { model: text(model, 'Model', 100) });
      this.event(ctx, 'member.model', item, { model: item.model });
    } else if (action === 'interrupt') {
      if (item?.status !== 'running') throw failure('Choose a running member.', 409);
      this.saveMember(ctx, item, { interrupt: 'interrupt' });
      if (item.threadId) await this.codex.interrupt(item.threadId);
    } else if (action === 'resume') {
      if (ctx.run.status !== 'paused') throw failure('Only a paused run can be resumed.', 409);
      const phase = ctx.run.phase === 'verifying' && !ctx.jobs.size ? 'working' : ctx.run.phase;
      this.state.atomic(() => {
        this.saveRun(ctx, { status: 'running', phase, lastError: null,
          verificationRounds: Math.min(ctx.run.verificationRounds, verificationLimit - 1) });
        for (const child of ctx.members.values()) {
          if (child.interrupt || !['paused', 'failed'].includes(child.status)) continue;
          this.saveMember(ctx, child, { status: child.pending.length ? 'queued' : 'idle', lastError: null });
        }
        if (phase === 'planning' && !ctx.jobs.has('coordinator')) {
          this.saveMember(ctx, ctx.members.get('coordinator'), { status: 'queued' });
        }
      });
    } else {
      const stopped = action === 'stop';
      this.state.atomic(() => {
        this.saveRun(ctx, { status: stopped ? 'stopped' : 'paused' });
        for (const child of ctx.members.values()) {
          if (ctx.jobs.has(child.id)) this.saveMember(ctx, child, { interrupt: action });
          else if (child.role !== 'monitor') this.saveMember(ctx, child, { status: stopped ? 'stopped' : 'paused' });
        }
      });
      await Promise.allSettled([...ctx.members.values()].filter(child => child.interrupt === action && child.threadId)
        .map(child => this.codex.interrupt(child.threadId)));
    }
    this.kick(ctx);
    return ctx.run;
  }

  kick(ctx) {
    ctx.again = true;
    if (ctx.pumping || this.stopping || ctx.run.status !== 'running') return;
    ctx.pumping = true;
    ctx.pumpTask = Promise.resolve().then(async () => {
      try {
        while (ctx.again && !this.stopping && ctx.run.status === 'running') {
          ctx.again = false;
          await this.pump(ctx);
        }
      } catch (error) {
        if (!this.stopping && ctx.run.status === 'running') this.block(ctx, errorText(error));
      } finally {
        ctx.pumping = false;
      }
    });
  }

  async pump(ctx) {
    if (ctx.run.phase === 'planning') {
      const coordinator = ctx.members.get('coordinator');
      if (coordinator.status === 'queued') this.launch(ctx, coordinator, 'plan');
      return;
    }
    for (const item of ctx.members.values()) {
      if (item.status !== 'queued') continue;
      if (item.role === 'verifier' && ctx.run.phase === 'working'
        && !item.pending.some(seq => ctx.posts.get(seq)?.from === 'you')) continue;
      const purpose = item.role === 'verifier' && ctx.run.phase === 'verifying' ? 'verify' : 'work';
      this.launch(ctx, item, purpose);
    }
    if (ctx.jobs.size || !['working', 'verifying'].includes(ctx.run.phase)) return;
    const workers = [...ctx.members.values()].filter(item => item.role === 'worker');
    if (workers.some(item => active.has(item.status))) return;
    if (ctx.run.phase === 'verifying' || workers.some(item => ['failed', 'paused'].includes(item.status))) {
      this.block(ctx, 'A member needs attention. Send it a follow-up or resume the run.');
      return;
    }
    if (ctx.run.verificationRounds >= verificationLimit) {
      this.block(ctx, 'Verification reached the automatic retry limit. Review the findings and resume if needed.');
      return;
    }
    await this.queueReview(ctx, workers);
  }

  launch(ctx, item, purpose) {
    if (ctx.jobs.has(item.id) || ctx.steering.has(item.id) || this.stopping || ctx.run.status !== 'running') return;
    const queued = item.pending.map(seq => ctx.posts.get(seq)).filter(Boolean);
    let posts;
    if (purpose === 'work') {
      const boundary = queued.findIndex(post => post.private !== queued[0].private);
      posts = boundary === -1 ? queued : queued.slice(0, boundary);
    } else {
      posts = queued.filter(post => !post.private);
    }
    const inflight = posts.map(post => post.seq);
    this.state.atomic(() => this.saveMember(ctx, item, {
      status: 'running', purpose, inflight, pending: item.pending.filter(seq => !inflight.includes(seq)), interrupt: null,
      activity: 'Starting Codex', lastError: null, activeTurnId: null, privateTurn: null,
    }));
    const job = this.turn(ctx, item, purpose, posts).catch(error => {
      if (item.interrupt || this.stopping || ctx.run.status !== 'running') return;
      const lastError = errorText(error);
      this.saveMember(ctx, item, { status: 'failed', lastError, activity: 'Turn failed',
        pending: [...new Set([...item.inflight, ...item.pending])], inflight: [] });
      this.event(ctx, 'turn.failed', item, { error: lastError });
      if (purpose !== 'work') this.block(ctx, `@${item.id}: ${lastError}`);
    }).finally(() => {
      if (!this.stopping && item.interrupt) {
        const stopped = item.interrupt === 'stop' || ctx.run.status === 'stopped';
        const pending = item.interrupt === 'pause' ? [...new Set([...item.inflight, ...item.pending])] : item.pending;
        this.saveMember(ctx, item, {
          status: stopped ? 'stopped' : ctx.run.status === 'running' && pending.length ? 'queued' : 'paused',
          pending, inflight: [], interrupt: null, activity: stopped ? 'Stopped' : 'Interrupted',
        });
      }
      ctx.jobs.delete(item.id);
      this.kick(ctx);
    });
    ctx.jobs.set(item.id, job);
  }

  async thread(ctx, item) {
    const readOnly = item.role === 'coordinator' || (item.role === 'verifier' && !ctx.run.isolate);
    const options = {
      cwd: item.cwd, model: item.model ?? undefined, tools: swarmTools,
      sandbox: readOnly ? 'read-only' : 'workspace-write', name: `Swarm: ${item.id}`,
    };
    if (!item.threadId) {
      const threadId = await this.codex.startThread(options);
      this.saveMember(ctx, item, { threadId });
      this.threads.set(threadId, { ctx, item });
      this.hydrated.add(threadId);
    } else if (!this.hydrated.has(item.threadId)) {
      await this.codex.resumeThread({ ...options, threadId: item.threadId });
      this.hydrated.add(item.threadId);
    }
    return item.threadId;
  }

  async turn(ctx, item, purpose, posts) {
    if (purpose === 'plan' && !ctx.run.workspace) {
      const workspace = await this.workspace.prepareWorkspace(ctx.run.cwd, this.directory, ctx.run.id, { isolate: ctx.run.isolate });
      if (this.stopping) return;
      this.saveRun(ctx, { workspace, integration: workspace.integrated });
      this.saveMember(ctx, item, { cwd: workspace.integrated });
      this.saveMember(ctx, ctx.members.get('verifier'), { cwd: workspace.integrated });
    }
    if (item.interrupt || this.stopping || ctx.run.status !== 'running') return;
    const threadId = await this.thread(ctx, item);
    if (item.interrupt || this.stopping || ctx.run.status !== 'running') return;
    const outputSchema = purpose === 'plan' ? planSchema : purpose === 'verify' ? reviewSchema : undefined;
    const result = await this.codex.turn({
      threadId, model: item.model ?? undefined, outputSchema,
      prompt: memberPrompt(ctx.run, item, purpose, posts),
    });
    if (item.interrupt || this.stopping || ctx.run.status !== 'running') return;
    if (result.status !== 'completed') throw new Error(result.error?.message ?? result.error ?? `Turn ${result.status}.`);
    if (purpose === 'plan') await this.applyPlan(ctx, item, JSON.parse(result.text));
    else if (purpose === 'verify') this.applyReview(ctx, item, JSON.parse(result.text));
    else this.state.atomic(() => {
      if (result.text?.trim()) {
        const personal = item.privateTurn === result.turnId || (posts.length > 0 && posts.every(post => post.private));
        this.recordPost(ctx, item.id, { text: result.text.trim(), kind: 'report', private: personal });
      }
      if (item.role === 'worker') this.saveRun(ctx, { revision: ctx.run.revision + 1 });
    });
    if (!item.interrupt && !this.stopping) this.saveMember(ctx, item, {
      status: ctx.run.status === 'running' && item.pending.length ? 'queued' : 'idle',
      activity: 'Waiting for a mention', inflight: [], activeTurnId: null, completedTurns: item.completedTurns + 1,
    });
  }

  async applyPlan(ctx, coordinator, plan) {
    if (!Array.isArray(plan.tasks) || !plan.tasks.length || !Array.isArray(plan.checks)) {
      throw new Error('Planning produced no actionable assignments.');
    }
    const used = new Set(['you', 'all', 'worker', 'system', ...ctx.members.keys()]);
    const planned = [];
    for (const [index, task] of plan.tasks.slice(0, ctx.run.workerCount).entries()) {
      let id = String(task.name ?? '').replace(/^@/, '').toLowerCase();
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || used.has(id)) id = `worker-${index + 1}`;
      if (used.has(id)) id = `worker-${randomUUID().slice(0, 8)}`;
      used.add(id);
      const cwd = await this.workspace.memberWorkspace(ctx.run.workspace, this.directory, ctx.run.id, id);
      planned.push(member(id, 'worker', ctx.run.model, text(task.task, 'Assignment'), cwd));
    }
    if (this.stopping || ctx.run.status !== 'running' || coordinator.interrupt) return;
    this.state.atomic(() => {
      this.saveRun(ctx, { phase: 'working', checks: plan.checks.map(String).slice(0, 30) });
      this.recordPost(ctx, coordinator.id, { text: String(plan.summary || 'Assignments are ready.'), kind: 'plan' });
      for (const item of planned) {
        ctx.members.set(item.id, item);
        this.state.saveMember(ctx.run.id, item);
        this.event(ctx, 'member.added', item, { role: item.role, model: item.model });
        this.recordPost(ctx, coordinator.id, { to: [item.id], text: item.task, kind: 'assignment' });
      }
    });
  }

  async queueReview(ctx, workers) {
    const result = await this.workspace.integrateWorkspace(ctx.run.workspace, workers.map(({ id, cwd }) => ({ id, cwd })));
    if (this.stopping || ctx.run.status !== 'running') return;
    if (!result.ok) {
      const notes = result.conflicts?.map(conflict =>
        `@${conflict.workerId}: ${conflict.paths?.join(', ') || 'overlapping changes'}`).join('\n');
      this.block(ctx, `Integration needs intervention.\n${notes || 'No combined result was produced.'}`);
      return;
    }
    if (workers.some(item => active.has(item.status))) {
      this.kick(ctx);
      return;
    }
    if (ctx.run.final && result.head && result.head === ctx.run.verifiedHead) {
      this.saveRun(ctx, { status: 'complete', phase: 'done', lastError: null });
      const verifier = ctx.members.get('verifier');
      if (verifier.status === 'queued' && verifier.pending.every(seq => ctx.posts.get(seq)?.from !== 'you')) {
        this.saveMember(ctx, verifier, { status: 'idle' });
      }
      return;
    }
    this.state.atomic(() => {
      this.event(ctx, 'integration.ready', null, { cwd: ctx.run.integration, base: result.base, head: result.head ?? null });
      this.saveRun(ctx, {
        phase: 'verifying', verifyRevision: ctx.run.revision,
        integrationHead: result.head ?? null,
        verificationRounds: ctx.run.verificationRounds + 1,
      });
      this.recordPost(ctx, 'coordinator', { to: ['verifier'], kind: 'verification',
        text: 'Inspect the combined diff in the integration checkout and run the project checks.' });
    });
    this.kick(ctx);
  }

  applyReview(ctx, verifier, report) {
    if (typeof report.passed !== 'boolean' || !Array.isArray(report.fixes) || !Array.isArray(report.checks)) {
      throw new Error('The verifier did not report a pass or fail and its supporting checks.');
    }
    const summary = [report.summary, ...report.checks].map(String).join('\n');
    const workers = [...ctx.members.values()].filter(item => item.role === 'worker');
    this.state.atomic(() => {
      this.recordPost(ctx, verifier.id, { text: summary, kind: report.passed ? 'passed' : 'failed' });
      if (ctx.run.revision !== ctx.run.verifyRevision || workers.some(item => active.has(item.status))) {
        this.saveRun(ctx, { phase: 'working' });
      } else if (report.passed) {
        const privateWaiting = [...ctx.members.values()].some(item =>
          item.pending.some(seq => ctx.posts.get(seq)?.private));
        this.saveRun(ctx, { status: privateWaiting ? 'running' : 'complete',
          phase: privateWaiting ? 'working' : 'done', final: summary, lastError: null,
          verifiedHead: ctx.run.integrationHead });
        this.recordPost(ctx, 'coordinator', { text: `Verification passed. Result: ${ctx.run.integration}\n${summary}`, kind: 'done' });
      } else {
        const fixes = report.fixes.map(fix => ({ id: String(fix?.member).replace(/^@/, ''), task: fix?.task }))
          .filter(fix => typeof fix.task === 'string' && fix.task.trim() && workers.some(item => item.id === fix.id));
        this.saveRun(ctx, { phase: 'working' });
        if (!fixes.length) this.block(ctx, 'Verification failed without an actionable assignment. Review its report.');
        for (const fix of fixes) {
          this.recordPost(ctx, verifier.id, { to: [fix.id], text: fix.task, kind: 'rework' });
        }
      }
    });
  }

  block(ctx, reason) {
    this.saveRun(ctx, { status: 'paused', lastError: reason });
    this.recordPost(ctx, 'monitor', { text: reason, kind: 'blocked' });
  }

  handleTool({ threadId, tool, arguments: args, callId }) {
    const record = this.threads.get(threadId);
    if (!record) throw failure('This Codex thread is not a swarm member.');
    const { ctx, item } = record;
    if (tool === 'swarm_read_board') {
      return {
        runId: ctx.run.id, status: ctx.run.status,
        members: [...ctx.members.values()].map(({ id, role, status, task, model }) => ({ id, role, status, task, model })),
        posts: [...ctx.posts.values()].filter(post => post.seq > (Number(args?.afterSeq) || 0)
          && !post.private).slice(-60),
      };
    }
    if (tool !== 'swarm_send_post') throw failure('Unknown swarm tool.');
    if (this.stopping || ctx.run.status !== 'running') throw failure('This run is not accepting worker posts.', 409);
    if (item.privateTurn || (item.inflight.length && item.inflight.every(seq => ctx.posts.get(seq)?.private))) {
      throw failure('This is a private turn. Reply directly to the user in your final response.', 409);
    }
    const existing = this.state.toolResult(threadId, callId);
    if (existing) return existing;
    const data = this.addressed(ctx, item.id, args);
    const result = this.state.atomic(() => {
      const post = this.recordPost(ctx, item.id, { ...data, private: false });
      const response = { seq: post.seq, deliveredTo: post.to };
      this.state.saveToolResult(threadId, callId, response);
      return response;
    });
    this.kick(ctx);
    return result;
  }

  handleEvent({ method, params }) {
    if (this.stopping) return;
    if (method === 'runtime/disconnected') this.hydrated.clear();
    const record = this.threads.get(params?.threadId);
    if (!record) return;
    const { ctx, item } = record;
    if (method === 'turn/started' || method === 'turn/completed') {
      if (method === 'turn/started') this.saveMember(ctx, item, { activeTurnId: params.turn?.id });
      this.event(ctx, method.replace('/', '.'), item, { turnId: params.turn?.id, status: params.turn?.status });
      if (method === 'turn/started' && item.interrupt) void this.codex.interrupt(item.threadId).catch(() => {});
    } else if (method === 'item/started'
      && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(params.item?.type)) {
      const activity = String(params.item.command ?? params.item.tool ?? params.item.type).slice(0, 250);
      this.saveMember(ctx, item, { activity });
      this.event(ctx, 'member.activity', item, { activity });
    }
  }

  async stop() {
    this.stopping = true;
    await this.codex.close();
    await Promise.allSettled([...this.contexts.values()].flatMap(ctx => [ctx.pumpTask, ...ctx.jobs.values()]));
    this.state.close();
  }
}
