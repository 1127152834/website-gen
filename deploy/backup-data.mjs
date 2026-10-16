// Run ONLY by backup.sh in an isolated Node 24 container, not on the host.
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function backupData(source = '/source', target = '/backup', override = process.env.WEBSITE_GEN_MASTER_KEY) {
  async function snapshot(relative) {
    const from = join(source, relative), to = join(target, relative);
    if (!lstatSync(from).isFile()) throw new Error('Database must be a regular file');
    mkdirSync(join(to, '..'), { recursive: true });
    const db = new DatabaseSync(from, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=30000');
      await backup(db, to);
    } finally { db.close(); }
    const check = new DatabaseSync(to, { readOnly: true });
    try {
      const rows = check.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('Backup integrity check failed');
    } finally { check.close(); }
    chmodSync(to, 0o600);
    console.log(`SQLite backup verified: ${relative}`);
  }

  await snapshot('admin.sqlite');
  mkdirSync(join(target, 'users'), { recursive: true });
  if (existsSync(join(source, 'users'))) {
    for (const entry of readdirSync(join(source, 'users'), { withFileTypes: true })) {
      // Ignore staging/rollback directories; user IDs are positive integers.
      if (!/^[1-9]\d*$/.test(entry.name)) continue;
      if (!entry.isDirectory()) throw new Error('User directory must not be a symlink');
      const user = join('users', entry.name);
      if (existsSync(join(source, user, 'website-gen.sqlite'))) await snapshot(join(user, 'website-gen.sqlite'));
      for (const name of ['pi', 'work']) {
        const from = join(source, user, name);
        if (existsSync(from)) {
          if (!lstatSync(from).isDirectory()) throw new Error('User files must be a directory');
          cpSync(from, join(target, user, name), { recursive: true, dereference: false });
        }
      }
    }
  }

  if (override) {
    const key = Buffer.from(override.trim(), 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== override.trim().replace(/=+$/, '')) throw new Error('Invalid master key override');
    writeFileSync(join(target, 'master.key'), `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    key.fill(0);
  } else {
    if (!lstatSync(join(source, 'master.key')).isFile()) throw new Error('Missing regular master.key');
    cpSync(join(source, 'master.key'), join(target, 'master.key'), { errorOnExist: true, force: false });
    chmodSync(join(target, 'master.key'), 0o600);
  }
  console.log('Master key included (not printed).');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await backupData();
