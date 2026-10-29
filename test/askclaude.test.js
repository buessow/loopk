import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINK, claudeLink, claudePrompt } from '../public/askclaude.js';

const HOUR = 3600000;
const from = Date.UTC(2026, 9, 22, 12, 5);
const to = from + 3 * HOUR;
const prompt = claudePrompt({ from, to, note: 'pizza at 15:00, not logged', units: 'mmol/L', origin: 'https://loopk.example', offsetMinutes: 120 });

test('the prompt names the period in local time, with a link to it on loopk', () => {
  assert.match(prompt, /from 2026-10-22T14:05\+02:00 to 2026-10-22T17:05\+02:00/);
  assert.match(prompt, /https:\/\/loopk\.example\/\?start=2026-10-22T13:35%2B02:00&duration=4h/);
  assert.match(prompt, /pizza at 15:00, not logged/);
});

test('the prompt has Claude fetch the data through the MCP tools, from before to after the period', () => {
  for (const tool of ['get_algorithm_guide', 'get_glucose', 'get_treatments', 'get_loop_runs', 'get_profile', 'simulate_run', 'simulate_period']) {
    assert.ok(prompt.includes(tool), tool);
  }
  assert.match(prompt, /from 2026-10-22T08:05\+02:00 .* to 2026-10-22T20:05\+02:00/);
  assert.match(prompt, /glucose in mmol\/L/);
});

test('without a note the prompt has no question line', () => {
  assert.doesNotMatch(claudePrompt({ from, to, offsetMinutes: 0 }), /What I'd like to know/);
});

test('the prompt opens in claude.ai unless it is too long for a link', () => {
  assert.equal(claudeLink('Hi there'), 'https://claude.ai/new?q=Hi%20there');
  assert.ok(claudeLink(prompt).length <= MAX_LINK);
  assert.equal(claudeLink('x'.repeat(MAX_LINK)), null);
});
