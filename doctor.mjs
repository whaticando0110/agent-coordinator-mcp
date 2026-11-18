import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appName, coordinatorPort, dataDirectory, workspaceKey } from './config.mjs';
import { readWakeBridges } from './wake-bridges.mjs';

export function launchSettings(directory = dataDirectory(), port = coordinatorPort()) {
  return { address: `http://127.0.0.1:${port}`, directory, workspace: workspaceKey(directory) };
}

export async function inspect({ directory = dataDirectory(), port = coordinatorPort() } = {}) {
  const { address, workspace } = launchSettings(directory, port);
  const major = Number(process.versions.node.split('.')[0]);
  let dependencies = true;
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio', 'zod']) {
    try { import.meta.resolve(name); } catch { dependencies = false; }
  }
  let database = 'not_created';
  try { database = (await stat(path.join(directory, 'coordinator.sqlite'))).isFile() ? 'present' : 'invalid'; }
  catch (error) { if (error.code !== 'ENOENT') database = 'unreadable'; }
  const { statuses: bridges } = await readWakeBridges(directory);
  let dashboard, readiness = null;
  const get = route => fetch(address + route, { redirect: 'error', signal: AbortSignal.timeout(1800) });
  try {
    const response = await get('/api/health');
    const health = response.ok ? await response.json().catch(() => null) : null;
    if (health?.app !== appName || health.mode !== 'live') dashboard = 'other_service';
    else if (health.workspace !== workspace) dashboard = 'wrong_workspace';
    else {
      dashboard = 'running';
      const check = await get('/api/readiness');
      if (check.ok) readiness = await check.json();
      else dashboard = 'readiness_unavailable';
    }
  } catch (error) { dashboard = error.cause?.code === 'ECONNREFUSED' ? 'not_running' : 'unreachable'; }
  return { node: process.versions.node, nodeSupported: major >= 24, dependencies, directory, database, address, dashboard, bridges, readiness };
}

const bridgeLabels = {
  configured: 'đường dẫn bridge hợp lệ; chưa thử gửi thật', not_configured: 'chưa cấu hình bridge',
  config_unreadable: 'không đọc được cấu hình bridge', invalid_config: 'tệp cấu hình bridge không hợp lệ',
  invalid_executable: 'đường dẫn tệp chạy bridge không hợp lệ', unavailable_executable: 'không mở được tệp chạy bridge'
};

async function main() {
  const { values } = parseArgs({ options: { json: { type: 'boolean' }, 'launch-config': { type: 'boolean' } } });
  if (values['launch-config']) {
    // Windows PowerShell 5 can decode native stdout using a non-UTF8 code page.
    console.log(JSON.stringify(launchSettings()).replace(/[^\x00-\x7f]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')));
    return;
  }
  const info = await inspect();
  if (values.json) console.log(JSON.stringify(info, null, 2));
  else {
    console.log(`Node ${info.node} · ${info.dependencies ? 'đủ thư viện' : 'thiếu thư viện; chạy npm ci --ignore-scripts'}`);
    console.log(`Kho dự kiến: ${info.directory} · ${{ present: 'đã có SQLite', not_created: 'chưa tạo SQLite', invalid: 'đường dẫn SQLite không phải tệp', unreadable: 'không đọc được SQLite' }[info.database]}`);
    console.log(`Dashboard ${info.address} · ${{
      running: 'đang chạy đúng checkout và kho', not_running: 'chưa chạy; dùng npm run serve',
      other_service: 'cổng đang phục vụ ứng dụng khác', wrong_workspace: 'cổng đang mở kho hoặc checkout khác',
      unreachable: 'không kiểm tra được phản hồi', readiness_unavailable: 'đang chạy nhưng lỗi đọc trạng thái'
    }[info.dashboard]}`);
    console.log(`Worker: ${info.readiness?.workerOnline ? 'có heartbeat gần đây' : 'chưa thấy heartbeat'} (tùy chọn)`);
    for (const actor of ['codex', 'antigravity']) {
      const row = info.readiness?.agents.find(row => row.actor === actor);
      const mcp = row?.lastMcpAt ? 'lần gọi MCP cuối: ' + new Date(row.lastMcpAt).toISOString() : 'chưa thấy gọi MCP';
      const pending = row ? ` · ${row.targetEnabled ? 'đã bật chat đích' : 'chưa bật chat đích'} · ${row.queued} chờ · ${row.uncertain} chưa rõ kết quả` : '';
      console.log(`${actor}: ${mcp} · ${bridgeLabels[info.bridges[actor]]}${pending}`);
    }
  }
  if (!info.nodeSupported || !info.dependencies || ['invalid', 'unreadable'].includes(info.database) ||
      !['running', 'not_running'].includes(info.dashboard)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
