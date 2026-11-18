import path from 'node:path';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { agents } from './config.mjs';

export function validExecutable(executable) {
  return typeof executable === 'string' && path.isAbsolute(executable) &&
    !executable.includes('\0') && (process.platform === 'win32' ? /\.exe$/i.test(executable) : !/\.(cmd|bat|ps1)$/i.test(executable));
}

export function openCodeOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.port ? parsed.origin : null;
  } catch { return null; }
}

export async function readWakeBridges(directory, profiles = agents.map(id => ({ id, app: id }))) {
  const actors = profiles.map(({ id }) => id);
  const statuses = Object.fromEntries(actors.map(actor => [actor, 'not_configured']));
  const config = {};
  let source;
  try { source = await readFile(path.join(directory, 'wake-config.json'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') for (const actor of actors) statuses[actor] = 'config_unreadable';
    return { statuses, config };
  }
  let raw;
  try { raw = JSON.parse(source); }
  catch { raw = null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    for (const actor of actors) statuses[actor] = 'invalid_config';
    return { statuses, config };
  }
  await Promise.all(profiles.map(async ({ id: actor, app }) => {
    if (app === 'opencode') {
      if (!Object.hasOwn(raw, 'opencode')) return;
      const origin = openCodeOrigin(raw.opencode?.url);
      if (!origin) { statuses[actor] = 'invalid_config'; return; }
      if (!process.env.COORDINATOR_OPENCODE_PASSWORD) { statuses[actor] = 'missing_password'; return; }
      statuses[actor] = 'configured';
      config[actor] = { kind: 'opencode', origin };
      return;
    }
    if (!Object.hasOwn(raw, actor)) return;
    const executable = raw[actor]?.executable;
    if (!validExecutable(executable)) { statuses[actor] = 'invalid_executable'; return; }
    try {
      if (!(await stat(executable)).isFile()) { statuses[actor] = 'unavailable_executable'; return; }
      await access(executable, constants.X_OK);
    } catch { statuses[actor] = 'unavailable_executable'; return; }
    statuses[actor] = 'configured';
    config[actor] = { executable, ...(actor === 'codex' && raw[actor].resume === true ? { resume: true } : {}) };
  }));
  return { statuses, config };
}
