// How AAPS doses, for agents (the MCP tool get_algorithm_guide), and how the
// MCP tools read loop runs (runs.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** How AAPS doses (docs/aaps-algorithms.md), in Markdown. */
export const GUIDE = fs.readFileSync(path.join(root, 'docs', 'aaps-algorithms.md'), 'utf8');

export { algorithmPeriods, uniqueRuns } from './runs.js';
