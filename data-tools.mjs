import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from './config.mjs';
import { openStore } from './store.mjs';

const filename = 'coordinator.sqlite';
const openDb = (file, readOnly = false) => {
  const db = new DatabaseSync(file, { readOnly, timeout: 5000 });
  db.exec('PRAGMA trusted_schema=OFF;');
  return db;
};

function verify(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
  const required = ['tasks','messages','receipts','events','wake_targets','wake_jobs','presence'];
  if (![1, 2].includes(version) || required.some(name => !names.includes(name)) || (version === 2 && !names.includes('agent_profiles')))
    throw new Error('Tệp không phải kho SQLite của Agent Coordinator.');
  const unexpected = db.prepare("SELECT name FROM sqlite_schema WHERE type='view' OR (type='trigger' AND name<>'coordinator_wake_message')").get();
  if (unexpected) throw new Error('Kho SQLite có đối tượng không thuộc cấu trúc hỗ trợ.');
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
    throw new Error('Kho SQLite không qua kiểm tra toàn vẹn.');
}

async function clearDatabase(directory) {
  for (const tail of ['', '-wal', '-shm', '-journal']) await rm(path.join(directory, filename + tail), { force: true });
  await rmdir(directory);
}

// The SQLite backup API reads a consistent image even while another process holds the source open.
async function copyDatabase(source, destination) {
  const original = openDb(source, true);
  try {
    verify(original);
    // Reserve the destination in a directory owned by this operation, with restrictive permissions.
    await (await open(destination, 'wx', 0o600)).close();
    await backup(original, destination);
    const copy = openDb(destination);
    try { copy.exec('PRAGMA journal_mode=DELETE;'); verify(copy); }
    finally { copy.close(); }
  } finally { original.close(); }
}

export async function saveBackup(directory, target) {
  target = path.resolve(target);
  const staging = await mkdtemp(path.join(path.dirname(target), '.coordinator-backup-'));
  try {
    const staged = path.join(staging, filename);
    await copyDatabase(path.join(directory, filename), staged);
    await copyFile(staged, target, constants.COPYFILE_EXCL);
    return target;
  } finally { await clearDatabase(staging); }
}

export async function restoreBackup(source, directory) {
  directory = path.resolve(directory);
  await mkdir(directory, { mode: 0o700 }); // A pre-existing directory is never a restore target.
  const target = path.join(directory, filename);
  try {
    await copyDatabase(path.resolve(source), target);
    const db = openDb(target);
    try {
      db.exec(`BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS coordinator_wake_message;
        UPDATE wake_targets SET enabled=0;
        UPDATE wake_jobs SET state='cancelled',error='Hủy khi phục hồi kho' WHERE state='queued';
        UPDATE wake_jobs SET state='unknown',error='Lượt gửi dở ở thời điểm sao lưu; kiểm tra chat' WHERE state='sending';
        DELETE FROM presence;
        COMMIT;`);
      verify(db);
    } finally { db.close(); }
    // Reinstall the canonical trigger and upgrade an older snapshot in the new directory only.
    openStore(directory).close();
    return directory;
  } catch (error) {
    await clearDatabase(directory);
    throw error;
  }
}

async function main() {
  const [mode, first, second, ...rest] = process.argv.slice(2);
  if (rest.length || (mode === 'backup' && (!first || second)) || (mode === 'restore' && (!first || !second)) || !['backup','restore'].includes(mode))
    throw new Error('Dùng npm run backup -- <file.sqlite> hoặc npm run restore -- <file.sqlite> <thư mục mới>.');
  if (mode === 'backup') console.log('Đã kiểm và lưu snapshot:', await saveBackup(dataDirectory(), first));
  else console.log('Đã phục hồi vào kho riêng; đánh thức đang tắt:', await restoreBackup(first, second));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
