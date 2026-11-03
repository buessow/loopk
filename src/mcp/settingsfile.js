// loopk's settings for an agent's own MCP over Nightscout (local.js): the
// settings document (src/data/nightscout/settings.js) in a JSON file, the
// one "Export settings" writes in the browser. Read at each use, so a file
// copied in while the agent runs is used; written whole, through a file
// beside it, so a reader never sees half of it.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { documentSettings, settingsDocument } from '../data/nightscout/settings.js';

/** Where the settings are kept unless LOOPK_SETTINGS says otherwise. */
export const defaultSettingsFile = () => path.join(os.homedir(), '.config', 'loopk', 'settings.json');

/** The settings stores over the JSON file `file` (none there yet: no settings). */
export function fileSettings (file) {
  return documentSettings({
    async load () {
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      try {
        return settingsDocument(JSON.parse(text));
      } catch (err) {
        throw Object.assign(new Error(`${file}: ${err.message}`), { status: 400, expose: true });
      }
    },
    async save (doc) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const next = `${file}.${process.pid}.tmp`;
      await fs.writeFile(next, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(next, file);
    },
  });
}
