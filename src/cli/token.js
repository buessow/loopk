// Manage access tokens from the command line, e.g. to create the first token
// for AAPS before anyone has signed in to the web UI.
//
//   npm run token -- create <name> [read|readwrite|model]   (default: readwrite, as AAPS needs;
//                                                     model: may only upload prediction models)
//   npm run token -- list
//   npm run token -- delete <name>
import { loadConfig } from '../config.js';
import { createPool } from '../db/index.js';
import { Auth } from '../auth/index.js';

const [cmd, name, access = 'readwrite'] = process.argv.slice(2);
const describe = (s) => `${s.name} [${s.can_upload_model ? 'upload model' : s.can_write ? 'read/write' : 'read'}]: ${s.access_token}`;
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const auth = new Auth(pool, config);

try {
  await auth.init();
  if (cmd === 'create' && name && ['read', 'readwrite', 'model'].includes(access)) {
    console.log(describe(await auth.createSubject({ name, canWrite: access === 'readwrite', canUploadModel: access === 'model' })));
  } else if (cmd === 'list') {
    for (const s of auth.subjects) console.log(describe(s));
  } else if (cmd === 'delete' && name) {
    const s = auth.subjects.find((x) => x.name === name);
    console.log(s && await auth.deleteSubject(s.id) ? `Deleted ${name}` : `No token named ${name}`);
  } else {
    console.log('Usage: npm run token -- create <name> [read|readwrite|model] | list | delete <name>');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
