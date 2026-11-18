import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AppError } from './store.mjs';
import { createCoordinatorServer } from './server.mjs';
import { dispatchOnce } from './wake-worker.mjs';

const steps = [
  'Giao việc cho Codex',
  'Worker chuyển lời nhắc Codex',
  'Codex xác nhận và nhờ review',
  'Worker chuyển lời nhắc Antigravity',
  'Antigravity xác nhận và phản hồi'
];
const demoTargets = { codex: '00000000-0000-4000-8000-000000000001', antigravity: '00000000-0000-4000-8000-000000000002' };

function scenario(store, directory) {
  let step = 0, busy = false, taskId, codexWake, reviewWake;
  const snapshot = () => ({ step, steps, taskId: taskId ?? null });
  async function withClient(actor, work) {
    const client = new Client({ name: `demo-${actor}`, version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url)), '--agent', actor, '--data-dir', directory], stderr: 'pipe' });
    try {
      await client.connect(transport, { timeout: 5000 });
      return await work(async (name, args) => {
        const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
        if (reply.isError) throw new Error(reply.content[0]?.text ?? name);
        return reply.structuredContent;
      });
    } finally { await transport.close(); }
  }
  async function simulateBridge(actor) {
    const result = await dispatchOnce(store, { [actor]: { executable: process.execPath } },
      // Never execute the generated command or read host configuration in demo mode.
      async () => ({ state: 'accepted', error: '' }));
    if (result?.actor !== actor || result.state !== 'accepted') throw new Error('Không tìm thấy lời nhắc mẫu.');
    return result.ids;
  }
  async function readAndAck(call, ids) {
    await call('coordinator_ack_wake', { ids });
    const { messages } = await call('coordinator_inbox', { taskId });
    const unread = messages.filter(message => !message.read_at).map(message => message.id);
    if (unread.length) await call('coordinator_mark_read', { ids: unread });
  }
  return {
    snapshot,
    async advance(expected) {
      if (busy || expected !== step || step >= steps.length) throw new AppError(409, 'demo_step', 'Bước mẫu đã thay đổi. Tải lại trạng thái rồi thử tiếp.');
      busy = true;
      try {
        if (step === 0) {
          for (const [actor, conversationId] of Object.entries(demoTargets)) store.setWakeTarget(actor, { conversationId, enabled: true });
          const task = store.createTask('user', { owner: 'codex', requestId: 'portfolio-task',
            title: 'Rà khả năng đọc màn hình trên điện thoại', details: 'Kiểm tra chữ và nút chính ở màn hình hẹp, rồi chuyển kết quả cho Antigravity review.' });
          taskId = task.id;
        } else if (step === 1) {
          codexWake = await simulateBridge('codex');
        } else if (step === 2) {
          await withClient('codex', async call => {
            await readAndAck(call, codexWake);
            const { task } = await call('coordinator_task', { taskId });
            if (task.status !== 'review') await call('coordinator_update_task', { taskId, revision: task.revision, status: 'review', progress: 80, note: 'Đã kiểm cỡ chữ và nút chính trong kịch bản mẫu.' });
            await call('coordinator_send_message', { taskId, recipient: 'antigravity', requestId: 'portfolio-review', body: 'Nhờ review báo cáo kiểm trên điện thoại.' });
          });
        } else if (step === 3) {
          reviewWake = await simulateBridge('antigravity');
        } else {
          await withClient('antigravity', async call => {
            await readAndAck(call, reviewWake);
            await call('coordinator_send_message', { taskId, recipient: 'user', requestId: 'portfolio-reply', body: 'Đã đọc báo cáo mẫu; đề xuất kiểm thêm chiều ngang.' });
          });
        }
        step++;
        return snapshot();
      } finally { busy = false; }
    }
  };
}

export async function startDemo() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coordinator-demo-'));
  let app;
  try {
    app = createCoordinatorServer({ directory, port: 0, demoSetup: store => scenario(store, directory) });
    const { port } = await app.listen();
    return { url: `http://127.0.0.1:${port}`, directory, async close() {
      await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    app?.store.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo().then(demo => {
    console.log(`Mở ${demo.url} để thử app. Đây là mô phỏng, không kết nối chat thật. Ctrl+C để dừng.`);
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (closing) return;
      closing = true;
      demo.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
