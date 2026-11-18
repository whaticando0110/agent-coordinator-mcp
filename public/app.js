const $ = selector => document.querySelector(selector);
const labels = { queued: 'Chờ nhận', in_progress: 'Đang làm', blocked: 'Đang vướng', review: 'Chờ review', done: 'Hoàn tất' };
const names = Object.assign(Object.create(null), { user: 'Bạn', codex: 'Codex', antigravity: 'Antigravity', all: 'Hộp thư chung' });
const state = { board: null, selected: null, detail: null, dirty: false, messages: new Map(), view: 'tasks' };
let noticeTimer;
let refreshing, demoPending = false;
let profileVersion = 0, profileKey, profileSnippet;
let queueVersion = 0, queueCursor = null, queueNext = null;
const queueLabels = { queued: 'Chờ chuyển', sending: 'Đang chuyển', accepted: 'Đã chuyển · chờ ACK',
  acknowledged: 'Đã ACK qua MCP', failed: 'Chưa gửi được', unknown: 'Chưa rõ kết quả', cancelled: 'Đã hủy' };
const appLabels = { codex: 'Codex', antigravity: 'Antigravity', 'claude-desktop': 'Claude Desktop', cursor: 'Cursor',
  vscode: 'VS Code', 'gemini-cli': 'Gemini CLI', stdio: 'MCP STDIO' };

function choices(select, entries) {
  const key = JSON.stringify(entries);
  if (select.dataset.choices === key) return false;
  const previous = select.value;
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  if (entries.some(([value]) => value === previous)) select.value = previous;
  select.dataset.choices = key;
  return true;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = error ? 'notice error' : 'notice';
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
}

async function api(url, method = 'GET', body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', 'X-Coordinator-Token': state.board?.token || '' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'Không kết nối được với app điều phối.');
  return result;
}

function time(at) {
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
}

function statusBadge(status) { return element('span', `status ${status}`, labels[status]); }
function ownerBadge(owner) { return element('span', `owner-chip ${owner}`, names[owner]); }
function progress(value) {
  const node = element('progress');
  node.max = 100; node.value = value;
  node.setAttribute('aria-label', `Tiến độ ${value}%`);
  return node;
}

function renderBoard() {
  const tasks = state.board.tasks;
  const options = state.board.agents.map(agent => {
    names[agent.actor] = agent.name;
    return [agent.actor, agent.name];
  });
  choices($('#owner-filter'), [['', 'Mọi agent'], ...options]);
  choices($('#task-form').elements.owner, options);
  choices($('#known-models'), [...new Set(state.board.agents.map(agent => agent.model).filter(Boolean))].map(model => [model, model]));
  choices($('#message-form').elements.recipient, [['all', names.all], ...options]);
  choices($('#queue-actor'), [['', 'Tất cả'], ...options.filter(([id]) => ['codex', 'antigravity'].includes(id))]);
  if (choices($('#profile-select'), [...options, ['', '＋ Thêm hồ sơ mới']]) && !state.board.demo && !profileKey) {
    $('#profile-select').value = options[0]?.[0] ?? '';
    fillProfile();
  }
  renderProfileSeen();
  $('#task-count').textContent = tasks.length;
  $('#message-count').textContent = state.board.userUnread;
  const summary = $('#summary');
  summary.replaceChildren();
  for (const [label, count, caption] of [
    ['Tổng công việc', tasks.length, 'đã giao'],
    ['Đang thực hiện', tasks.filter(task => task.status === 'in_progress').length, 'đang làm'],
    ['Chờ trao đổi', tasks.filter(task => ['blocked', 'review'].includes(task.status)).length, 'cần chú ý'],
    ['Đã hoàn tất', tasks.filter(task => task.status === 'done').length, 'công việc']
  ]) {
    const card = element('div', 'stat');
    const value = element('strong', '', count);
    value.append(element('em', '', caption));
    card.append(element('span', 'stat-label', label), value);
    summary.append(card);
  }
  const agents = $('#agents');
  agents.replaceChildren();
  for (const agent of state.board.agents) {
    const card = element('div', 'agent-card');
    const info = element('div');
    info.append(element('div', 'agent-name', names[agent.actor]), element('div', 'agent-subtitle',
      agent.lastSeen ? `MCP truy cập lúc ${time(agent.lastSeen)}` : 'Chờ app truy cập MCP'),
      element('div', 'hint', [agent.appLabel || appLabels[agent.app], agent.model].filter(Boolean).join(' · ')));
    const stats = element('div', 'agent-stats');
    stats.append(element('b', '', `${tasks.filter(task => task.owner === agent.actor && task.status !== 'done').length} việc đang mở`),
      element('small', '', `${agent.unread} tin chưa xác nhận đọc`));
    card.append(element('span', `avatar ${agent.actor}`, agent.actor === 'codex' ? '⌘' : agent.name.slice(0, 1).toUpperCase()), info, stats);
    agents.append(card);
  }
  renderTasks();
  const taskSelect = $('#message-task');
  const optionsKey = JSON.stringify(tasks.map(task => [task.id, task.owner, task.title]));
  if (taskSelect.dataset.optionsKey !== optionsKey) {
    const selected = taskSelect.value;
    taskSelect.replaceChildren(new Option('Trao đổi chung', ''));
    for (const task of tasks) taskSelect.add(new Option(`${names[task.owner]} · ${task.title}`, task.id));
    taskSelect.value = selected;
    taskSelect.dataset.optionsKey = optionsKey;
  }
}

function renderTasks() {
  if (!state.board) return;
  const tasks = state.board.tasks.filter(task => (!$('#owner-filter').value || task.owner === $('#owner-filter').value) &&
    (!$('#status-filter').value || task.status === $('#status-filter').value));
  $('#filtered-count').textContent = `${tasks.length} công việc`;
  const list = $('#task-list');
  const renderKey = JSON.stringify([tasks, state.selected]);
  if (list.dataset.renderKey === renderKey) return;
  list.dataset.renderKey = renderKey;
  list.replaceChildren();
  if (!tasks.length) {
    const blank = element('div', 'empty-state');
    blank.append(element('span', 'empty-icon', '＋'), element('h2', '', state.board.tasks.length ? 'Chưa có việc khớp bộ lọc.' : 'Bắt đầu bằng một việc cụ thể.'),
      element('p', '', 'Chọn bên phụ trách và mô tả kết quả bạn cần.'));
    list.append(blank);
  }
  for (const task of tasks) {
    const card = element('button', `task-card${state.selected === task.id ? ' selected' : ''}`);
    card.type = 'button';
    const top = element('div', 'task-top');
    top.append(ownerBadge(task.owner), element('span', '', time(task.updated_at)));
    const bottom = element('div', 'task-bottom');
    bottom.append(statusBadge(task.status), progress(task.progress), element('span', 'progress-number', `${task.progress}%`));
    card.append(top, element('h3', '', task.title), bottom);
    card.addEventListener('click', () => selectTask(task.id));
    list.append(card);
  }
}

async function selectTask(id) {
  state.selected = id;
  state.dirty = false;
  const detail = await api(`/api/tasks/${id}`);
  if (state.selected !== id) return;
  state.detail = detail;
  renderDetail(detail);
  renderTasks();
}

function renderDetail({ task, events, messages }) {
  const panel = $('#task-detail');
  panel.replaceChildren();
  const meta = element('div', 'detail-meta');
  meta.append(ownerBadge(task.owner), statusBadge(task.status), element('span', 'muted', `Giao bởi ${names[task.created_by]}`));
  panel.append(meta, element('h2', 'detail-title', task.title), element('p', 'detail-description', task.details || 'Chưa có mô tả bổ sung.'));
  const form = document.createElement('form');
  form.innerHTML = `<div class="form-row"><label>Trạng thái<select name="status"></select></label><label>Tiến độ (%)<input type="number" name="progress" min="0" max="100" required></label></div>
    <label>Cập nhật mới nhất<textarea name="note" rows="3" maxlength="4000" placeholder="Đã làm gì, đang vướng gì, cần ai phản hồi…"></textarea></label>
    <label>Link Issue hoặc PR<input name="link" type="url" maxlength="2048" placeholder="https://github.com/…"></label>
    <button class="primary" type="submit">Lưu cập nhật</button>`;
  for (const [value, label] of Object.entries(labels)) form.elements.status.add(new Option(label, value));
  for (const name of ['status', 'progress', 'note', 'link']) form.elements[name].value = task[name];
  form.addEventListener('input', () => { state.dirty = true; });
  form.elements.status.addEventListener('change', () => {
    state.dirty = true;
    if (form.elements.status.value === 'done') form.elements.progress.value = 100;
  });
  form.addEventListener('submit', event => submitForm(event, async () => {
    const input = Object.fromEntries(new FormData(form));
    input.revision = task.revision;
    input.progress = Number(input.progress);
    await api(`/api/tasks/${task.id}`, 'PATCH', input);
    await selectTask(task.id);
    await refresh();
    showNotice('Đã lưu tiến độ. Hai bên có thể đọc cập nhật qua MCP.');
  }));
  if (!state.board.demo) panel.append(form);
  else panel.append(element('p', 'hint', `Tiến độ ${task.progress}%${task.note ? ` · ${task.note}` : ''}`));
  const discussion = element('button', 'text-button', '↗ Trao đổi về công việc này');
  discussion.addEventListener('click', () => {
    setView('inbox');
    if (!state.board.demo) { $('#message-task').value = task.id; $('#message-form').elements.body.focus(); }
  });
  panel.append(element('h3', 'detail-section-title', 'Trao đổi gần đây'), discussion);
  for (const message of messages.slice(0, 4).reverse()) {
    const row = element('div', 'detail-message');
    row.append(element('small', '', `${names[message.author]} → ${names[message.recipient]} · ${time(message.created_at)}`), element('p', '', message.body));
    panel.append(row);
  }
  panel.append(element('h3', 'detail-section-title', 'Lịch sử tiến độ'));
  for (const event of events.slice(0, 8)) {
    const row = element('div', 'event');
    const content = element('div');
    let description = 'Đã giao công việc';
    if (event.body !== 'created') {
      const change = JSON.parse(event.body);
      description = `${labels[change.status]} · ${change.progress}%${change.note ? `\n${change.note}` : ''}`;
    }
    content.append(element('small', '', `${names[event.actor]} · ${time(event.created_at)}`), element('p', '', description));
    row.append(element('span', 'event-dot'), content);
    panel.append(row);
  }
}

function renderMessages() {
  const panel = $('#messages');
  panel.replaceChildren();
  const messages = [...state.messages.values()].sort((a, b) => b.id - a.id);
  if (!messages.length) panel.append(element('div', 'empty-state', 'Hộp thư đang trống. Gửi yêu cầu đầu tiên cho một bên hoặc cả hai.'));
  for (const message of messages) {
    const row = element('article', `message${!message.read_at && message.author !== 'user' ? ' unread' : ''}`);
    row.id = `message-${message.id}`;
    const header = element('div', 'message-head');
    header.append(element('b', '', names[message.author]), element('span', 'muted', `→ ${names[message.recipient]}`), element('time', '', time(message.created_at)));
    row.append(header, element('p', '', message.body));
    if (message.task_id) {
      const task = state.board?.tasks.find(item => item.id === message.task_id);
      const link = element('button', 'message-task', `↗ ${task?.title || 'Xem công việc'}`);
      link.addEventListener('click', () => { setView('tasks'); selectTask(message.task_id).catch(error => showNotice(error.message, true)); });
      row.append(link);
    }
    panel.append(row);
  }
}

async function loadMessages(before) {
  const result = await api(`/api/messages${before ? `?before=${before}` : ''}`);
  for (const message of result.messages) state.messages.set(message.id, message);
  if (before || state.messages.size <= 100) $('#older-messages').hidden = result.messages.length < 100;
  renderMessages();
}

function refresh() {
  refreshing ??= loadBoard().finally(() => { refreshing = undefined; });
  return refreshing;
}

async function loadBoard() {
  try {
    state.board = await api('/api/state');
    const demo = state.board.demo;
    $('#data-location').textContent = demo ? 'Kho tạm · chỉ dùng dữ liệu mẫu' : state.board.dataDirectory;
    $('#connection-state').textContent = 'Đã đồng bộ với kho local';
    $('#new-task').hidden = $('#compose-panel').hidden = $('#mark-read').hidden = $('#connection-setup').hidden = Boolean(demo);
    $('#queue-nav').hidden = Boolean(demo);
    renderDemo(demo);
    renderBoard();
    renderWake();
    if (state.view === 'queue' && !queueCursor) await loadQueue();
    await loadMessages();
    if (state.selected && !state.dirty && !$('#task-detail').contains(document.activeElement)) {
      const id = state.selected;
      const detail = await api(`/api/tasks/${id}`);
      if (state.selected === id && !state.dirty && JSON.stringify(state.detail) !== JSON.stringify(detail)) {
        state.detail = detail; renderDetail(detail);
      }
    }
  } catch (error) {
    $('#connection-state').textContent = 'Đang mất kết nối · tự thử lại';
    if (!state.board) showNotice(error.message, true);
  }
}

function renderDemo(demo) {
  $('#demo-panel').hidden = !demo;
  $('.local-badge').textContent = demo ? '● DEMO' : '● LOCAL';
  if (!demo) return;
  const list = $('#demo-steps'), next = $('#demo-next');
  const complete = demo.step === demo.steps.length;
  if (list.dataset.step !== String(demo.step)) {
    list.replaceChildren(...demo.steps.map((label, i) => {
      const item = element('li', i < demo.step ? 'complete' : '', label);
      if (i === demo.step) item.setAttribute('aria-current', 'step');
      return item;
    }));
    list.dataset.step = demo.step;
  }
  next.textContent = complete ? 'Đã chạy hết kịch bản' : demo.steps[demo.step];
  next.disabled = demoPending || complete;
}

$('#demo-next').addEventListener('click', async () => {
  const demo = state.board?.demo;
  if (!demo || demoPending) return;
  demoPending = true;
  renderDemo(demo);
  try {
    const next = await api('/api/demo/advance', 'POST', { step: demo.step });
    if (refreshing) await refreshing;
    await refresh();
    if (next.taskId && state.view === 'tasks') await selectTask(next.taskId);
  } catch (error) {
    if (refreshing) await refreshing;
    await refresh();
    showNotice(error.message, true);
  } finally {
    demoPending = false;
    renderDemo(state.board?.demo);
  }
});

function setView(view) {
  state.view = view;
  const titles = { tasks: ['Cùng làm, rõ từng việc.', 'Giao việc, trao đổi và theo dõi các agent trong một không gian.'],
    inbox: ['Trao đổi có ngữ cảnh.', 'Tin nhắn chung và yêu cầu gửi riêng cho từng bên.'],
    connections: ['Kết nối app bạn đang dùng.', 'Chọn hồ sơ app và model, rồi thử kết nối MCP.'],
    queue: ['Theo dõi từng lời nhắc.', 'Xem tiến độ chuyển và biên nhận từ đúng chat đã chọn.'] };
  for (const name of Object.keys(titles)) $(`#${name}-view`).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view);
  [$('#view-title').textContent, $('#view-subtitle').textContent] = titles[view];
  if (view === 'queue') loadQueue().catch(error => showNotice(error.message, true));
}

async function submitForm(event, work) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); }
  catch (error) { showNotice(error.message, true); }
  finally { button.disabled = false; }
}

function withRequestId(form, input) {
  const fingerprint = JSON.stringify(input);
  if (form.dataset.fingerprint !== fingerprint) { form.dataset.fingerprint = fingerprint; form.dataset.requestId = crypto.randomUUID(); }
  return { ...input, requestId: form.dataset.requestId };
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('#owner-filter').addEventListener('change', renderTasks);
$('#status-filter').addEventListener('change', renderTasks);
$('#new-task').addEventListener('click', () => $('#task-dialog').showModal());
$('#close-dialog').addEventListener('click', () => $('#task-dialog').close());
$('#task-form').addEventListener('submit', event => submitForm(event, async () => {
  const form = $('#task-form');
  const result = await api('/api/tasks', 'POST', withRequestId(form, Object.fromEntries(new FormData(form))));
  form.reset(); delete form.dataset.fingerprint;
  $('#task-dialog').close();
  setView('tasks');
  await refresh();
  await selectTask(result.task.id);
  showNotice(`Đã giao việc cho ${names[result.task.owner]}.`);
}));
$('#message-form').addEventListener('submit', event => submitForm(event, async () => {
  const form = $('#message-form');
  await api('/api/messages', 'POST', withRequestId(form, Object.fromEntries(new FormData(form))));
  form.elements.body.value = ''; delete form.dataset.fingerprint;
  await refresh();
  showNotice('Tin nhắn đã được lưu vào hộp thư.');
}));
$('#older-messages').addEventListener('click', () => loadMessages(Math.min(...state.messages.keys())).catch(error => showNotice(error.message, true)));
$('#mark-read').addEventListener('click', async () => {
  try {
    const ids = [...state.messages.values()].filter(message => !message.read_at && message.author !== 'user').map(message => message.id);
    for (let offset = 0; offset < ids.length; offset += 200) await api('/api/read', 'POST', { ids: ids.slice(offset, offset + 200) });
    state.messages.clear();
    await refresh();
    showNotice('Đã đánh dấu các tin đang hiển thị.');
  } catch (error) { showNotice(error.message, true); }
});
function renderProfileSeen() {
  const selected = state.board.agents.find(agent => agent.actor === $('#profile-select').value);
  $('#profile-seen').textContent = selected?.lastSeen ? `Lần gọi MCP cuối của hồ sơ: ${time(selected.lastSeen)}` : 'Chưa thấy hồ sơ này gọi MCP.';
}

function showAppField() {
  const form = $('#profile-form');
  const custom = form.elements.app.value === 'stdio';
  $('#profile-app-label').hidden = !custom;
  form.elements.appLabel.required = custom;
}

function fillProfile() {
  const id = $('#profile-select').value;
  const current = state.board.agents.find(agent => agent.actor === id);
  const form = $('#profile-form');
  profileKey = id || 'new';
  profileSnippet = null;
  const version = ++profileVersion;
  for (const name of ['id', 'name', 'app', 'appLabel', 'model']) form.elements[name].value = current?.[name] ?? (name === 'app' ? 'stdio' : '');
  form.elements.id.readOnly = Boolean(current);
  form.elements.app.disabled = ['codex', 'antigravity'].includes(id);
  showAppField();
  $('#profile-guide').hidden = !current;
  if (!current) return;
  renderProfileSeen();
  $('#profile-config').textContent = 'Đang tải cấu hình…';
  $('#profile-copy').disabled = true;
  api(`/api/agents/${id}`).then(config => {
    if (version !== profileVersion) return;
    profileSnippet = config.snippet;
    $('#profile-config').textContent = profileSnippet;
    $('#profile-format').textContent = current.app === 'stdio'
      ? 'Ví dụ JSON. Nếu app dùng định dạng khác, nhập cùng command và args theo phần cấu hình STDIO của app.'
      : `${config.settings} · ${config.format}. Chỉ thêm mục ${config.key}.`;
    $('#profile-rollback').textContent = `Bỏ riêng mục ${config.key} đã thêm, rồi nạp lại app. Nếu đã bật đánh thức, tắt chat đích phía dưới. Công việc và hộp thư vẫn lưu.`;
    $('#profile-copy').disabled = false;
  }).catch(error => { if (version === profileVersion) showNotice(error.message, true); });
}

$('#profile-select').addEventListener('change', fillProfile);
$('#profile-form').elements.app.addEventListener('change', showAppField);
$('#profile-form').addEventListener('submit', event => submitForm(event, async () => {
  const form = $('#profile-form'), id = $('#profile-select').value;
  const input = { ...Object.fromEntries(new FormData(form)), app: form.elements.app.value };
  const previousRefresh = refreshing;
  const saved = await api(id ? `/api/agents/${id}` : '/api/agents', id ? 'PATCH' : 'POST', input);
  if (previousRefresh) await previousRefresh;
  if (refreshing) await refreshing;
  await refresh();
  $('#profile-select').value = saved.id;
  fillProfile();
  showNotice('Đã lưu. Dùng cấu hình của hồ sơ này để kết nối app.');
}));
$('#profile-copy').addEventListener('click', async () => {
  if (!profileSnippet) return;
  try { await navigator.clipboard.writeText(profileSnippet); showNotice('Đã sao chép cấu hình hồ sơ.'); }
  catch { showNotice('Hãy chọn và sao chép cấu hình bên dưới.', true); }
});
$('#profile-check').addEventListener('click', () => refresh());
$('#support-download').addEventListener('click', async () => {
  try {
    const report = await api('/api/support');
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = 'coordinator-support.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showNotice(error.message, true); }
});

choices($('#queue-state'), [['', 'Tất cả'], ...Object.entries(queueLabels)]);
async function loadQueue() {
  if (state.board?.demo || state.view !== 'queue') return;
  const version = ++queueVersion;
  const params = new URLSearchParams();
  if ($('#queue-actor').value) params.set('actor', $('#queue-actor').value);
  if ($('#queue-state').value) params.set('state', $('#queue-state').value);
  if (queueCursor) params.set('before', queueCursor);
  const { jobs, next } = await api(`/api/wake/jobs?${params}`);
  if (version !== queueVersion || state.view !== 'queue') return;
  queueNext = next;
  $('#queue-older').hidden = !next;
  const list = $('#queue-list'), key = JSON.stringify(jobs);
  if (list.dataset.jobs === key) return;
  list.dataset.jobs = key;
  list.replaceChildren();
  if (!jobs.length) list.append(element('p', 'hint', 'Không có lời nhắc khớp với bộ lọc.'));
  for (const job of jobs) {
    const row = element('article', 'queue-row');
    row.append(element('strong', '', `#${job.id} · ${names[job.actor]} · ${queueLabels[job.delivery]}`),
      element('p', 'hint', [`Xếp hàng: ${time(job.created_at)}`, job.attempted_at && `Lần chuyển: ${time(job.attempted_at)}`,
        job.acknowledged_at && `ACK: ${time(job.acknowledged_at)}`, job.overdue && 'Đã chờ trên 2 phút'].filter(Boolean).join(' · ')));
    if (job.error) row.append(element('p', '', job.error));
    const actions = element('div', 'setup-actions');
    if (job.task_id || job.message_id) {
      const source = element('button', 'secondary', job.task_id ? 'Mở công việc' : `Mở tin #${job.message_id}`);
      source.addEventListener('click', async () => {
        try {
          if (job.task_id) { setView('tasks'); await selectTask(job.task_id); }
          else { setView('inbox'); await loadMessages(job.message_id + 1); $(`#message-${job.message_id}`)?.scrollIntoView({ block: 'center' }); }
        } catch (error) { showNotice(error.message, true); }
      });
      actions.append(source);
    }
    if (job.retry_of) actions.append(element('span', 'hint', `Gửi lại lời nhắc #${job.retry_of}`));
    if (job.delivery === 'queued' || ['failed','unknown'].includes(job.delivery)) {
      const cancel = job.delivery === 'queued';
      const button = element('button', 'secondary', cancel ? 'Hủy lời nhắc' : 'Đã kiểm chat · Gửi lại');
      button.addEventListener('click', async () => {
        if (!cancel && !window.confirm('Bạn đã kiểm tra chat và xác nhận cần gửi thêm lời nhắc?')) return;
        button.disabled = true;
        try {
          const result = await api(`/api/wake/jobs/${job.id}/${cancel ? 'cancel' : 'retry'}`, 'POST', cancel ? {} : { reviewed: true });
          if (!cancel) { queueCursor = null; $('#queue-state').value = ''; showNotice(`Lời nhắc gửi lại: #${result.id}`); }
          await loadQueue();
        } catch (error) { showNotice(error.message, true); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    row.append(actions);
    list.append(row);
  }
}
function refreshQueue(cursor) { queueCursor = cursor; loadQueue().catch(error => showNotice(error.message, true)); }
for (const id of ['queue-actor','queue-state']) $(`#${id}`).addEventListener('change', () => refreshQueue(null));
$('#queue-newest').addEventListener('click', () => refreshQueue(null));
$('#queue-older').addEventListener('click', () => { if (queueNext) refreshQueue(queueNext); });
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 3000);

function renderWake() {
  const lastSeen = state.board.wake.workerLastSeen;
  const demo = Boolean(state.board.demo);
  const report = state.board.readiness;
  $('#wake-worker-status').textContent = demo ? 'Mô phỏng worker · không kết nối app AI thật' :
    report?.workerOnline ? `Worker báo còn hoạt động · ${time(lastSeen)}` : 'Chưa thấy worker · công việc và tin nhắn vẫn dùng được qua MCP';
  const readiness = $('#wake-readiness');
  readiness.hidden = !report;
  if (report) {
    const labels = { configured: 'Đã tìm thấy tệp chạy bridge', not_configured: 'Chưa cấu hình bridge',
      config_unreadable: 'Không đọc được cấu hình bridge', invalid_config: 'Cấu hình bridge không hợp lệ',
      invalid_executable: 'Đường dẫn bridge không hợp lệ', unavailable_executable: 'Không mở được tệp chạy bridge' };
    readiness.replaceChildren(...report.agents.map(agent => {
      const card = element('div', 'wake-readiness-card');
      card.append(element('strong', '', names[agent.actor]),
        element('span', '', agent.lastMcpAt ? `Lần gọi MCP cuối: ${time(agent.lastMcpAt)}` : 'Chưa thấy gọi MCP'),
        element('span', '', `${labels[agent.bridge]} · ${agent.targetEnabled ? 'Đã bật chat đích' : 'Chưa bật chat đích'}`),
        element('span', '', `${agent.queued} chờ chuyển · ${agent.uncertain} cần kiểm tra trong chat`));
      return card;
    }));
  }
  const panel = $('#wake-targets');
  $('#wake-setup').hidden = panel.hidden = demo;
  if (!demo && !panel.childElementCount) for (const actor of ['codex', 'antigravity']) {
    const form = element('form', 'config-card');
    form.dataset.actor = actor;
    const label = element('label', '', `${names[actor]} · UUID chat đích`);
    const input = element('input'); input.name = 'conversationId'; input.required = true;
    input.pattern = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
    label.append(input);
    const mode = element('select'); mode.name = 'enabled';
    mode.add(new Option('Tắt đánh thức', 'false')); mode.add(new Option('Bật đánh thức', 'true'));
    const save = element('button', 'primary', 'Lưu chat đích'); save.type = 'submit';
    const wake = element('button', 'secondary', 'Đánh thức ngay'); wake.type = 'button';
    wake.addEventListener('click', async () => {
      wake.disabled = true;
      try { await api(`/api/wake/${actor}`, 'POST', {}); await refresh(); showNotice('Đã xếp hàng đánh thức. Xem kết quả bên dưới.'); }
      catch (error) { showNotice(error.message, true); }
      finally { wake.disabled = false; }
    });
    form.append(label, mode, save, wake);
    form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    form.addEventListener('submit', event => submitForm(event, async () => {
      await api(`/api/wake/${actor}`, 'PATCH', { conversationId: input.value.trim(), enabled: mode.value === 'true' });
      delete form.dataset.dirty; await refresh(); showNotice('Đã lưu. Chỉ áp dụng cho yêu cầu mới.');
    }));
    panel.append(form);
  }
  for (const form of panel.children) {
    const target = state.board.wake.targets.find(row => row.actor === form.dataset.actor);
    if (!form.dataset.dirty && !form.contains(document.activeElement)) {
      form.elements.conversationId.value = target?.conversation_id || '';
      form.elements.enabled.value = target?.enabled ? 'true' : 'false';
    }
  }
  const history = $('#wake-history'); history.replaceChildren();
  const descriptions = { queued: 'Chờ worker', sending: 'Đang chuyển', accepted: 'Đã chuyển · chờ chat xác nhận', failed: 'Chưa gửi được', unknown: 'Chưa rõ kết quả · kiểm tra chat trước khi thử lại', cancelled: 'Đã hủy do đổi cấu hình' };
  for (const job of state.board.wake.jobs) history.append(element('p', 'hint',
    `#${job.id} · ${names[job.actor]} · ${job.acknowledged_at ? 'Chat đã nhận qua MCP' : descriptions[job.state]} · ${time(job.created_at)}${job.error ? ` — ${job.error}` : ''}`));
  if (!history.childElementCount) history.append(element('p', 'hint', 'Chưa có yêu cầu đánh thức.'));
}
