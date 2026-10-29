// "AI Prompt" on the glucose page: a prompt for Claude about a period the
// person selected, with what they add about it, that has Claude fetch the
// records itself through loopk's MCP tools (src/mcp/server.js). The person
// copies it, or opens it in claude.ai, where the loopk connector must be
// added (Access page, "Agents (MCP)").

import { formatStart, viewSearch } from './view.js';

const MIN = 60000;
const HOUR = 60 * MIN;
// Insulin given up to this long before the period still acts in it.
export const BEFORE = 6 * HOUR;
// Long enough to see where glucose went after the period's decisions.
export const AFTER = 3 * HOUR;
// claude.ai's address for a new chat with a prompt filled in.
const CLAUDE_NEW = 'https://claude.ai/new?q=';
// Longer prompts don't fit in a link reliably: they are copied instead.
export const MAX_LINK = 8000;

/**
 * The prompt for the period from..to (ms): `note` is what the person adds
 * (may be empty), `units` the glucose unit they read, `origin` loopk's
 * address for the link to the period, `offsetMinutes` the offset to write
 * times with (default the browser's).
 */
export function claudePrompt ({ from, to, note = '', units = 'mmol/L', origin = '', offsetMinutes }) {
  const at = (t) => formatStart(t, offsetMinutes ?? -new Date(t).getTimezoneOffset());
  const link = origin && `${origin}/${viewSearch({ start: from - 30 * MIN, duration: to - from + HOUR }, { offsetMinutes })}`;
  const lines = [
    `Please review what my AAPS closed loop did from ${at(from)} to ${at(to)}${link ? ` (on loopk: ${link})` : ''}.`,
  ];
  if (note.trim()) lines.push('', `What I'd like to know, or what you should know: ${note.trim()}`);
  lines.push(
    '',
    `Use the loopk MCP tools for the data; don't guess what they can tell you. Read get_algorithm_guide first. Then fetch from ${at(from - BEFORE)} (insulin and carbs still acting) to ${at(to + AFTER)} (what came of the decisions): get_glucose, get_treatments, get_loop_runs (the algorithm's reason, IOB, COB and predictions at each run) and get_profile; get_heart_rate where exercise may matter, and get_misses for the misses loopk found. To check whether another setting would have changed a decision, use simulate_run (exact for one decision); for what glucose would have done, simulate_period (an estimate with a band).`,
    '',
    'Judge each important decision by what the loop knew at the time and by what happened afterwards: did it act about right, over-correct (too much insulin: a low, a fast drop, carbs needed) or under-correct (too little or too late), and why? Separate what the loop could not know (unlogged carbs, exercise, a sensor or site problem) from what its settings or algorithm caused. Where the data does not show something, say so.',
    '',
    `Answer with: a one-line verdict ("About right", "Over-corrected", "Under-corrected" or "Mixed"); a few sentences in plain words, for someone who uses the loop but not its jargon; the key moments with times; the mechanisms behind them; and the settings to look at, with how sure you are, or that nothing should change. Give glucose in ${units}, and link the moments you discuss to loopk's glucose page.`,
  );
  return lines.join('\n');
}

/** The claude.ai link that opens a new chat with the prompt, or null if it is too long for a link. */
export function claudeLink (prompt) {
  const url = CLAUDE_NEW + encodeURIComponent(prompt);
  return url.length <= MAX_LINK ? url : null;
}
