import { call, ensureDaemon } from './endpoint.mjs';

async function invoke() {
  const [command, id] = process.argv.slice(2);
  const path = id ? `/api/runs/${encodeURIComponent(id)}` : '/api/runs';
  if (command === 'board') {
    const url = new URL('/', await ensureDaemon());
    if (id) {
      await call(path);
      url.searchParams.set('run', id);
    }
    return { url: url.href };
  }
  if (command === 'list' || (command === 'snapshot' && id)) return call(path);
  if (!['start', 'post', 'control'].includes(command) || (command === 'start' ? Boolean(id) : !id)) {
    throw new Error('Usage: local.mjs board [id] | list | snapshot id | start | post id | control id');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return call(command === 'start' ? path : `${path}/${command === 'post' ? 'posts' : 'control'}`, {
    method: 'POST', body,
  });
}

try {
  process.stdout.write(JSON.stringify(await invoke()) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
