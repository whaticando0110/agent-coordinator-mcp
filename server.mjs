import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agents, appDirectory, appName, connectionConfig, coordinatorPort, dataDirectory, defaultPort, profileConnection, workspaceKey } from './config.mjs';
import { AppError, openStore } from './store.mjs';
import { readWakeBridges } from './wake-bridges.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new AppError(415, 'content_type', 'Cần nội dung JSON.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new AppError(413, 'body_limit', 'Yêu cầu quá dài.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'json', 'Nội dung JSON không hợp lệ.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'json', 'Cần một đối tượng JSON.');
  return body;
}

export function createCoordinatorServer({ directory = dataDirectory(), port = defaultPort, demoSetup } = {}) {
  const store = openStore(directory), token = randomBytes(32).toString('hex');
  const demo = demoSetup?.(store);
  const workspace = workspaceKey(directory);
  async function readiness() {
    const { statuses } = await readWakeBridges(directory);
    const targets = store.wakeState().targets, presence = store.lastSeen(), counts = store.wakeCounts();
    const workerLastSeen = presence.wake_worker ?? null;
    return { workerLastSeen, workerOnline: workerLastSeen !== null && Date.now() - workerLastSeen < 15000,
      agents: agents.map(actor => ({ actor, lastMcpAt: presence[actor] ?? null, bridge: statuses[actor],
        targetEnabled: Boolean(targets.find(target => target.actor === actor)?.enabled), ...counts[actor] })) };
  }
  const send = (response, code, data) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const actualPort = server.address()?.port;
      const origins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
      if (!origins.includes(`http://${request.headers.host}`) || (request.headers.origin && !origins.includes(request.headers.origin)))
        throw new AppError(403, 'origin', 'Kết nối local không hợp lệ.');
      const url = new URL(request.url, origins[0]);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(path.join(appDirectory, 'public', name)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { app: appName,
        version: '0.1.0', mode: demo ? 'demo' : 'live', workspace: demo ? null : workspace });
      if (request.method === 'GET' && url.pathname === '/api/readiness' && !demo)
        return send(response, 200, await readiness());
      if (request.method === 'GET' && url.pathname === '/api/support' && !demo) {
        const report = await readiness();
        return send(response, 200, { app: appName, node: process.versions.node, platform: process.platform,
          workerOnline: report.workerOnline, registeredAgents: store.profiles().length,
          wake: report.agents.map(({ actor, bridge, lastMcpAt, targetEnabled, queued, uncertain }) => ({
            adapter: actor, bridge, mcpSeen: lastMcpAt !== null, targetEnabled, queued, uncertain
          })) });
      }
      if (request.method === 'GET' && url.pathname === '/api/wake/jobs' && !demo)
        return send(response, 200, store.wakeJobs({ actor: url.searchParams.get('actor') || undefined,
          state: url.searchParams.get('state') || undefined,
          before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined }));
      const profileRoute = /^\/api\/agents\/([a-z][a-z0-9_-]{0,31})$/.exec(url.pathname);
      if (request.method === 'GET' && profileRoute && !demo)
        return send(response, 200, profileConnection(directory, store.profile(profileRoute[1])));
      if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, { ...store.board(), token,
        dataDirectory: demo ? null : directory, connection: demo ? null : connectionConfig(directory), wake: store.wakeState(),
        demo: demo?.snapshot() ?? null, readiness: demo ? null : await readiness() });
      if (request.method === 'GET' && url.pathname === '/api/messages') {
        const before = url.searchParams.get('before');
        return send(response, 200, { messages: store.messages('user', { taskId: url.searchParams.get('taskId') || undefined,
          before: before ? Number(before) : undefined }) });
      }
      const detail = /^\/api\/tasks\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === 'GET' && detail) return send(response, 200, store.detail('user', detail[1]));
      if (!['POST', 'PATCH'].includes(request.method)) throw new AppError(404, 'not_found', 'Không tìm thấy đường dẫn.');
      if (request.headers['x-coordinator-token'] !== token) throw new AppError(403, 'token', 'Phiên giao diện đã đổi. Hãy tải lại trang.');
      const body = await readBody(request);
      if (demo) {
        if (request.method === 'POST' && url.pathname === '/api/demo/advance') return send(response, 200, await demo.advance(body.step));
        throw new AppError(403, 'demo_readonly', 'Bản mô phỏng chỉ thay đổi qua các bước mẫu.');
      }
      if (request.method === 'POST' && url.pathname === '/api/agents')
        return send(response, 201, store.saveProfile(body.id, body, { create: true }));
      if (request.method === 'PATCH' && profileRoute)
        return send(response, 200, store.saveProfile(profileRoute[1], body));
      const wakeJob = /^\/api\/wake\/jobs\/([1-9][0-9]*)\/(cancel|retry)$/.exec(url.pathname);
      if (request.method === 'POST' && wakeJob) {
        const id = Number(wakeJob[1]);
        if (!Number.isSafeInteger(id)) throw new AppError(400, 'wake_id', 'Mã lời nhắc không hợp lệ.');
        if (wakeJob[2] === 'cancel') return send(response, 200, store.cancelWake(id));
        return send(response, 202, store.retryWake(id, body.reviewed));
      }
      const wakeTarget = /^\/api\/wake\/(codex|antigravity)$/.exec(url.pathname);
      if (request.method === 'PATCH' && wakeTarget) return send(response, 200, store.setWakeTarget(wakeTarget[1], body));
      if (request.method === 'POST' && wakeTarget) return send(response, 202, store.requestWake(wakeTarget[1]));
      if (request.method === 'POST' && url.pathname === '/api/tasks') return send(response, 201, { task: store.createTask('user', body) });
      if (request.method === 'PATCH' && detail) return send(response, 200, { task: store.updateTask('user', detail[1], body) });
      if (request.method === 'POST' && url.pathname === '/api/messages') return send(response, 201, { message: store.sendMessage('user', body) });
      if (request.method === 'POST' && url.pathname === '/api/read') return send(response, 200, store.markRead('user', body.ids));
      throw new AppError(404, 'not_found', 'Không tìm thấy đường dẫn.');
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!response.headersSent) send(response, error.status || 500, { error: { code: error.code || 'internal', message: error instanceof AppError ? error.message : 'Có lỗi khi xử lý. Dữ liệu đã lưu vẫn được giữ.' } });
      else response.destroy();
    }
  });
  server.on('close', () => store.close());
  server.requestTimeout = 15000;
  return { server, store, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address()));
  }) };
}

async function main() {
  const port = coordinatorPort();
  const app = createCoordinatorServer({ port });
  await app.listen();
  console.log(`Điều phối Codex và Antigravity tại http://127.0.0.1:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.server.close());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
