import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { agents, actors, statuses } from './config.mjs';

export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function text(value, name, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    throw new AppError(400, 'invalid_input', `${name} không hợp lệ.`);
  return value.trim();
}

function choice(value, options, name) {
  if (!options.includes(value)) throw new AppError(400, 'invalid_input', `${name} không hợp lệ.`);
  return value;
}

export function openStore(directory, now = Date.now) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'coordinator.sqlite'), { timeout: 5000 });
  let closed = false;
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    transaction(() => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1].includes(version)) throw Error('Phiên bản dữ liệu điều phối chưa được hỗ trợ.');
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, details TEXT NOT NULL, owner TEXT NOT NULL,
          status TEXT NOT NULL, progress INTEGER NOT NULL, note TEXT NOT NULL,
          link TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, revision INTEGER NOT NULL,
          request_key TEXT UNIQUE,
          CHECK(owner IN ('codex','antigravity')),
          CHECK(status IN ('queued','in_progress','blocked','review','done')),
          CHECK(progress BETWEEN 0 AND 100));
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, recipient TEXT NOT NULL,
          body TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), created_at INTEGER NOT NULL,
          request_key TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS receipts (
          message_id INTEGER REFERENCES messages(id), actor TEXT NOT NULL, read_at INTEGER NOT NULL,
          PRIMARY KEY(message_id, actor));
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id), actor TEXT NOT NULL,
          body TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS wake_targets (
          actor TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS wake_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, conversation_id TEXT NOT NULL,
          source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued',
          created_at INTEGER NOT NULL, attempted_at INTEGER, acknowledged_at INTEGER, error TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS wake_pending ON wake_jobs(actor,state,id);
        CREATE TRIGGER IF NOT EXISTS coordinator_wake_message AFTER INSERT ON messages BEGIN
          INSERT OR IGNORE INTO wake_jobs(actor,conversation_id,source_key,created_at)
          SELECT actor,conversation_id,actor || ':message:' || NEW.id,NEW.created_at FROM wake_targets
          WHERE enabled=1 AND actor<>NEW.author AND (NEW.recipient=actor OR NEW.recipient='all');
        END;
        CREATE TABLE IF NOT EXISTS presence (actor TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, id);
        CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
        PRAGMA user_version=1;
      `);
    });
  } catch (error) { db.close(); throw error; }

  const task = id => {
    const result = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!result) throw new AppError(404, 'not_found', 'Không tìm thấy công việc.');
    delete result.request_key;
    return result;
  };
  const event = (id, actor, body) => db.prepare('INSERT INTO events(task_id,actor,body,created_at) VALUES(?,?,?,?)')
    .run(id, actor, body, now());
  const requestKey = (actor, input) => input === undefined ? null : `${actor}:${text(input, 'Mã yêu cầu', 100)}`;
  const canRead = (message, actor) => actor === 'user' || message.author === actor || message.recipient === actor || message.recipient === 'all';
  const touch = actor => {
    choice(actor, actors, 'Người dùng');
    if (actor !== 'user') db.prepare('INSERT INTO presence VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET last_seen=excluded.last_seen').run(actor, now());
  };
  const messages = (actor, { taskId, before, limit = 100 } = {}) => {
    choice(actor, actors, 'Người dùng');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1)))
      throw new AppError(400, 'invalid_input', 'Phân trang hộp thư không hợp lệ.');
    if (taskId) task(taskId);
    return db.prepare(`SELECT m.*, r.read_at FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.actor=?
      WHERE (?='user' OR m.author=? OR m.recipient=? OR m.recipient='all')
      AND (? IS NULL OR m.task_id=?) AND (? IS NULL OR m.id<?) ORDER BY m.id DESC LIMIT ?`)
      .all(actor, actor, actor, actor, taskId ?? null, taskId ?? null, before ?? null, before ?? null, limit);
  };
  const enqueueWake = (actor, source) => {
    const target = db.prepare('SELECT * FROM wake_targets WHERE actor=? AND enabled=1').get(actor);
    if (!target) return;
    db.prepare('INSERT OR IGNORE INTO wake_jobs(actor,conversation_id,source_key,created_at) VALUES(?,?,?,?)')
      .run(actor, target.conversation_id, `${actor}:${source}`, now());
  };
  return {
    wakeHeartbeat() {
      db.prepare("INSERT INTO presence VALUES('wake_worker',?) ON CONFLICT(actor) DO UPDATE SET last_seen=excluded.last_seen").run(now());
    },
    wakeState() {
      return { targets: db.prepare('SELECT * FROM wake_targets ORDER BY actor').all(),
        workerLastSeen: db.prepare("SELECT last_seen FROM presence WHERE actor='wake_worker'").get()?.last_seen ?? null,
        jobs: db.prepare('SELECT * FROM wake_jobs ORDER BY id DESC LIMIT 30').all() };
    },
    setWakeTarget(actor, { conversationId, enabled }) {
      choice(actor, agents, 'Agent');
      if (typeof enabled !== 'boolean' || typeof conversationId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId))
        throw new AppError(400, 'wake_target', 'Cần UUID chat đích và trạng thái bật/tắt.');
      return transaction(() => {
        // A new binding must never dispatch old requests into the new conversation.
        db.prepare("UPDATE wake_jobs SET state='cancelled' WHERE actor=? AND state='queued'").run(actor);
        db.prepare('INSERT INTO wake_targets VALUES(?,?,?) ON CONFLICT(actor) DO UPDATE SET conversation_id=excluded.conversation_id,enabled=excluded.enabled')
          .run(actor, conversationId, Number(enabled));
        return this.wakeState();
      });
    },
    requestWake(actor, source = randomUUID()) {
      choice(actor, agents, 'Agent');
      return transaction(() => {
        if (!db.prepare('SELECT 1 FROM wake_targets WHERE actor=? AND enabled=1').get(actor))
          throw new AppError(409, 'wake_disabled', 'Chưa bật đánh thức và chọn chat đích.');
        enqueueWake(actor, `manual:${source}`);
        return this.wakeState();
      });
    },
    claimWake() {
      return transaction(() => {
        // An interrupted send has an uncertain outcome. Never silently resend it.
        db.prepare("UPDATE wake_jobs SET state='unknown',error='Worker dừng hoặc quá hạn; kiểm tra chat trước khi đánh thức lại.' WHERE state='sending' AND attempted_at<?")
          .run(now() - 120000);
        const job = db.prepare(`SELECT j.* FROM wake_jobs j JOIN wake_targets t ON t.actor=j.actor
          AND t.enabled=1 AND t.conversation_id=j.conversation_id WHERE j.state='queued'
          AND (SELECT count(DISTINCT attempted_at) FROM wake_jobs h WHERE h.actor=j.actor AND h.attempted_at>?)<10
          AND NOT EXISTS(SELECT 1 FROM wake_jobs p WHERE p.actor=j.actor AND
            (p.state='sending' OR p.attempted_at>?)) ORDER BY j.id LIMIT 1`).get(now() - 3600000, now() - 30000);
        if (!job) return null;
        const ids = db.prepare("SELECT id FROM wake_jobs WHERE actor=? AND conversation_id=? AND state='queued' ORDER BY id LIMIT 200")
          .all(job.actor, job.conversation_id).map(row => row.id);
        const attemptedAt = now();
        for (const id of ids) db.prepare("UPDATE wake_jobs SET state='sending',attempted_at=? WHERE id=?").run(attemptedAt, id);
        return { ...job, ids };
      });
    },
    finishWake(ids, state, error = '') {
      choice(state, ['accepted', 'failed', 'unknown'], 'Kết quả gửi');
      transaction(() => {
        for (const id of ids) db.prepare("UPDATE wake_jobs SET state=?,error=? WHERE id=? AND state='sending'").run(state, error.slice(0, 1000), id);
      });
    },
    acknowledgeWake(actor, ids) {
      choice(actor, agents, 'Agent');
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id < 1))
        throw new AppError(400, 'wake_ids', 'Mã đánh thức không hợp lệ.');
      return transaction(() => {
        let acknowledged = 0;
        for (const id of ids) acknowledged += db.prepare("UPDATE wake_jobs SET acknowledged_at=? WHERE id=? AND actor=? AND state IN ('sending','accepted','unknown') AND acknowledged_at IS NULL")
          .run(now(), id, actor).changes;
        return { acknowledged };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } }, touch, task,
    listTasks({ owner, status } = {}) {
      if (owner) choice(owner, agents, 'Bên phụ trách');
      if (status) choice(status, statuses, 'Trạng thái');
      return db.prepare(`SELECT id FROM tasks WHERE (? IS NULL OR owner=?) AND (? IS NULL OR status=?) ORDER BY updated_at DESC, rowid DESC`)
        .all(owner ?? null, owner ?? null, status ?? null, status ?? null).map(row => task(row.id));
    },
    createTask(actor, input) {
      choice(actor, actors, 'Người gửi');
      const title = text(input.title, 'Tiêu đề', 180), details = text(input.details ?? '', 'Mô tả', 12000, true);
      const owner = choice(input.owner, agents, 'Bên phụ trách');
      const key = requestKey(actor, input.requestId);
      return transaction(() => {
        const prior = key && db.prepare('SELECT * FROM tasks WHERE request_key=?').get(key);
        if (prior) {
          if (prior.title !== title || prior.details !== details || prior.owner !== owner)
            throw new AppError(409, 'request_conflict', 'Mã yêu cầu đã dùng cho nội dung khác.');
          return task(prior.id);
        }
        const id = randomUUID(), at = now();
        db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, title, details, owner, 'queued', 0, '', '', actor, at, at, 1, key);
        event(id, actor, 'created');
        db.prepare('INSERT INTO messages(author,recipient,body,task_id,created_at) VALUES(?,?,?,?,?)')
          .run(actor, owner, `Việc mới được giao. ${title}`, id, at);
        return task(id);
      });
    },
    updateTask(actor, id, input) {
      choice(actor, actors, 'Người dùng');
      return transaction(() => {
        const current = task(id);
        if (actor !== 'user' && current.owner !== actor) throw new AppError(403, 'wrong_owner', 'Chỉ bên phụ trách được cập nhật tiến độ.');
        if (input.revision !== current.revision) throw new AppError(409, 'stale_revision', 'Công việc vừa được cập nhật. Hãy tải lại trước khi sửa.');
        const status = choice(input.status ?? current.status, statuses, 'Trạng thái');
        const progress = input.progress ?? current.progress;
        if (!Number.isInteger(progress) || progress < 0 || progress > 100 || (status === 'done' && progress !== 100))
          throw new AppError(400, 'invalid_progress', 'Tiến độ cần từ 0 đến 100. Hoàn tất cần đạt 100%.');
        const note = text(input.note ?? current.note, 'Cập nhật', 4000, true);
        if (status === 'blocked' && !note) throw new AppError(400, 'missing_blocker', 'Hãy ghi rõ điều đang bị vướng.');
        const link = text(input.link ?? current.link, 'Liên kết', 2048, true);
        if (link && !/^https?:\/\/[^\s]+$/i.test(link)) throw new AppError(400, 'invalid_link', 'Liên kết cần bắt đầu bằng http hoặc https.');
        db.prepare('UPDATE tasks SET status=?,progress=?,note=?,link=?,updated_at=?,revision=revision+1 WHERE id=?')
          .run(status, progress, note, link, now(), id);
        event(id, actor, JSON.stringify({ status, progress, note, link }));
        return task(id);
      });
    },
    messages,
    sendMessage(actor, input) {
      choice(actor, actors, 'Người gửi');
      const body = text(input.body, 'Tin nhắn', 12000);
      const recipient = choice(input.recipient, [...actors, 'all'], 'Người nhận');
      const taskId = input.taskId || null, key = requestKey(actor, input.requestId);
      return transaction(() => {
        if (taskId) task(taskId);
        const prior = key && db.prepare('SELECT * FROM messages WHERE request_key=?').get(key);
        if (prior) {
          if (prior.body !== body || prior.recipient !== recipient || prior.task_id !== taskId)
            throw new AppError(409, 'request_conflict', 'Mã yêu cầu đã dùng cho nội dung khác.');
          delete prior.request_key;
          return prior;
        }
        const { lastInsertRowid } = db.prepare('INSERT INTO messages(author,recipient,body,task_id,created_at,request_key) VALUES(?,?,?,?,?,?)')
          .run(actor, recipient, body, taskId, now(), key);
        const result = db.prepare('SELECT * FROM messages WHERE id=?').get(lastInsertRowid);
        delete result.request_key;
        return result;
      });
    },
    markRead(actor, ids) {
      choice(actor, actors, 'Người đọc');
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id < 1))
        throw new AppError(400, 'invalid_input', 'Danh sách tin nhắn không hợp lệ.');
      return transaction(() => {
        for (const id of ids) {
          const message = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
          if (!message || !canRead(message, actor)) throw new AppError(403, 'message_access', 'Không thể đánh dấu tin nhắn này.');
          db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?)').run(id, actor, now());
        }
        return { marked: ids.length };
      });
    },
    detail(actor, id) {
      return { task: task(id), messages: messages(actor, { taskId: id }),
        events: db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT 100').all(id) };
    },
    board() {
      const tasks = this.listTasks();
      const unread = actor => db.prepare(`SELECT count(*) AS n FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.actor=?
        WHERE m.author<>? AND (?='user' OR m.recipient=? OR m.recipient='all') AND r.message_id IS NULL`).get(actor, actor, actor, actor).n;
      return { tasks, userUnread: unread('user'), agents: agents.map(actor => ({ actor,
        lastSeen: db.prepare('SELECT last_seen FROM presence WHERE actor=?').get(actor)?.last_seen ?? null,
        unread: unread(actor) })) };
    }
  };
}
