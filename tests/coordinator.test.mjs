import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { openStore } from '../store.mjs';
import { createCoordinatorServer } from '../server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-coordinator-test-'));
  const stores = [];
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    for (const store of stores) store.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, cleanup, open() { const store = openStore(directory); stores.push(store); return store; } };
}

test('two app connections share durable assignments, reject lost updates and keep progress history', async t => {
  const f = await fixture(t), user = f.open(), codex = f.open(), antigravity = f.open();
  const input = { title: 'Review cutover', owner: 'codex', requestId: 'create-1' };
  const task = user.createTask('user', input);
  assert.equal(codex.listTasks({ owner: 'codex' })[0].id, task.id);
  assert.equal(user.createTask('user', input).id, task.id);
  assert.equal(user.messages('user').length, 1);
  assert.throws(() => user.createTask('user', { ...input, title: 'Changed' }), /Mã yêu cầu/);
  assert.throws(() => antigravity.updateTask('antigravity', task.id, { revision: 1, status: 'done', progress: 100 }), /phụ trách/);
  const changed = codex.updateTask('codex', task.id, { revision: 1, status: 'in_progress', progress: 45, note: 'Đã đọc diff' });
  assert.equal(changed.revision, 2);
  assert.throws(() => user.updateTask('user', task.id, { revision: 1, progress: 10 }), /vừa được cập nhật/);
  assert.throws(() => codex.updateTask('codex', task.id, { revision: 2, status: 'done' }), /100%/);
  assert.throws(() => codex.updateTask('codex', task.id, { revision: 2, link: 'javascript:alert(1)' }), /http/);
  assert.equal(antigravity.task(task.id).progress, 45);
  assert.equal(user.detail('user', task.id).events.length, 2);
  user.close(); codex.close(); antigravity.close();
  const restarted = f.open();
  assert.equal(restarted.task(task.id).note, 'Đã đọc diff');
});

test('direct inboxes and read receipts stay separate, with atomic acknowledgements and retry-safe messages', async t => {
  const f = await fixture(t), store = f.open();
  const direct = store.sendMessage('user', { recipient: 'codex', body: 'Yêu cầu riêng' });
  const shared = store.sendMessage('codex', { recipient: 'all', body: 'Đang review', requestId: 'message-1' });
  assert.equal(store.sendMessage('codex', { recipient: 'all', body: 'Đang review', requestId: 'message-1' }).id, shared.id);
  assert.equal(store.messages('antigravity').length, 1);
  assert.equal(store.messages('codex').length, 2);
  assert.equal(store.messages('user').length, 2);
  store.markRead('user', [direct.id, shared.id]);
  assert.equal(store.messages('codex').find(message => message.id === direct.id).read_at, null);
  assert.throws(() => store.markRead('antigravity', [shared.id, direct.id]), /Không thể/);
  assert.equal(store.messages('antigravity')[0].read_at, null);
  store.markRead('antigravity', [shared.id]);
  assert.ok(store.messages('antigravity')[0].read_at);
  assert.equal(store.board().agents.find(agent => agent.actor === 'antigravity').unread, 0);
  assert.equal(store.messages('codex', { before: shared.id })[0].id, direct.id);
});

test('HTTP entry point serves the dashboard and enforces local origin and mutation tokens', async t => {
  const f = await fixture(t);
  const app = createCoordinatorServer({ directory: f.directory, port: 0 });
  await app.listen();
  f.cleanup.push(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await fetch(url + '/api/state').then(response => response.json());
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Trạm phối hợp/);
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const post = (token, body) => fetch(url + '/api/tasks', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Coordinator-Token': token, Origin: url
  }, body: JSON.stringify(body) });
  assert.equal((await post('wrong', { title: 'Wrong', owner: 'codex' })).status, 403);
  assert.equal(initial.demo, null);
  const demo = await fetch(url + '/api/demo/advance', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Coordinator-Token': initial.token }, body: '{"step":0}' });
  assert.equal(demo.status, 404);
  const created = await post(initial.token, { title: 'Việc từ giao diện', details: 'Giữ tiếng Việt', owner: 'antigravity' });
  assert.equal(created.status, 201);
  const task = (await created.json()).task;
  const store = f.open();
  assert.equal(store.task(task.id).details, 'Giữ tiếng Việt');
  assert.equal((await fetch(url + `/api/tasks/${task.id}`).then(response => response.json())).task.owner, 'antigravity');
});

test('two real stdio MCP clients receive their work, exchange messages and update the shared board', async t => {
  const f = await fixture(t), store = f.open();
  const task = store.createTask('user', { title: 'Kiểm hộp thư MCP', owner: 'codex' });
  async function connect(actor) {
    const client = new Client({ name: `test-${actor}`, version: '1.0.0' });
    f.cleanup.push(() => client.close());
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url)), '--agent', actor, '--data-dir', f.directory], stderr: 'pipe' });
    await client.connect(transport);
    return client;
  }
  const [codex, antigravity] = await Promise.all([connect('codex'), connect('antigravity')]);
  const tools = await codex.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'coordinator_update_task'));
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, body: result.structuredContent ?? JSON.parse(result.content[0].text) };
  };
  assert.equal((await call(codex, 'coordinator_inbox', {})).body.messages[0].task_id, task.id);
  store.setWakeTarget('codex', { conversationId: task.id, enabled: true });
  store.requestWake('codex', 'mcp-ack');
  const wake = store.claimWake();
  store.finishWake(wake.ids, 'accepted');
  assert.equal((await call(antigravity, 'coordinator_ack_wake', { ids: wake.ids })).body.acknowledged, 0);
  assert.equal((await call(codex, 'coordinator_ack_wake', { ids: wake.ids })).body.acknowledged, 1);
  const rejected = await antigravity.callTool({ name: 'coordinator_update_task', arguments: { taskId: task.id, revision: 1, progress: 30 } });
  assert.equal(rejected.isError, true);
  await call(codex, 'coordinator_update_task', { taskId: task.id, revision: 1, progress: 80, status: 'review', note: 'Nhờ review' });
  await call(codex, 'coordinator_send_message', { recipient: 'antigravity', body: 'Nhờ kiểm bản sửa', taskId: task.id });
  const inbox = (await call(antigravity, 'coordinator_inbox', {})).body.messages;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'codex');
  await call(antigravity, 'coordinator_mark_read', { ids: [inbox[0].id] });
  assert.equal(store.task(task.id).progress, 80);
  assert.ok(store.board().agents.every(agent => agent.lastSeen));
});

test('stdio also accepts the initialization protocol used by older MCP desktop clients', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp.mjs', import.meta.url)),
    '--agent', 'antigravity', '--data-dir', f.directory], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const done = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  f.cleanup.push(async () => { child.kill(); await done; lines.close(); });
  const pending = new Map();
  let id = 0;
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const request = (method, params) => new Promise(resolve => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-desktop', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await request('tools/list', {});
  assert.equal(tools.result.tools.length, 9);
  const inbox = await request('tools/call', { name: 'coordinator_inbox', arguments: {} });
  assert.equal(inbox.result.isError, undefined);
  assert.equal(JSON.parse(inbox.result.content[0].text).actor, 'antigravity');
});
