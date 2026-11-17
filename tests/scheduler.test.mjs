import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { planSchema, reviewSchema } from '../src/protocol.mjs';
import { SwarmScheduler } from '../src/scheduler.mjs';

const completed = text => ({ text, status: 'completed' });
const plan = tasks => completed(JSON.stringify({
  summary: 'Fixture plan', tasks, checks: ['Inspect the combined files.'],
}));
const review = fixes => completed(JSON.stringify({
  passed: !fixes.length, summary: fixes.length ? 'Needs a repair' : 'Verified',
  checks: ['Inspected the combined files.'], fixes,
}));

function git(directory, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-swarm-test-')));
  const cwd = join(root, 'source');
  await mkdir(cwd);
  await writeFile(join(cwd, 'a.txt'), 'base\n');
  await writeFile(join(cwd, 'b.txt'), 'base\n');
  git(cwd, 'init', '--quiet');
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Initial files');
  return { cwd, state: join(root, 'state'), cleanup: () => rm(root, { force: true, recursive: true }) };
}

function codexFixture(directory, onTurn, { threads = new Map(), onClose = () => {} } = {}) {
  const starts = [];
  const resumed = [];
  const steered = [];
  const turns = [];
  const codex = {
    async startThread(options) {
      const id = `thread-${threads.size + 1}`;
      threads.set(id, options);
      starts.push({ id, ...options });
      return id;
    },
    async resumeThread({ threadId }) {
      assert(threads.has(threadId));
      resumed.push(threadId);
      return threadId;
    },
    async steer(options) {
      steered.push(options);
      return true;
    },
    async interrupt() {},
    async close() { onClose(); },
    async turn(options) {
      const { threadId } = options;
      const turnId = `turn-${turns.length + 1}`;
      const input = { ...threads.get(threadId), ...options, turnId };
      turns.push(input);
      scheduler.handleEvent({
        method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } },
      });
      const result = await onTurn(input);
      scheduler.handleEvent({
        method: 'turn/completed', params: { threadId, turn: { id: turnId, status: result.status } },
      });
      return { ...result, turnId };
    },
  };
  const scheduler = new SwarmScheduler({ directory, codex });
  return { scheduler, threads, starts, resumed, steered, turns };
}

async function waitFor(condition, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('parallel workers integrate real edits and repair on the original thread', async () => {
  const workspace = await repository();
  const releaseAlpha = Promise.withResolvers();
  const fixture = codexFixture(workspace.state, async turn => {
    if (turn.outputSchema === planSchema) return plan([
      { name: 'alpha', task: 'Edit a.txt' }, { name: 'beta', task: 'Edit b.txt' },
    ]);
    if (turn.outputSchema === reviewSchema) {
      assert.equal(await readFile(join(turn.cwd, 'b.txt'), 'utf8'), 'beta\n');
      const repaired = await readFile(join(turn.cwd, 'a.txt'), 'utf8') === 'repaired\n';
      return review(repaired ? [] : [{ member: 'alpha', task: 'Repair a.txt.' }]);
    }
    if (turn.name === 'Swarm: alpha') {
      if (turn.prompt.includes('Repair a.txt.')) {
        await writeFile(join(turn.cwd, 'a.txt'), 'repaired\n');
      } else {
        await writeFile(join(turn.cwd, 'a.txt'), 'wrong\n');
        await releaseAlpha.promise;
      }
    }
    if (turn.name === 'Swarm: beta') await writeFile(join(turn.cwd, 'b.txt'), 'beta\n');
    return completed('Fixture work done');
  }, { onClose: releaseAlpha.resolve });
  const { scheduler } = fixture;
  try {
    const run = scheduler.start({ cwd: workspace.cwd, goal: 'Fixture edits', workers: 2 });
    await waitFor(() => ['Swarm: alpha', 'Swarm: beta'].every(name =>
      fixture.turns.some(turn => turn.name === name)), 'both workers to start before alpha finishes');
    const alpha = fixture.starts.find(thread => thread.name === 'Swarm: alpha');
    const beta = fixture.starts.find(thread => thread.name === 'Swarm: beta');
    const call = {
      threadId: alpha.id, tool: 'swarm_send_post', callId: 'retry-key',
      arguments: { text: '@beta Check the second file.' },
    };
    assert.deepEqual(await scheduler.handleTool(call), await scheduler.handleTool(call));
    const post = await scheduler.post(run.id, { text: '@alpha private steering request', private: true });
    assert.deepEqual(post.to, ['alpha']);
    const betaBoard = scheduler.handleTool({ threadId: beta.id, tool: 'swarm_read_board' });
    assert(!betaBoard.posts.some(item => item.seq === post.seq));
    releaseAlpha.resolve();
    await waitFor(() => ['complete', 'paused'].includes(scheduler.snapshot(run.id).run.status), 'verification');

    const snapshot = scheduler.snapshot(run.id);
    assert.equal(snapshot.run.status, 'complete', snapshot.run.lastError);
    assert.equal(snapshot.posts.filter(item => item.text === '@beta Check the second file.').length, 1);
    assert.equal(fixture.starts.filter(thread => thread.name === 'Swarm: alpha').length, 1);
    assert.equal(fixture.turns.filter(turn => turn.threadId === alpha.id && turn.prompt.includes('Repair a.txt.')).length, 1);
    assert.equal(fixture.turns.filter(turn => turn.outputSchema === reviewSchema).length, 2);
    assert.equal(fixture.steered.length, 1);
    assert.equal(fixture.steered[0].threadId, alpha.id);
    assert(!fixture.turns.some(turn => turn.prompt.includes('private steering request')));
    assert.equal(await readFile(join(snapshot.run.integration, 'a.txt'), 'utf8'), 'repaired\n');
    assert.equal(await readFile(join(snapshot.run.integration, 'b.txt'), 'utf8'), 'beta\n');
    assert.equal(git(workspace.cwd, 'status', '--porcelain'), '');
    assert(snapshot.events.every((event, index) => event.seq === index + 1));
  } finally {
    await scheduler.stop();
    await workspace.cleanup();
  }
});

test('shutdown restores an active worker and its queued mention into the same thread', async () => {
  const workspace = await repository();
  const release = Promise.withResolvers();
  const first = codexFixture(workspace.state, async turn => {
    if (turn.outputSchema === planSchema) return plan([{ name: 'alpha', task: 'Edit a.txt' }]);
    await release.promise;
    return completed('Interrupted fixture');
  }, { onClose: release.resolve });
  let active = first.scheduler;
  try {
    const run = active.start({ cwd: workspace.cwd, goal: 'Restart check', workers: 1 });
    await waitFor(() => first.turns.some(turn => turn.name === 'Swarm: alpha'), 'initial worker turn');
    const thread = first.starts.find(item => item.name === 'Swarm: alpha');
    await active.post(run.id, { text: '@alpha queued before restart' });
    await active.stop();
    active = null;

    const second = codexFixture(workspace.state, async turn => {
      if (turn.outputSchema === reviewSchema) return review([]);
      assert.equal(turn.threadId, thread.id);
      assert(turn.prompt.includes('Edit a.txt'));
      assert.equal(turn.prompt.split('queued before restart').length, 2);
      await writeFile(join(turn.cwd, 'a.txt'), 'restored\n');
      return completed('Restored after restart');
    }, { threads: first.threads });
    active = second.scheduler;
    await waitFor(() => ['complete', 'paused'].includes(active.snapshot(run.id).run.status), 'resumed verification');

    const snapshot = active.snapshot(run.id);
    assert.equal(snapshot.run.status, 'complete', snapshot.run.lastError);
    assert(second.resumed.includes(thread.id));
    assert.equal(second.turns.filter(turn => turn.threadId === thread.id).length, 1);
    assert.equal(await readFile(join(snapshot.run.integration, 'a.txt'), 'utf8'), 'restored\n');
  } finally {
    await active?.stop();
    await workspace.cleanup();
  }
});
