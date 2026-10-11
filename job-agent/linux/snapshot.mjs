// Consistent copy of a live SQLite database (VACUUM INTO), switched to rollback-journal mode so a reader
// on the phone needs no -wal/-shm files. Usage: node linux/snapshot.mjs <live.db> <copy.db>
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
rmSync(out, { force: true });
const live = new DatabaseSync(src, { readOnly: true });
live.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
live.close();
const copy = new DatabaseSync(out);
copy.exec('PRAGMA journal_mode = DELETE');
copy.close();
