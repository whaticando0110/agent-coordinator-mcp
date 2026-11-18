import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createCoordinatorServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { restoreBackup, saveBackup } from '../data-tools.mjs';

const chatId = '00000000-0000-4000-8000-000000000001';
const model = { id: 'third-reviewer', name: 'Reviewer', app: 'stdio', appLabel: 'Third desktop', model: 'Example model' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-p1-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, closers };
}

test('a third MCP STDIO profile can own work and read its inbox without inheriting other agent permissions', async t => {
  const { directory, closers } = await fixture(t);
  const app = createCoordinatorServer({ directory, port: 0 });
  const { port } = await app.listen();
  closers.push(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const { token } = await fetch(base + '/api/state').then(r => r.json());
  const send = (route, payload, method = 'POST', auth = token) => fetch(base + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Coordinator-Token': auth }, body: JSON.stringify(payload) });
  assert.equal((await send('/api/agents', model, 'POST', 'wrong')).status, 403);
  assert.equal((await send('/api/agents', { ...model, id: 'user' })).status, 400);
  assert.equal((await send('/api/agents', model)).status, 201);
  assert.equal((await send('/api/agents', model)).status, 409);
  assert.equal((await send('/api/agents/codex', model, 'PATCH')).status, 400);
  assert.equal((await send('/api/wake/third-reviewer', { enabled: true, conversationId: chatId }, 'PATCH')).status, 404);
  const configurable = await fetch(base + '/api/agents/' + model.id).then(r => r.json());
  assert.equal(configurable.format, 'JSON');
  assert.deepEqual(configurable.args.slice(1, 3), ['--agent', model.id]);
  assert.equal((await send('/api/agents/' + model.id, { ...model, app: 'vscode' }, 'PATCH')).status, 200);
  const code = await fetch(base + '/api/agents/' + model.id).then(r => r.json());
  assert.equal(JSON.parse(code.snippet).servers[code.key].type, 'stdio');
  const own = app.store.createTask('user', { title: 'A third agent', owner: model.id });
  const privateTask = app.store.createTask('user', { title: 'Only Codex', owner: 'codex' });
  const client = new Client({ name: 'generic-host-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url)), '--agent', model.id, '--data-dir', directory], stderr: 'pipe' });
  closers.push(() => transport.close());
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const result = await call('coordinator_inbox', {});
  assert.deepEqual(result.structuredContent.messages.map(item => item.task_id), [own.id]);
  assert.equal((await call('coordinator_update_task', { taskId: privateTask.id, revision: 1, progress: 10 })).isError, true);
  assert.equal((await call('coordinator_update_task', { taskId: own.id, revision: 1, progress: 50 })).structuredContent.task.progress, 50);
  assert.equal((await call('coordinator_send_message', { taskId: own.id, recipient: 'antigravity', body: 'Ready' })).structuredContent.message.author, model.id);
  const support = await fetch(base + '/api/support').then(r => r.json());
  assert.equal(support.registeredAgents, 3);
  assert.doesNotMatch(JSON.stringify(support), /Example model|Third desktop|private|Only Codex|Ready|third-reviewer|token/i);
});

test('the wake queue links tasks, supports paging and cancellation, and cancels a retry after a late ACK', async t => {
  const { directory, closers } = await fixture(t);
  let at = 1000000;
  const store = openStore(directory, () => at);
  closers.push(() => store.close());
  store.setWakeTarget('codex', { enabled: true, conversationId: chatId });
  const task = store.createTask('user', { title: 'Review this', owner: 'codex' });
  at += 120001;
  const first = store.wakeJobs({ actor: 'codex', state: 'queued' }).jobs[0];
  assert.equal(first.task_id, task.id);
  assert.equal(first.overdue, true);
  assert.ok(first.message_id);
  store.finishWake(store.claimWake().ids, 'unknown');
  assert.equal(store.wakeJobs({ state: 'unknown' }).jobs[0].id, first.id);
  assert.throws(() => store.retryWake(first.id, false), /kiểm tra chat/i);
  const retry = store.retryWake(first.id, true);
  assert.equal(store.retryWake(first.id, true).id, retry.id);
  assert.equal(store.wakeJobs().jobs[0].retry_of, first.id);
  assert.equal(store.acknowledgeWake('codex', [first.id]).acknowledged, 1);
  assert.equal(store.wakeJobs({ state: 'cancelled' }).jobs[0].id, retry.id);
  assert.throws(() => store.cancelWake(first.id), /chỉ hủy/i);
  for (let i = 0; i < 51; i++) store.requestWake('codex', 'paging' + i);
  const page = store.wakeJobs({ state: 'queued' });
  assert.equal(page.jobs.length, 50);
  assert.equal(store.wakeJobs({ state: 'queued', before: page.next }).jobs.length, 1);
  store.cancelWake(page.jobs[0].id);
  assert.equal(store.wakeJobs({ state: 'queued' }).jobs.length, 50);
});

test('a live-store backup can restore into a new store with wake disabled and recover receipts and profiles', async t => {
  const { directory, closers } = await fixture(t);
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'restored');
  const file = path.join(directory, 'copy.sqlite');
  const store = openStore(source);
  closers.push(() => store.close());
  store.saveProfile(model.id, model, { create: true });
  const task = store.createTask('user', { title: 'Live snapshot', owner: model.id });
  const message = store.messages(model.id)[0];
  store.markRead(model.id, [message.id]);
  store.setWakeTarget('codex', { enabled: true, conversationId: chatId });
  store.requestWake('codex', 'sending');
  const sending = store.claimWake().ids[0];
  store.requestWake('codex', 'queued');
  await saveBackup(source, file);
  await assert.rejects(saveBackup(source, file), { code: 'EEXIST' });
  await restoreBackup(file, target);
  await assert.rejects(restoreBackup(file, target), { code: 'EEXIST' });
  const restored = openStore(target);
  closers.push(() => restored.close());
  assert.equal(store.wakeState().targets[0].enabled, 1);
  assert.equal(store.wakeState().jobs[0].state, 'queued');
  assert.equal(restored.wakeState().targets[0].enabled, 0);
  assert.equal(restored.wakeJobs({ state: 'unknown' }).jobs[0].id, sending);
  assert.equal(restored.wakeJobs({ state: 'queued' }).jobs.length, 0);
  assert.equal(restored.claimWake(), null);
  assert.equal(restored.task(task.id).title, 'Live snapshot');
  assert.equal(restored.messages(model.id)[0].read_at, store.messages(model.id)[0].read_at);
  assert.equal(restored.profile(model.id).model, model.model);
  const broken = path.join(directory, 'broken.sqlite'), unused = path.join(directory, 'unused');
  await writeFile(broken, 'not a database');
  await assert.rejects(restoreBackup(broken, unused));
  await assert.rejects(stat(unused), { code: 'ENOENT' });
});

test('upgrading a v1 database keeps task UUIDs, inbox links and history before assigning new agents', async t => {
  const { directory, closers } = await fixture(t);
  const db = new DatabaseSync(path.join(directory, 'coordinator.sqlite'));
  try {
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,details TEXT,owner TEXT CHECK(owner IN ('codex','antigravity')),
      status TEXT,progress INTEGER,note TEXT,link TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,revision INTEGER,request_key TEXT UNIQUE);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL,recipient TEXT NOT NULL,body TEXT NOT NULL,task_id TEXT REFERENCES tasks(id),created_at INTEGER NOT NULL,request_key TEXT UNIQUE);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT REFERENCES tasks(id),actor TEXT,body TEXT,created_at INTEGER);
      INSERT INTO tasks VALUES('fixture','Old task','','codex','queued',0,'','','user',1,1,1,NULL);
      INSERT INTO messages VALUES(42,'user','codex','Old message','fixture',1,NULL);
      INSERT INTO events VALUES(43,'fixture','user','created',1);
      PRAGMA user_version=1;`);
  } finally { db.close(); }
  const store = openStore(directory);
  closers.push(() => store.close());
  assert.equal(store.detail('codex', 'fixture').messages[0].id, 42);
  assert.equal(store.detail('codex', 'fixture').events[0].id, 43);
  store.saveProfile(model.id, model, { create: true });
  assert.equal(store.createTask('user', { title: 'New owner', owner: model.id }).owner, model.id);
});
