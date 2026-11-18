import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startDemo } from '../demo.mjs';
import { dataDirectory, connectionConfig } from '../config.mjs';

test('standalone defaults and generated MCP settings keep the original installation separate', () => {
  const local = path.join(os.tmpdir(), 'windows-local');
  const old = path.join(local, 'CoChanNhan', 'AgentCoordinator');
  const directory = dataDirectory({ LOCALAPPDATA: local, AGENT_COORDINATOR_DATA_DIR: old });
  assert.equal(directory, path.join(local, 'AgentCoordinatorMCP'));
  assert.throws(() => dataDirectory({ COORDINATOR_DATA_DIR: './relative' }), /tuyệt đối/);
  const { codex, antigravity } = connectionConfig(directory);
  assert.match(codex, /mcp_servers\.agent_coordinator_standalone/);
  assert.deepEqual(Object.keys(JSON.parse(antigravity).mcpServers), ['agent_coordinator_standalone']);
});

test('demo gates temporary data and simulates delivery separately from two actual MCP ACKs', { timeout: 15000 }, async () => {
  const demo = await startDemo();
  try {
    const read = (route = '/api/state') => fetch(demo.url + route).then(response => response.json());
    const initial = await read();
    const send = (route, body, token = initial.token) => fetch(demo.url + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coordinator-Token': token }, body: JSON.stringify(body) });
    const advance = async step => {
      const response = await send('/api/demo/advance', { step });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.step, step + 1);
    };
    assert.equal(initial.connection, null);
    assert.equal((await read('/api/health')).mode, 'demo');
    assert.equal(initial.dataDirectory, null);
    assert.deepEqual(initial.tasks, []);
    assert.equal(initial.demo.step, 0);
    assert.equal((await send('/api/demo/advance', { step: 0 }, 'wrong')).status, 403);
    assert.equal((await send('/api/tasks', { title: 'Outside scenario', owner: 'codex' })).status, 403);
    assert.equal((await send('/api/wake/codex', {})).status, 403);
    await advance(0);
    let state = await read();
    assert.equal(state.wake.jobs[0].state, 'queued');
    await advance(1);
    state = await read();
    assert.equal(state.wake.jobs[0].state, 'accepted');
    assert.equal(state.wake.jobs[0].acknowledged_at, null);
    const concurrent = await Promise.all([2, 2].map(step => send('/api/demo/advance', { step })));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
    state = await read();
    assert.ok(state.wake.jobs.find(job => job.actor === 'codex').acknowledged_at);
    assert.equal(state.wake.jobs.find(job => job.actor === 'antigravity').state, 'queued');
    assert.equal(state.tasks[0].progress, 80);
    await advance(3);
    state = await read();
    assert.equal(state.wake.jobs.find(job => job.actor === 'antigravity').state, 'accepted');
    assert.equal(state.wake.jobs.find(job => job.actor === 'antigravity').acknowledged_at, null);
    await advance(4);
    state = await read();
    assert.equal(state.wake.jobs.length, 2);
    assert.ok(state.wake.jobs.every(job => job.acknowledged_at));
    assert.deepEqual(state.agents.map(actor => actor.unread), [0, 0]);
    assert.equal((await read('/api/messages')).messages[0].author, 'antigravity');
    assert.equal((await send('/api/demo/advance', { step: 5 })).status, 409);
  } finally { await demo.close(); }
  await assert.rejects(stat(demo.directory), { code: 'ENOENT' });
});
