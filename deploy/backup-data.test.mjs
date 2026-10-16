import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { backupData } from './backup-data.mjs';

test('online snapshots include live WAL data, each user DB, work files and the matching key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'website-gen-backup-test-'));
  const source = join(root, 'source'), target = join(root, 'snapshot');
  mkdirSync(join(source, 'users', '1', 'work'), { recursive: true });
  mkdirSync(target);
  const admin = new DatabaseSync(join(source, 'admin.sqlite'));
  const user = new DatabaseSync(join(source, 'users', '1', 'website-gen.sqlite'));
  try {
    for (const db of [admin, user]) {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value); INSERT INTO proof VALUES('live-wal')");
    }
    const key = Buffer.alloc(32, 7).toString('base64');
    writeFileSync(join(source, 'master.key'), `${key}\n`);
    writeFileSync(join(source, 'users', '1', 'work', 'proof.txt'), 'work preserved');
    await backupData(source, target, '');
    for (const relative of ['admin.sqlite', join('users', '1', 'website-gen.sqlite')]) {
      const db = new DatabaseSync(join(target, relative), { readOnly: true });
      try { assert.equal(db.prepare('SELECT value FROM proof').get().value, 'live-wal'); }
      finally { db.close(); }
    }
    assert.equal(readFileSync(join(target, 'master.key'), 'utf8'), `${key}\n`);
    assert.equal(readFileSync(join(target, 'users', '1', 'work', 'proof.txt'), 'utf8'), 'work preserved');
    const overrideTarget = join(root, 'override');
    mkdirSync(overrideTarget);
    const override = Buffer.alloc(32, 9).toString('base64');
    await backupData(source, overrideTarget, override);
    assert.equal(readFileSync(join(overrideTarget, 'master.key'), 'utf8'), `${override}\n`);
  } finally {
    admin.close(); user.close();
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}website-gen-backup-test-`));
    rmSync(root, { recursive: true, force: true });
  }
});
