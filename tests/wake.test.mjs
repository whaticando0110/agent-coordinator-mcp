import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { commandFor, dispatchOnce, execute } from '../wake-worker.mjs';
import { createCoordinatorServer } from '../server.mjs';

const codexId = '00000000-0000-4000-8000-000000000001';
const agId = '00000000-0000-4000-8000-000000000002';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-wake-'));
  let clock = 1000000;
  const store = openStore(directory, () => clock);
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); store.close(); assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, cleanup, now: () => clock, advance(ms) { clock += ms; } };
}
function enable(store, actor = 'codex', conversationId = codexId) { store.setWakeTarget(actor, { conversationId, enabled: true }); }

test('wake is opt-in; atomic creation and message retries create one request, with no self-wake', async t => {
  const { store } = await fixture(t);
  store.sendMessage('user', { recipient: 'codex', body: 'Before enable' });
  assert.equal(store.wakeState().jobs.length, 0);
  assert.throws(() => store.setWakeTarget('codex', { conversationId: '--flags', enabled: true }), /UUID/);
  enable(store); enable(store, 'antigravity', agId);
  const input = { title: 'Task', owner: 'codex', requestId: 'idempotent' };
  store.createTask('user', input); store.createTask('user', input);
  const message = { recipient: 'all', body: 'Shared', requestId: 'idempotent' };
  store.sendMessage('codex', message); store.sendMessage('codex', message);
  assert.equal(store.wakeState().jobs.length, 2);
  assert.deepEqual(store.wakeState().jobs.map(row => row.actor).sort(), ['antigravity', 'codex']);
  assert.throws(() => store.sendMessage('user', { recipient: 'codex', body: 'x', taskId: 'missing' }));
  assert.equal(store.wakeState().jobs.length, 2);
});

test('already-connected older MCP processes also enqueue through the database transaction', async t => {
  const { store, directory } = await fixture(t); enable(store);
  const legacy = new DatabaseSync(path.join(directory, 'coordinator.sqlite'));
  try {
    legacy.exec('BEGIN IMMEDIATE');
    legacy.prepare('INSERT INTO messages(author,recipient,body,created_at) VALUES(?,?,?,?)').run('antigravity', 'codex', 'Old MCP writer', Date.now());
    legacy.exec('ROLLBACK');
    assert.equal(store.wakeState().jobs.length, 0);
    legacy.prepare('INSERT INTO messages(author,recipient,body,created_at) VALUES(?,?,?,?)').run('antigravity', 'codex', 'Old MCP writer', Date.now());
    assert.equal(store.wakeState().jobs.length, 1);
  } finally { legacy.close(); }
});

test('concurrent stores claim once, coalesce, preserve queued work and isolate ACK identities', async t => {
  const { store, directory, advance, now } = await fixture(t); enable(store);
  store.requestWake('codex', 'one'); store.requestWake('codex', 'two');
  const second = openStore(directory, now);
  try {
    const job = store.claimWake(); assert.equal(job.ids.length, 2);
    assert.equal(second.claimWake(), null);
    assert.equal(second.acknowledgeWake('antigravity', job.ids).acknowledged, 0);
    store.finishWake(job.ids, 'accepted');
    assert.equal(second.acknowledgeWake('codex', job.ids).acknowledged, 2);
    assert.equal(second.acknowledgeWake('codex', job.ids).acknowledged, 0);
    second.requestWake('codex', 'three'); assert.equal(second.claimWake(), null);
    advance(30001); assert.ok(second.claimWake());
  } finally { second.close(); }
});

test('changing or disabling bindings cancels pending requests; crashes never silently resend', async t => {
  const { store, directory, advance, now } = await fixture(t); enable(store);
  store.requestWake('codex', 'old'); enable(store, 'codex', agId);
  assert.equal(store.wakeState().jobs[0].state, 'cancelled');
  store.requestWake('codex', 'crash'); const job = store.claimWake();
  const reopened = openStore(directory, now);
  try {
    advance(120001); assert.equal(reopened.claimWake(), null);
    assert.equal(reopened.wakeState().jobs.find(row => row.id === job.id).state, 'unknown');
    reopened.setWakeTarget('codex', { conversationId: agId, enabled: false });
    assert.throws(() => reopened.requestWake('codex'), /Chưa bật/);
  } finally { reopened.close(); }
});

test('worker keeps prompts as literal argv, reports missing bridges and limits automatic wake storms', async t => {
  const { store, advance } = await fixture(t); enable(store);
  const config = { codex: { executable: process.execPath } };
  const command = commandFor({ actor: 'codex', conversation_id: codexId, ids: [1] }, config);
  assert.deepEqual(command.args.slice(0, 4), ['queue', '--thread', codexId, '--message']);
  assert.match(command.args[4], /coordinator_ack_wake/);
  assert.equal(command.args.length, 5);
  assert.equal(commandFor({ actor: 'codex', conversation_id: codexId, ids: [1] }, { codex: { executable: process.execPath, resume: true } }).args[5], '--resume');
  assert.throws(() => commandFor({ actor: 'codex' }, { codex: { executable: 'bridge.cmd' } }), /executable/);
  for (let i = 0; i < 10; i++) {
    store.requestWake('codex', String(i));
    const result = await dispatchOnce(store, config, async () => ({ state: 'accepted', error: '' }));
    assert.equal(result.state, 'accepted'); advance(30001);
  }
  store.requestWake('codex', 'capped'); assert.equal(store.claimWake(), null);
  advance(3600001);
  assert.equal((await dispatchOnce(store, {})).state, 'failed');
});

test('native process errors include JSON errors even with exit zero', async () => {
  assert.equal((await execute({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({error:"missing bridge env"}))'] })).state, 'failed');
  assert.equal((await execute({ executable: process.execPath, args: ['-e', 'process.exit(2)'] })).state, 'unknown');
  assert.equal((await execute({ executable: process.execPath, args: ['-e', 'console.log("ok")'] })).state, 'accepted');
  assert.equal((await execute({ executable: process.execPath, args: ['-e', 'console.error("warning: failed to resume thread")'] })).state, 'unknown');
});

test('wake settings require dashboard token and never expose command execution through HTTP', async t => {
  const { directory, cleanup } = await fixture(t);
  const app = createCoordinatorServer({ directory, port: 0 }); await app.listen();
  cleanup.push(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await fetch(base + '/api/state').then(r => r.json());
  const write = (method, body, auth = token) => fetch(base + '/api/wake/codex', { method, headers: { 'Content-Type': 'application/json', 'X-Coordinator-Token': auth }, body: JSON.stringify(body) });
  assert.equal((await write('PATCH', { conversationId: codexId, enabled: true }, 'wrong')).status, 403);
  assert.equal((await write('PATCH', { conversationId: codexId, enabled: true, executable: 'malicious' })).status, 200);
  assert.equal((await write('POST', {})).status, 202);
  const { wake } = await fetch(base + '/api/state').then(r => r.json());
  assert.equal(wake.targets[0].conversation_id, codexId);
  assert.equal(wake.targets[0].executable, undefined);
  assert.equal(wake.jobs.length, 1);
});
