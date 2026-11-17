const string = { type: 'string' };
const strings = { type: 'array', items: string };
const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

export const planSchema = object({
  summary: string,
  tasks: { type: 'array', items: object({ name: string, task: string }) },
  checks: strings,
});

export const reviewSchema = object({
  passed: { type: 'boolean' },
  summary: string,
  checks: strings,
  fixes: { type: 'array', items: object({ member: string, task: string }) },
});

export const swarmTools = [
  {
    name: 'swarm_read_board',
    description: 'Read ordered team posts, briefs, and member status.',
    inputSchema: { type: 'object', properties: { afterSeq: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  },
  {
    name: 'swarm_send_post',
    description: 'Post to the public swarm board. Mention @name, a group, or @all to wake recipients.',
    inputSchema: {
      type: 'object',
      properties: { to: strings, text: string },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

export function memberPrompt(run, member, purpose, posts) {
  const messages = posts.length ? '\n\nMessages delivered this turn:\n' + posts.map(post =>
    `#${post.seq} @${post.from}${post.private ? ' (private)' : ''}: ${post.text}`).join('\n\n') : '';
  const intro = `You are @${member.id}, the ${member.role} in a local Codex Swarm.\nOverall goal:\n${run.goal}\n`
    + 'Use swarm_read_board to inspect public briefs and swarm_send_post to coordinate. Mention specific members for actions. '
    + 'A mention starts a real model turn. Mention someone only for a concrete question or actionable task, never for thanks, progress, or acknowledgments. '
    + 'Use bare names for references. The scheduler posts your final report and automatically integrates and requests verification when implementation is quiet. '
    + 'Keep replies to private messages out of public posts. Keep activity within the user goal and assigned workspace.';
  if (purpose === 'plan') {
    return `${intro}\nInspect the checkout as needed without editing. Write a plan with up to ${run.workerCount} independent tasks. `
      + 'Give workers distinct names, scopes, relevant files, and acceptance criteria. Separate write scopes by file. '
      + 'Return the assignments, a short summary, and project verification criteria using the required schema. '
      + 'The scheduler publishes the plan and activates the workers.' + messages;
  }
  if (purpose === 'verify') {
    const baseline = run.workspace?.base ?? 'the initial workspace';
    return `${intro}\nReview the actual combined work in this integration checkout against ${baseline}. `
      + 'Inspect the actual diff and run the relevant tests. Leave implementation edits to workers. '
      + 'If anything fails, give specific fixes under the original worker names so they can continue in their own threads. '
      + 'Pass only when the goal and checks are satisfied. '
      + `\nChecks: ${run.checks.join('\n') || 'Use the project’s relevant checks.'}` + messages;
  }
  if (member.role === 'coordinator') {
    return intro + '\nRespond only to substantive requests. Keep implementation with the workers and let the scheduler integrate the results.' + messages;
  }
  if (member.role === 'verifier') {
    return intro + '\nRespond directly to the delivered messages. Wait for the scheduler’s verification assignment before checking newly reported changes.' + messages;
  }
  return intro + `\nYour assignment:\n${member.task}\n\nWork in your assigned checkout and leave changes available there for integration. `
    + 'Report what changed, checks that ran, and anything blocked. Continue in place on follow-ups.' + messages;
}
