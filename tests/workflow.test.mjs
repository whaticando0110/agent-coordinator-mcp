import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { workspaceDirectory } from '../config.mjs';
import { createCoordinatorServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { execute } from '../wake-worker.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-workflow-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, closers };
}
async function stdio(actor, directory, closers) {
  const mcp = new Client({ name: 'workflow-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, stderr: 'pipe',
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url)), '--agent', actor, '--data-dir', directory] });
  closers.push(() => transport.close());
  await mcp.connect(transport);
  return (name, args) => mcp.callTool({ name, arguments: args });
}
const target = '00000000-0000-4000-8000-000000000011';
const opencode = { name: 'Reader', model: 'host-default', app: 'opencode' };

test('two real MCP clients can hand off, request changes and recommend, while final approval stays with the dashboard', async t => {
  const { directory, closers } = await fixture(t);
  const store = openStore(directory); closers.push(() => store.close());
  const task = store.createTask('user', { title: 'Review candidate', owner: 'codex' });
  store.configureReview(task.id, { revision: 1, reviewer: 'antigravity', criteria: 'Build and test on mobile' });
  const [codex, antigravity] = await Promise.all(['codex', 'antigravity'].map(actor => stdio(actor, directory, closers)));
  assert.equal((await codex('coordinator_update_task', { taskId: task.id, revision: 2, status: 'done', progress: 100 })).isError, true);
  const step = (agent, action, revision, note) => agent('coordinator_review_task', { taskId: task.id, action, revision, note });
  assert.equal((await step(antigravity, 'submit', 2)).isError, true);
  assert.equal((await step(codex, 'submit', 2)).structuredContent.review.stage, 'review');
  assert.match(store.messages('antigravity')[0].body, /Đã gửi review/);
  assert.equal((await step(antigravity, 'changes', 3)).isError, true);
  assert.equal((await step(antigravity, 'changes', 3, 'Check mobile')).structuredContent.review.stage, 'work');
  assert.equal((await step(codex, 'submit', 4, 'Updated')).structuredContent.review.stage, 'review');
  assert.equal((await step(antigravity, 'recommend', 5)).structuredContent.review.stage, 'approval');
  assert.equal((await step(antigravity, 'approve', 6)).isError, true);
  assert.throws(() => store.advanceReview('antigravity', task.id, { action: 'approve', revision: 6 }), /chỉ người/i);
  const result = store.advanceReview('user', task.id, { action: 'approve', revision: 6 });
  assert.equal(result.task.progress, 100);
  assert.equal(result.review.stage, 'approved');
  assert.equal(store.detail('user', task.id).events.length, 7);
});

test('pausing stops new work and wake, transfer keeps IDs and history, and archiving waits for handoff', async t => {
  const { directory, closers } = await fixture(t);
  const store = openStore(directory); closers.push(() => store.close());
  store.setWakeTarget('codex', { conversationId: target, enabled: true });
  const input = { title: 'Hand this off', owner: 'codex', requestId: 'unique' };
  const task = store.createTask('user', input);
  assert.throws(() => store.setProfileState('codex', 'archived'), /chuyển công việc/i);
  const moved = store.createTask('user', { title: 'Move without pausing', owner: 'codex' });
  store.transferTask(moved.id, { owner: 'antigravity', revision: moved.revision });
  assert.equal(store.wakeJobs({ actor: 'codex', state: 'cancelled' }).jobs[0].task_id, moved.id);
  store.setProfileState('codex', 'paused');
  assert.equal(store.wakeJobs({ state: 'cancelled' }).jobs.length, 2);
  assert.throws(() => store.createTask('user', { title: 'New', owner: 'codex' }), /tạm ngưng/i);
  assert.throws(() => store.updateTask('codex', task.id, { progress: 50, revision: 1 }), /tạm ngưng/i);
  assert.equal(store.transferTask(task.id, { owner: 'antigravity', revision: 1 }).id, task.id);
  assert.equal(store.createTask('user', input).owner, 'antigravity');
  assert.equal(store.setProfileState('codex', 'archived').state, 'archived');
  assert.equal(store.detail('codex', task.id).messages.length, 1);
  assert.equal(store.detail('user', task.id).events.length, 2);
  assert.equal(store.setProfileState('codex', 'active').state, 'active');
  assert.equal(store.wakeState().targets[0].enabled, 0);
});

test('workspaces isolate tasks, inboxes, profiles, MCP keys and wake targets', async t => {
  const { directory, closers } = await fixture(t);
  const app = createCoordinatorServer({ directory, port: 0 });
  const { port } = await app.listen(); closers.push(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const read = (route, id = 'local') => fetch(base + route, { headers: { 'X-Coordinator-Workspace': id } });
  const { token } = await (await read('/api/state')).json();
  const send = (method, route, body, id = 'local') => fetch(base + route, { method, headers: {
    'Content-Type': 'application/json', 'X-Coordinator-Token': token, 'X-Coordinator-Workspace': id
  }, body: JSON.stringify(body) });
  assert.equal((await send('POST', '/api/workspaces', { id: '../outside', name: 'Unsafe' })).status, 400);
  assert.equal((await send('POST', '/api/workspaces', { id: 'game-demo', name: 'Game demo' })).status, 201);
  assert.equal((await send('POST', '/api/workspaces', { id: 'mcp-tool', name: 'MCP tool' })).status, 201);
  const first = await (await send('POST', '/api/tasks', { title: 'Private game job', owner: 'codex' }, 'game-demo')).json();
  assert.equal((await read('/api/tasks/' + first.task.id, 'mcp-tool')).status, 404);
  assert.equal((await (await read('/api/messages', 'mcp-tool')).json()).messages.length, 0);
  const keys = await Promise.all(['local','game-demo','mcp-tool'].map(async id => (await (await read('/api/agents/codex', id)).json()).key));
  assert.equal(new Set(keys).size, 3);
  const codex = await stdio('codex', workspaceDirectory(directory, 'mcp-tool'), closers);
  assert.deepEqual((await codex('coordinator_list_tasks', {})).structuredContent.tasks, []);
  assert.equal((await send('PATCH', '/api/wake/codex', { enabled: true, conversationId: target }, 'game-demo')).status, 200);
  assert.equal((await send('PATCH', '/api/wake/antigravity', { enabled: true, conversationId: target }, 'mcp-tool')).status, 409);
  assert.equal((await (await read('/api/state', 'mcp-tool')).json()).wake.targets.length, 0);
});

test('the standalone worker delivers only to configured local OpenCode 2 sessions and leaves ACK to MCP', async t => {
  const { directory, closers } = await fixture(t);
  const root = openStore(directory); closers.push(() => root.close());
  root.registerWorkspace('demo-project', 'Demo project');
  const scoped = openStore(workspaceDirectory(directory, 'demo-project')); closers.push(() => scoped.close());
  const observed = [];
  const mock = http.createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    observed.push({ url: request.url, method: request.method, body: JSON.parse(Buffer.concat(parts)), auth: request.headers.authorization });
    const sessionID = request.url.split('/')[3];
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({ data: { id: 'msg_demo', type: 'user', sessionID, delivery: 'queue' } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise(resolve => mock.close(resolve)));
  const origin = `http://127.0.0.1:${mock.address().port}`;
  assert.equal((await execute({ kind: 'opencode', origin: 'http://192.0.2.1:9999', session: 'ses_example' })).state, 'failed');
  await writeFile(path.join(directory,'wake-config.json'), JSON.stringify({ opencode: { url: origin } }));
  const worker = fileURLToPath(new URL('../wake-worker.mjs', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [worker,'--data-dir', directory,'--once'], {
    timeout: 10000, env: { ...process.env, COORDINATOR_OPENCODE_PASSWORD: 'mock-local-test' } });
  scoped.saveProfile('reader', opencode, { create: true });
  scoped.setWakeTarget('reader', { enabled: true, conversationId: 'ses_first' });
  scoped.requestWake('reader');
  await run();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].method, 'POST');
  assert.equal(observed[0].url, '/api/session/ses_first/prompt');
  assert.equal(observed[0].body.delivery, 'queue');
  assert.equal(observed[0].auth, 'Basic ' + Buffer.from('opencode:mock-local-test').toString('base64'));
  assert.match(observed[0].body.text, /coord_demo-project_reader/);
  const accepted = scoped.wakeJobs({ state: 'accepted' }).jobs[0];
  assert.equal(accepted.acknowledged_at, null);
  const reader = await stdio('reader', workspaceDirectory(directory, 'demo-project'), closers);
  assert.equal((await reader('coordinator_ack_wake', { ids: [accepted.id] })).structuredContent.acknowledged, 1);
  assert.equal(scoped.wakeJobs({ state: 'acknowledged' }).jobs.length, 1);
  root.saveProfile('reader', opencode, { create: true });
  root.setWakeTarget('reader', { enabled: true, conversationId: 'ses_first' });
  root.requestWake('reader');
  await run();
  assert.equal(observed.length, 1);
  assert.equal(root.wakeJobs({ state: 'queued' }).jobs.length, 1);
});
