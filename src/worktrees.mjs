import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runningIntegrations = new Set();
const gitEnvironment = { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
for (const key of [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX',
  'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) {
  delete gitEnvironment[key];
}

const commitIdentity = {
  GIT_AUTHOR_NAME: 'Codex Swarm',
  GIT_AUTHOR_EMAIL: 'codex-swarm@localhost',
  GIT_COMMITTER_NAME: 'Codex Swarm',
  GIT_COMMITTER_EMAIL: 'codex-swarm@localhost',
};

async function git(cwd, args, { env, allowed = [] } = {}) {
  try {
    const { stdout, stderr } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: { ...gitEnvironment, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    if (allowed.includes(error.code)) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Git ${args[0]} failed in ${cwd}: ${detail}`, { cause: error });
  }
}

async function value(cwd, args, options) {
  return (await git(cwd, args, options)).stdout.trimEnd();
}

function identifier(id, kind) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(id)}`);
  }
  return id;
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function repository(cwd) {
  const result = await git(cwd, ['rev-parse', '--show-toplevel'], { allowed: [128] });
  if (!result.code) return realpath(result.stdout.trimEnd());
  if (/not a git repository|must be run in a work tree/.test(result.stderr)) return null;
  throw new Error(`Cannot find the Git workspace in ${cwd}: ${result.stderr.trim()}`);
}

async function worktreeRoot(cwd) {
  const root = await repository(cwd);
  if (!root) throw new Error(`Not a Git worktree: ${cwd}`);
  return root;
}

async function commonDirectory(cwd) {
  return realpath(await value(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

async function commitTree(cwd, tree, parent, title) {
  // A retry with the same files produces the same commit, even across restarts.
  const date = await value(cwd, ['show', '--no-patch', '--format=%cI', parent]);
  return value(cwd, ['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', title], {
    env: { ...commitIdentity, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function snapshot(cwd, parent, title) {
  const scratch = await mkdtemp(join(tmpdir(), 'codex-swarm-index-'));
  const index = join(scratch, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    const sourceIndex = await value(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    let copied = true;
    try {
      await copyFile(sourceIndex, index);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      copied = false;
    }

    let stagedTree = parent;
    let skipped = [];
    if (copied) {
      const unmerged = await value(cwd, ['ls-files', '--unmerged'], { env });
      if (unmerged) throw new Error(`Resolve the unmerged Git paths in ${cwd} before taking a snapshot.`);
      const listing = await git(cwd, ['ls-files', '-t', '-z'], { env });
      skipped = listing.stdout.split('\0').filter(entry => entry.startsWith('S ')).map(entry => entry.slice(2));
      stagedTree = await value(cwd, ['write-tree'], { env });
      // A copied index keeps cached stat entries but gets a new timestamp. Reading
      // the staged tree into an empty index makes same-size writes rehash reliably.
      await rm(index);
    }
    await git(cwd, ['read-tree', stagedTree], { env });
    for (let start = 0; start < skipped.length; start += 256) {
      await git(cwd, ['update-index', '--skip-worktree', '--', ...skipped.slice(start, start + 256)], { env });
    }

    await git(cwd, ['add', '--all', '--', ':/'], { env });
    const tree = await value(cwd, ['write-tree'], { env });
    const previousTree = await value(cwd, ['rev-parse', `${parent}^{tree}`]);
    return tree === previousTree ? parent : commitTree(cwd, tree, parent, title);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function runDirectory(stateDir, runId) {
  return resolve(stateDir, 'workspaces', identifier(runId, 'run'));
}

async function existingWorktree(path, commonDir, base) {
  let actual;
  try {
    actual = await realpath(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  if (actual !== path || await repository(actual) !== actual || await commonDirectory(actual) !== commonDir) {
    throw new Error(`Cannot reuse ${path}: it is not the requested Git worktree.`);
  }
  await git(actual, ['merge-base', '--is-ancestor', base, 'HEAD']);
  return actual;
}

async function addWorktree(root, path, base) {
  await git(root, ['worktree', 'add', '--detach', '--', path, base]);
  return realpath(path);
}

export async function prepareWorkspace(cwd, stateDir, runId, { isolate = true } = {}) {
  identifier(runId, 'run');
  cwd = await realpath(resolve(cwd));
  const root = await repository(cwd);
  if (!root) {
    if (!isolate) return { cwd, root: null, base: null, integrated: cwd, isolated: false };
    throw new Error(`Isolated Swarm runs need a Git repository with a commit. Use shared mode for ${cwd}.`);
  }

  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { allowed: [128] });
  if (head.code) {
    if (!isolate) return { cwd, root, base: null, integrated: cwd, isolated: false };
    throw new Error(`Create an initial Git commit in ${root} to use isolated Swarm worktrees.`);
  }

  let directory;
  if (isolate) {
    // Keep the team's files outside the original worktree, including its Git directory.
    directory = await canonicalPath(runDirectory(stateDir, runId));
    if (within(root, directory)) throw new Error('Swarm state must be outside the source working tree.');
  }
  const base = await snapshot(root, head.stdout.trimEnd(), `Swarm workspace snapshot: ${runId}`);
  if (!isolate) return { cwd, root, base, integrated: cwd, isolated: false };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const commonDir = await commonDirectory(root);
  const path = join(directory, 'integration');
  const integrated = await existingWorktree(path, commonDir, base) ?? await addWorktree(root, path, base);
  return { cwd, root, base, integrated, isolated: true };
}

export async function memberWorkspace(workspace, stateDir, runId, memberId) {
  if (!workspace.isolated) return workspace.cwd;
  const directory = dirname(workspace.integrated);
  const requestedDirectory = await canonicalPath(runDirectory(stateDir, runId));
  if (requestedDirectory !== directory) throw new Error('Member worktree does not match the prepared Swarm run.');
  const path = join(directory, `worker-${identifier(memberId, 'member')}`);
  const commonDir = await commonDirectory(workspace.root);
  return await existingWorktree(path, commonDir, workspace.base) ?? await addWorktree(workspace.root, path, workspace.base);
}

async function diff(cwd, base, head) {
  const result = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, head, '--']);
  return result.stdout;
}

export async function integrateWorkspace(workspace, workers) {
  const { root, base, integrated, isolated } = workspace;
  if (!base) return { ok: true, diff: '', conflicts: [], base, head: null };
  if (!isolated) {
    const head = await snapshot(root, base, 'Swarm shared result');
    return { ok: true, diff: await diff(root, base, head), conflicts: [], base, head };
  }

  if (runningIntegrations.has(integrated)) throw new Error('Swarm integration is already running.');
  runningIntegrations.add(integrated);
  try {
    const commonDir = await commonDirectory(root);
    if (!await existingWorktree(integrated, commonDir, base)) {
      throw new Error(`The Swarm integration worktree is missing: ${integrated}`);
    }
    const originalHead = await value(integrated, ['rev-parse', 'HEAD']);
    let head = base;
    const seen = new Set([root, integrated]);
    for (const worker of workers) {
      const cwd = await worktreeRoot(worker.cwd);
      const expected = join(dirname(integrated), `worker-${identifier(worker.id, 'member')}`);
      if (cwd !== expected || seen.has(cwd) || await commonDirectory(cwd) !== commonDir) {
        throw new Error(`Worker ${worker.id} must have its own worktree from this Swarm run.`);
      }
      seen.add(cwd);
      await git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
      const changes = await snapshot(cwd, base, `Swarm worker output: ${worker.id}`);
      if (changes === base) continue;

      const result = await git(root, [
        'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', head, changes,
      ], { allowed: [1] });
      const [tree, ...paths] = result.stdout.split('\0').filter(Boolean);
      if (result.code) {
        return { ok: false, diff: '', conflicts: [{ workerId: worker.id, paths }], base, head: originalHead };
      }
      if (!tree) throw new Error(`Git produced no integration tree for worker ${worker.id}.`);
      head = await commitTree(root, tree, base, 'Swarm integrated output');
    }

    const integrationDiff = await diff(root, base, head);
    const currentHead = await value(integrated, ['rev-parse', 'HEAD']);
    const dirty = await value(integrated, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (dirty || currentHead !== originalHead) {
      throw new Error(`The Swarm integration worktree changed during verification: ${integrated}`);
    }
    if (head !== originalHead) {
      await git(integrated, ['checkout', '--detach', '--no-overwrite-ignore', head]);
    }
    return { ok: true, diff: integrationDiff, conflicts: [], base, head };
  } finally {
    runningIntegrations.delete(integrated);
  }
}
