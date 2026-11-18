const $ = selector => document.querySelector(selector);
const labels = { queued: 'Chờ nhận', in_progress: 'Đang làm', blocked: 'Đang vướng', review: 'Chờ review', done: 'Hoàn tất' };
const names = { user: 'Bạn', codex: 'Codex', antigravity: 'Antigravity', all: 'Hộp thư chung' };
const state = { board: null, selected: null, detail: null, dirty: false, messages: new Map(), view: 'tasks' };
let noticeTimer;
let refreshing, demoPending = false;

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
      agent.lastSeen ? `MCP truy cập lúc ${time(agent.lastSeen)}` : 'Chờ app truy cập MCP'));
    const stats = element('div', 'agent-stats');
    stats.append(element('b', '', `${tasks.filter(task => task.owner === agent.actor && task.status !== 'done').length} việc đang mở`),
      element('small', '', `${agent.unread} tin chưa xác nhận đọc`));
    card.append(element('span', `avatar ${agent.actor}`, agent.actor === 'codex' ? '⌘' : 'A'), info, stats);
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
    renderDemo(demo);
    renderBoard();
    renderWake();
    if (state.board.connection) {
      $('#codex-config').textContent = state.board.connection.codex;
      $('#antigravity-config').textContent = state.board.connection.antigravity;
      $('#agent-instructions').textContent = state.board.connection.instructions;
    }
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
  const titles = { tasks: ['Cùng làm, rõ từng việc.', 'Giao việc, trao đổi và theo dõi hai bên trong một không gian.'],
    inbox: ['Trao đổi có ngữ cảnh.', 'Tin nhắn chung và yêu cầu gửi riêng cho từng bên.'],
    connections: ['Nối hai app đang dùng.', 'Cấu hình MCP để Codex và Antigravity dùng chung trạm phối hợp.'] };
  for (const name of Object.keys(titles)) $(`#${name}-view`).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view);
  [$('#view-title').textContent, $('#view-subtitle').textContent] = titles[view];
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
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.board.connection[button.dataset.copy]); showNotice('Đã sao chép.'); }
  catch { showNotice('Hãy chọn và sao chép nội dung cấu hình bên dưới.', true); }
});
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
