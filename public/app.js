const $ = selector => document.querySelector(selector);
const workId = new URLSearchParams(location.search).get('workspace') || 'local';
const labels = { queued: 'Chờ nhận', in_progress: 'Đang làm', blocked: 'Đang vướng', review: 'Chờ review', done: 'Hoàn tất' };
const names = Object.assign(Object.create(null), { user: 'Bạn', codex: 'Codex', antigravity: 'Antigravity', all: 'Hộp thư chung' });
const state = { board: null, selected: null, detail: null, dirty: false, messages: new Map(), view: 'tasks' };
const detailPlaceholder = $('#task-detail').firstElementChild.cloneNode(true);
const narrowWorkspace = matchMedia('(max-width: 960px)');
let taskSelectionRequest = 0;
let noticeTimer;
let refreshing, demoPending = false;
let profileVersion = 0, profileKey, profileSnippet;
let queueVersion = 0, queueCursor = null, queueNext = null;
const queueLabels = { queued: 'Chờ chuyển', sending: 'Đang chuyển', accepted: 'Đã chuyển · chờ ACK',
  acknowledged: 'Đã ACK qua MCP', failed: 'Chưa gửi được', unknown: 'Chưa rõ kết quả', cancelled: 'Đã hủy' };
const appLabels = { codex: 'Codex', antigravity: 'Antigravity', 'claude-desktop': 'Claude Desktop', cursor: 'Cursor',
  vscode: 'VS Code', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode 2', stdio: 'MCP STDIO' };

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
  $('#notice-text').textContent = message;
  notice.className = error ? 'notice error' : 'notice';
  notice.hidden = false;
  if (!error) noticeTimer = setTimeout(() => { notice.hidden = true; }, 5500);
}

function connectionStatus(value, label) {
  const badge = $('#connection-state');
  badge.dataset.state = value;
  if (badge.textContent !== label) badge.textContent = label;
  $('#connection-retry').hidden = value !== 'offline';
}

async function api(url, method = 'GET', body) {
  const options = { method, headers: { 'X-Coordinator-Workspace': workId } };
  if (body !== undefined) {
    Object.assign(options.headers, { 'Content-Type': 'application/json', 'X-Coordinator-Token': state.board?.token || '' });
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
function ownerBadge(owner) { return element('span', `owner-chip ${owner}`, names[owner] ?? owner); }
function timeStamp(at) {
  const node = element('time', '', time(at));
  node.dateTime = new Date(at).toISOString();
  return node;
}
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
  const available = options.filter(([id]) => state.board.agents.find(agent => agent.actor === id).state === 'active');
  choices($('#owner-filter'), [['', 'Mọi agent'], ...options]);
  choices($('#task-form').elements.owner, available);
  if (!state.board.demo) $('#new-task').disabled = !available.length;
  choices($('#known-models'), [...new Set(state.board.agents.map(agent => agent.model).filter(Boolean))].map(model => [model, model]));
  choices($('#message-form').elements.recipient, [['all', names.all], ...available]);
  choices($('#queue-actor'), [['', 'Tất cả'], ...options]);
  if (choices($('#profile-select'), [...options, ['', '＋ Thêm hồ sơ mới']]) && !state.board.demo && !profileKey) {
    $('#profile-select').value = options[0]?.[0] ?? '';
    fillProfile();
  }
  renderProfileSeen();
  $('#task-count').textContent = tasks.length;
  $('#task-count').hidden = !tasks.length;
  $('#message-count').textContent = state.board.userUnread;
  $('#message-count').hidden = !state.board.userUnread;
  const agents = $('#agents');
  agents.replaceChildren();
  for (const agent of state.board.agents) {
    const card = element('div', 'agent-card');
    const info = element('div');
    const host = agent.appLabel || appLabels[agent.app];
    const extra = [host === agent.name ? '' : host, agent.model, { paused: 'Tạm ngưng', archived: 'Đã lưu trữ' }[agent.state]].filter(Boolean);
    info.append(element('div', 'agent-name', names[agent.actor]), element('div', 'agent-subtitle',
      agent.lastSeen ? `MCP · ${time(agent.lastSeen)}` : 'Chưa gọi MCP'));
    if (extra.length) info.append(element('div', 'hint', extra.join(' · ')));
    const stats = element('div', 'agent-stats');
    stats.append(element('b', '', `${tasks.filter(task => task.owner === agent.actor && task.status !== 'done').length} việc mở`),
      element('small', '', `${agent.unread} chưa đọc`));
    card.append(element('span', `avatar ${agent.actor}`, agent.name.slice(0, 1).toUpperCase()), info, stats);
    agents.append(card);
  }
  renderTasks();
  const taskSelect = $('#message-task');
  choices(taskSelect, [['', 'Trao đổi chung'], ...tasks.map(task => [task.id, `${names[task.owner]} · ${task.title}`])]);
}

const attentionStatus = status => status === 'blocked' || status === 'review';
function renderSummary() {
  const tasks = state.board.tasks;
  const summary = $('#summary');
  const rows = [
    ['', 'Tất cả công việc', tasks.length],
    ['in_progress', 'Đang làm', tasks.filter(task => task.status === 'in_progress').length],
    ['attention', 'Cần chú ý', tasks.filter(task => attentionStatus(task.status)).length],
    ['done', 'Hoàn tất', tasks.filter(task => task.status === 'done').length]
  ];
  const key = JSON.stringify(rows);
  if (summary.dataset.rows !== key) {
    const focusedFilter = summary.contains(document.activeElement) ? document.activeElement.dataset.filter : null;
    summary.dataset.rows = key;
    summary.replaceChildren(...rows.map(([value, title, count]) => {
      const card = element('button', 'stat');
      card.type = 'button';
      card.dataset.filter = value;
      const dot = element('span', 'stat-dot'); dot.setAttribute('aria-hidden', 'true');
      card.append(dot, element('span', 'stat-label', title), element('strong', '', count));
      card.setAttribute('aria-label', `${title}: ${count}`);
      card.addEventListener('click', () => {
        if (narrowWorkspace.matches && state.selected && !closeTask(false)) return;
        $('#status-filter').value = value;
        renderTasks();
      });
      return card;
    }));
    [...summary.children].find(button => button.dataset.filter === focusedFilter)?.focus({ preventScroll: true });
  }
  for (const card of summary.children)
    card.setAttribute('aria-pressed', String(card.dataset.filter === $('#status-filter').value));
}

const searchText = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd');
function resetTaskFilters() {
  $('#task-search').value = $('#owner-filter').value = $('#status-filter').value = '';
  renderTasks();
  $('#task-search').focus();
}

function renderTasks() {
  if (!state.board) return;
  const owner = $('#owner-filter').value, status = $('#status-filter').value, query = $('#task-search').value.trim();
  const tokens = query ? searchText(query).split(/\s+/) : [];
  const tasks = state.board.tasks.filter(task => {
    if (owner && task.owner !== owner) return false;
    if (status === 'attention' ? !attentionStatus(task.status) : status && task.status !== status) return false;
    if (!tokens.length) return true;
    const haystack = searchText([task.title, task.details, task.owner, names[task.owner]].filter(Boolean).join(' '));
    return tokens.every(token => haystack.includes(token));
  });
  const filtered = Boolean(owner || status || query);
  const count = filtered ? `${tasks.length}/${state.board.tasks.length} việc` : `${tasks.length} việc`;
  if ($('#filtered-count').textContent !== count) $('#filtered-count').textContent = count;
  $('#task-clear').hidden = !filtered;
  renderSummary();
  const list = $('#task-list');
  const renderKey = JSON.stringify([tasks, state.selected, filtered, tasks.map(task => names[task.owner])]);
  if (list.dataset.renderKey === renderKey) return;
  const cardFocus = list.contains(document.activeElement) ? document.activeElement.dataset.taskId : null;
  list.dataset.renderKey = renderKey;
  list.replaceChildren();
  if (!tasks.length) {
    const blank = element('div', 'empty-state'), icon = element('span', 'empty-icon', filtered ? '⌕' : '＋');
    icon.setAttribute('aria-hidden', 'true');
    blank.append(icon, element('h2', '', filtered ? 'Không có công việc phù hợp' : 'Chưa có công việc'),
      element('p', '', filtered ? 'Thử từ khóa khác hoặc xóa bộ lọc để xem lại tất cả công việc.' : 'Giao việc đầu tiên để bắt đầu theo dõi tiến độ.'));
    list.append(blank);
  }
  for (const task of tasks) {
    const card = element('button', `task-card${state.selected === task.id ? ' selected' : ''}`);
    card.type = 'button';
    card.dataset.taskId = task.id;
    card.setAttribute('aria-pressed', String(state.selected === task.id));
    const top = element('div', 'task-top');
    top.append(ownerBadge(task.owner), timeStamp(task.updated_at));
    const bottom = element('div', 'task-bottom');
    bottom.append(statusBadge(task.status), progress(task.progress), element('span', 'progress-number', `${task.progress}%`));
    card.append(top, element('h3', '', task.title), bottom);
    card.addEventListener('click', () => selectTask(task.id, { focus: true, confirmDiscard: true }).catch(error => showNotice(error.message, true)));
    list.append(card);
  }
  if (cardFocus) ([...list.children].find(card => card.dataset.taskId === cardFocus) ?? $('#task-search')).focus({ preventScroll: true });
}

function canDiscardTask() {
  return !state.dirty || window.confirm('Bạn có thay đổi chưa lưu. Quay đi và bỏ thay đổi?');
}

function closeTask(restoreFocus = true) {
  if (!canDiscardTask()) return false;
  taskSelectionRequest++;
  const was = state.selected;
  state.selected = null; state.detail = null; state.dirty = false;
  delete $('#task-workspace').dataset.detail;
  $('#task-detail').replaceChildren(detailPlaceholder.cloneNode(true));
  renderTasks();
  if (restoreFocus) (Array.from($('#task-list').children).find(card => card.dataset.taskId === was) ?? $('#task-search')).focus();
  return true;
}

async function selectTask(id, { focus = false, confirmDiscard = false } = {}) {
  if (confirmDiscard && state.selected === id && state.detail) { focusTaskTitle(); return; }
  if (confirmDiscard && !canDiscardTask()) return;
  const request = ++taskSelectionRequest;
  const detail = await api(`/api/tasks/${id}`);
  if (request !== taskSelectionRequest) return;
  state.selected = id;
  state.dirty = false;
  state.detail = detail;
  $('#task-workspace').dataset.detail = 'open';
  renderDetail(detail);
  renderTasks();
  if (focus) focusTaskTitle();
}

function focusTaskTitle() {
  const heading = $('#task-detail .detail-title');
  if (!heading || state.view !== 'tasks') return;
  heading.focus({ preventScroll: true });
  if (narrowWorkspace.matches) $('#task-detail').scrollIntoView({ block: 'start' });
}

function renderDetail({ task, review, events, messages }) {
  const panel = $('#task-detail');
  panel.replaceChildren();
  const back = element('button', 'secondary detail-back', '← Danh sách công việc');
  back.type = 'button';
  back.addEventListener('click', () => closeTask());
  const meta = element('div', 'detail-meta');
  meta.append(ownerBadge(task.owner), statusBadge(task.status), element('span', 'muted', `Giao bởi ${names[task.created_by]}`));
  const heading = element('h2', 'detail-title', task.title); heading.tabIndex = -1;
  const overview = element('div', 'detail-progress');
  overview.append(element('span', 'muted', 'Tiến độ'), element('strong', '', `${task.progress}%`), progress(task.progress));
  panel.append(back, meta, heading, element('p', 'detail-description', task.details || 'Chưa có mô tả bổ sung.'), overview);
  if (review && !state.board.demo) renderTaskWorkflow(panel, task, review);
  const form = document.createElement('form');
  form.innerHTML = `<div class="form-row"><label>Trạng thái<select name="status"></select></label><label>Tiến độ (%)<input type="number" name="progress" min="0" max="100" required></label></div>
    <label>Cập nhật mới nhất<textarea name="note" rows="3" maxlength="4000" placeholder="Đã làm gì, đang vướng gì, cần ai phản hồi…"></textarea></label>
    <label>Link Issue hoặc PR<input name="link" type="url" maxlength="2048" placeholder="https://github.com/…"></label>
    <button class="primary" type="submit">Lưu cập nhật</button>`;
  for (const [value, label] of Object.entries(labels)) if (!review || !['review','done'].includes(value)) form.elements.status.add(new Option(label, value));
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
  if (!state.board.demo && (!review || review.stage === 'work')) panel.append(form);
  else if (task.note) panel.append(element('p', 'hint', `Cập nhật cuối: ${task.note}`));
  if (!review && !state.board.demo) renderTaskWorkflow(panel, task, review);
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

function renderTaskWorkflow(panel, task, flow) {
  const section = element('section', 'workflow');
  section.append(element('h3', '', 'Bàn giao và review'));
  if (flow) {
    const steps = element('ol', 'review-track');
    const phase = { work: 0, review: 1, approval: 2, approved: 3 }[flow.stage];
    for (const [index, label] of ['Thực hiện', 'Review', 'Nghiệm thu'].entries()) {
      const item = element('li', index < phase ? 'complete' : '', label);
      const number = element('span', '', index < phase ? '✓' : index + 1);
      number.setAttribute('aria-hidden', 'true');
      item.prepend(number);
      if (index === phase) item.setAttribute('aria-current', 'step');
      steps.append(item);
    }
    section.append(steps);
    section.append(element('p', '', `${{ work:'Đang làm', review:'Chờ người review', approval:'Chờ chủ dự án duyệt', approved:'Đã nghiệm thu' }[flow.stage]} · Review: ${names[flow.reviewer] ?? flow.reviewer}`),
      element('p', 'workflow-criteria', flow.criteria));
  }
  async function save(suffix, payload) {
    await api(`/api/tasks/${task.id}/${suffix}`, 'POST', { ...payload, revision: task.revision });
    await selectTask(task.id);
    await refresh();
  }
  if (task.status !== 'done') {
    const possible = state.board.agents.filter(agent => agent.state === 'active' && agent.actor !== task.owner);
    if (flow) {
      const steps = { work: [['submit','Gửi review']], review: [['changes','Yêu cầu sửa'],['recommend','Chuyển chủ dự án duyệt']],
        approval: [['changes','Yêu cầu sửa'],['approve','Nghiệm thu công việc']] }[flow.stage] ?? [];
      if (steps.length) {
        const note = element('textarea'); note.rows = 2; note.maxLength = 3500;
        const label = element('label', '', 'Ghi chú bước tiếp theo (bắt buộc khi yêu cầu sửa)'); label.append(note);
        section.append(label);
        const row = element('div', 'setup-actions');
        for (const [action, title] of steps) {
          const button = element('button', action === 'approve' ? 'primary' : 'secondary', title);
          button.addEventListener('click', async () => {
            if (button.disabled) return;
            button.disabled = true;
            try { await save('review-action', { action, note: note.value }); }
            catch (error) { showNotice(error.message, true); }
            finally { button.disabled = false; }
          });
          row.append(button);
        }
        section.append(row);
      }
    }
    if (possible.length) {
      const settings = element('details'), reviewForm = element('form');
      settings.append(element('summary', '', flow ? 'Đổi người review hoặc tiêu chí' : 'Thêm người review và tiêu chí'));
      const select = element('select');
      select.append(...possible.map(agent => new Option(agent.name, agent.actor)));
      if (possible.some(agent => agent.actor === flow?.reviewer)) select.value = flow.reviewer;
      const reviewerLabel = element('label', '', 'Người review'); reviewerLabel.append(select);
      const criteria = element('textarea'); criteria.rows = 3; criteria.required = true; criteria.maxLength = 4000;
      criteria.value = flow?.criteria ?? '';
      const criteriaLabel = element('label', '', 'Tiêu chí nghiệm thu'); criteriaLabel.append(criteria);
      const submit = element('button', 'secondary', 'Lưu quy trình'); submit.type = 'submit';
      reviewForm.append(reviewerLabel, criteriaLabel, submit);
      reviewForm.addEventListener('submit', event => submitForm(event, () => save('review', { reviewer: select.value, criteria: criteria.value })));
      settings.append(reviewForm); section.append(settings);
      const transferable = possible.filter(agent => agent.actor !== flow?.reviewer);
      if (transferable.length) {
        const transfer = element('details'), transferForm = element('form');
        transfer.append(element('summary', '', 'Chuyển người phụ trách'));
        const owner = element('select'); owner.append(...transferable.map(agent => new Option(agent.name, agent.actor)));
        const ownerLabel = element('label', '', 'Bên nhận bàn giao'); ownerLabel.append(owner);
        const button = element('button', 'secondary', 'Chuyển việc'); button.type = 'submit';
        transferForm.append(ownerLabel, button);
        transferForm.addEventListener('submit', event => submitForm(event, () => save('transfer', { owner: owner.value })));
        transfer.append(transferForm); section.append(transfer);
      }
    }
  }
  panel.append(section);
}

function renderMessages() {
  const panel = $('#messages');
  const unread = message => !message.read_at && message.author !== 'user';
  const all = [...state.messages.values()].sort((a, b) => b.id - a.id);
  const onlyUnread = $('#inbox-unread').checked;
  const messages = onlyUnread ? all.filter(unread) : all;
  $('#mark-read').disabled = !all.some(unread);
  const key = JSON.stringify([messages, onlyUnread, messages.map(item => [names[item.author], names[item.recipient], state.board?.tasks.find(task => task.id === item.task_id)?.title])]);
  if (panel.dataset.items === key) return;
  panel.dataset.items = key;
  panel.replaceChildren();
  if (!messages.length) panel.append(element('div', 'empty-state', onlyUnread ? 'Không có tin chưa đọc trong danh sách này.' : 'Hộp thư chưa có tin nhắn.'));
  for (const message of messages) {
    const row = element('article', `message${unread(message) ? ' unread' : ''}`);
    row.id = `message-${message.id}`;
    const header = element('div', 'message-head');
    header.append(element('b', '', names[message.author]), element('span', 'muted', `→ ${names[message.recipient]}`), timeStamp(message.created_at));
    row.append(header, element('p', '', message.body));
    if (message.task_id) {
      const task = state.board?.tasks.find(item => item.id === message.task_id);
      const link = element('button', 'message-task', `↗ ${task?.title || 'Xem công việc'}`);
      link.addEventListener('click', () => { setView('tasks'); selectTask(message.task_id, { focus: true, confirmDiscard: true }).catch(error => showNotice(error.message, true)); });
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
    $('#backup-workspace-path').textContent = demo ? '' : `Kho đang xem: ${state.board.dataDirectory}`;
    connectionStatus(demo ? 'demo' : 'live', demo ? 'Dữ liệu mẫu' : 'Kho local');
    $('#new-task').hidden = Boolean(demo) || state.view !== 'tasks';
    $('#compose-panel').hidden = $('#mark-read').hidden = $('#connection-setup').hidden = Boolean(demo);
    $('#queue-nav').hidden = Boolean(demo);
    $('#workspace-controls').hidden = Boolean(demo);
    choices($('#workspace-select'), state.board.workspaces.map(space => [space.id, space.name]));
    $('#workspace-select').value = state.board.workspace;
    $('#workspace-name').textContent = demo ? 'Demo điều phối' : state.board.workspaces.find(space => space.id === state.board.workspace)?.name ?? 'Không gian mặc định';
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
    const firstFailure = $('#connection-state').dataset.state !== 'offline';
    connectionStatus('offline', 'Mất kết nối');
    if (!state.board) {
      const loading = $('#task-list .loading-copy');
      if (loading) loading.textContent = 'Chưa tải được công việc. Thử kết nối lại.';
      if (firstFailure) showNotice(error.message, true);
    }
  }
}

function renderDemo(demo) {
  $('#demo-panel').hidden = !demo;
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
  const titles = { tasks: ['Công việc', 'Giao việc, theo dõi tiến độ và review trong dự án này.'],
    inbox: ['Hộp thư', 'Đọc tin chung hoặc trao đổi riêng theo từng công việc.'],
    connections: ['Kết nối MCP', 'Quản lý hồ sơ agent, cấu hình và chat đích.'],
    queue: ['Lời nhắc', 'Kiểm tra trạng thái chuyển và biên nhận MCP.'] };
  for (const name of Object.keys(titles)) $(`#${name}-view`).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('#new-task').hidden = view !== 'tasks' || Boolean(state.board?.demo);
  [$('#view-title').textContent, $('#view-subtitle').textContent] = titles[view];
  if (view === 'queue') loadQueue().catch(error => showNotice(error.message, true));
}

async function submitForm(event, work) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  if (button.disabled) return;
  const feedback = event.currentTarget.querySelector('[data-form-error]');
  if (feedback) feedback.hidden = true;
  button.disabled = true;
  try { await work(); }
  catch (error) {
    if (feedback) { feedback.textContent = error.message; feedback.hidden = false; }
    else showNotice(error.message, true);
  }
  finally { button.disabled = false; }
}

function withRequestId(form, input) {
  const fingerprint = JSON.stringify(input);
  if (form.dataset.fingerprint !== fingerprint) { form.dataset.fingerprint = fingerprint; form.dataset.requestId = crypto.randomUUID(); }
  return { ...input, requestId: form.dataset.requestId };
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  setView(button.dataset.view);
  $('#view-title').focus({ preventScroll: true });
});
$('#owner-filter').addEventListener('change', renderTasks);
$('#status-filter').addEventListener('change', renderTasks);
$('#task-search').addEventListener('input', renderTasks);
$('#task-clear').addEventListener('click', resetTaskFilters);
$('#task-detail').addEventListener('input', () => { state.dirty = true; });
$('#inbox-unread').addEventListener('change', renderMessages);
$('#notice-close').addEventListener('click', () => { $('#notice').hidden = true; clearTimeout(noticeTimer); });
$('#connection-retry').addEventListener('click', async () => {
  await refresh();
  if ($('#connection-state').dataset.state !== 'offline') $('#notice').hidden = true;
});
$('#agents-manage').addEventListener('click', () => { setView('connections'); $('#view-title').focus(); });
$('#new-task').addEventListener('click', () => {
  $('[data-form-error]').hidden = true;
  $('#task-dialog').showModal();
  $('#task-form').elements.title.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing ||
      event.target.closest?.('input, textarea, select, [contenteditable]') || $('#task-dialog').open || !state.board || state.view !== 'tasks') return;
  if (narrowWorkspace.matches && state.selected && !closeTask(false)) return;
  event.preventDefault();
  $('#task-search').focus();
});
const taskTemplates = {
  implementation: 'Mục tiêu:\n\nPhạm vi thay đổi:\n\nCách kiểm thử:\n\nTiêu chí nghiệm thu:\n',
  review: 'PR / phiên bản cần review:\n\nĐiểm cần chú ý:\n\nKiểm thử kỳ vọng:\n\nKết quả cần bàn giao:\n',
  research: 'Câu hỏi cần trả lời:\n\nNguồn và giới hạn:\n\nCác phương án:\n\nĐề xuất và lý do:\n'
};
$('#task-template').addEventListener('change', event => {
  const details = $('#task-form').elements.details;
  if (!details.value.trim() || Object.values(taskTemplates).includes(details.value)) details.value = taskTemplates[event.target.value] ?? '';
});
function switchWorkspace(id) {
  const url = new URL(location.href);
  if (id === 'local') url.searchParams.delete('workspace');
  else url.searchParams.set('workspace', id);
  location.assign(url);
}
$('#workspace-select').addEventListener('change', event => switchWorkspace(event.target.value));
$('#workspace-form').addEventListener('submit', event => submitForm(event, async () => {
  const created = await api('/api/workspaces', 'POST', Object.fromEntries(new FormData(event.currentTarget)));
  switchWorkspace(created.id);
}));
$('#close-dialog').addEventListener('click', () => $('#task-dialog').close());
$('#task-form').addEventListener('submit', event => submitForm(event, async () => {
  const form = $('#task-form');
  const result = await api('/api/tasks', 'POST', withRequestId(form, Object.fromEntries(new FormData(form))));
  form.reset(); delete form.dataset.fingerprint;
  $('#task-search').value = $('#owner-filter').value = $('#status-filter').value = '';
  $('#task-dialog').close();
  setView('tasks');
  await refresh();
  await selectTask(result.task.id, { focus: true });
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
  $('#profile-life').hidden = !selected;
  $('#profile-life-status').textContent = selected ? { active: 'Đang hoạt động', paused: 'Đã tạm ngưng', archived: 'Đã lưu trữ' }[selected.state] : '';
  $('#profile-toggle').textContent = selected?.state === 'active' ? 'Tạm ngưng' : 'Kích hoạt lại';
  $('#profile-archive').hidden = selected?.state === 'archived';
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
  renderProfileSeen();
  if (!current) return;
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
for (const id of ['profile-toggle','profile-archive']) $(`#${id}`).addEventListener('click', async event => {
  const button = event.currentTarget;
  const profile = state.board.agents.find(agent => agent.actor === $('#profile-select').value);
  if (!profile) return;
  const next = id === 'profile-archive' ? 'archived' : profile.state === 'active' ? 'paused' : 'active';
  button.disabled = true;
  try {
    await api(`/api/agents/${profile.actor}/state`, 'PATCH', { state: next });
    if (refreshing) await refreshing;
    await refresh();
  } catch (error) { showNotice(error.message, true); }
  finally { button.disabled = false; }
});
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
    const row = element('article', 'queue-row'), header = element('div', 'queue-header');
    header.append(element('strong', '', `#${job.id} · ${names[job.actor]}`), element('span', `status ${job.delivery}`, queueLabels[job.delivery]));
    if (job.overdue) header.append(element('span', 'queue-wait', 'Đã chờ trên 2 phút'));
    row.append(header,
      element('p', 'hint', [`Xếp hàng: ${time(job.created_at)}`, job.attempted_at && `Lần chuyển: ${time(job.attempted_at)}`,
        job.acknowledged_at && `ACK: ${time(job.acknowledged_at)}`].filter(Boolean).join(' · ')));
    if (job.error) row.append(element('p', '', job.error));
    const actions = element('div', 'setup-actions');
    if (job.task_id || job.message_id) {
      const source = element('button', 'secondary', job.task_id ? 'Mở công việc' : `Mở tin #${job.message_id}`);
      source.addEventListener('click', async () => {
        try {
          if (job.task_id) { setView('tasks'); await selectTask(job.task_id, { focus: true, confirmDiscard: true }); }
          else {
            setView('inbox'); $('#inbox-unread').checked = false;
            await loadMessages(job.message_id + 1); $(`#message-${job.message_id}`)?.scrollIntoView({ block: 'center' });
          }
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
      invalid_executable: 'Đường dẫn bridge không hợp lệ', unavailable_executable: 'Không mở được tệp chạy bridge',
      missing_password: 'Worker chưa có mật khẩu OpenCode' };
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
  const wakeAgents = (report?.agents ?? []).map(entry => state.board.agents.find(agent => agent.actor === entry.actor))
    .filter(agent => agent?.state === 'active');
  for (const form of [...panel.children]) if (!wakeAgents.some(agent => agent.actor === form.dataset.actor)) form.remove();
  for (const agent of wakeAgents) {
    const actor = agent.actor;
    if ([...panel.children].some(form => form.dataset.actor === actor && form.dataset.app === agent.app)) continue;
    [...panel.children].find(form => form.dataset.actor === actor)?.remove();
    const form = element('form', 'config-card');
    form.dataset.actor = actor;
    form.dataset.app = agent.app;
    const openCode = agent.app === 'opencode';
    const label = element('label', '', `${names[actor]} · ${openCode ? 'ID session (ses…)' : 'UUID chat đích'}`);
    const input = element('input'); input.name = 'conversationId'; input.required = true;
    input.pattern = openCode ? 'ses[A-Za-z0-9_\\-]{1,120}' : '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
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
