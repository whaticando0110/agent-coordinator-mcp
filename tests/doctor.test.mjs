import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCoordinatorServer } from '../server.mjs';
import { inspect } from '../doctor.mjs';

test('doctor distinguishes workspaces, reports readiness without config contents and does not create another store', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coordinator-doctor-'));
  const directory = path.join(root, 'workspace');
  const other = path.join(root, 'another-workspace');
  const app = createCoordinatorServer({ directory, port: 0 });
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  });
  const { port } = await app.listen();
  await writeFile(path.join(directory, 'wake-config.json'), JSON.stringify({
    codex: { executable: process.execPath, secret: 'do-not-report' }, antigravity: { executable: './bad.cmd' }
  }));
  app.store.wakeHeartbeat();
  app.store.touch('codex');
  app.store.setWakeTarget('codex', { conversationId: '00000000-0000-4000-8000-000000000001', enabled: true });
  app.store.requestWake('codex', 'test');
  const report = await inspect({ port, directory });
  assert.equal(report.dashboard, 'running');
  assert.equal(report.database, 'present');
  assert.equal(report.readiness.workerOnline, true);
  assert.equal(report.readiness.agents[0].lastMcpAt > 0, true);
  assert.equal(report.readiness.agents[0].queued, 1);
  assert.equal(report.readiness.agents[1].lastMcpAt, null);
  assert.deepEqual(report.bridges, { codex: 'configured', antigravity: 'invalid_executable' });
  assert.doesNotMatch(JSON.stringify(report), /do-not-report|00000000-0000-4000/);
  const wrong = await inspect({ port, directory: other });
  assert.equal(wrong.dashboard, 'wrong_workspace');
  assert.equal(wrong.readiness, null);
  await assert.rejects(stat(other), { code: 'ENOENT' });
});
