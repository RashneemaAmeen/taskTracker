// Browser code for the ERP Rebuild Task Tracker.
// It asks the backend for data with fetch(), then builds the page from the JSON it receives.
// User-entered text is always added with textContent (never innerHTML), so it cannot run as code.

'use strict';

const $ = id => document.getElementById(id);
const REFRESH_EVERY_MS = 30000;
const PAGES = ['overview', 'tasks', 'trash'];

// Everything the page currently knows. The server is the source of truth; this is a copy.
const state = {
  meta: null,          // team, modules, priorities, statuses (from /api/meta)
  tasks: [],           // tasks matching the current filters
  dashboard: null,     // numbers for the current filters, plus workload and module counts
  totals: null,        // summary numbers for ALL tasks (used on the Overview page)
  trash: [],           // tasks in Trash
  page: 'tasks',       // 'overview', 'tasks' or 'trash'
  view: readSetting('view') === 'board' ? 'board' : 'table',
  filters: { q: '', assignee: '', module: '', priority: '', status: '', overdue: false },
  loaded: false,
  snapshot: ''         // last data received, to skip re-drawing when nothing changed
};

/* ---------- Small helpers ---------- */

function readSetting(key) {
  try { return localStorage.getItem(`erp-tracker-${key}`); } catch { return null; }
}
function saveSetting(key, value) {
  try { localStorage.setItem(`erp-tracker-${key}`, value); } catch { /* private window: ignore */ }
}

// Creates an element. Strings passed as children become plain text.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

const slug = text => text.toLowerCase().replace(/[^a-z]+/g, '-');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const OLD_NAME_HELP = 'Saved before the module list changed. Edit the task to choose a current module.';

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai'
});
const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Dubai' });

const formatDate = value => dateFormat.format(new Date(`${value}T00:00:00Z`));      // "YYYY-MM-DD" due dates
const formatDateTime = value => dateTimeFormat.format(new Date(value));            // timestamps, shown in Dubai time

/* ---------- Talking to the backend ---------- */

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check that the app is running, then try again.');
  }
  let data = null;
  if (response.status !== 204) {
    try { data = await response.json(); } catch { /* not JSON */ }
  }
  if (!response.ok) throw new ApiError(response.status, data?.error || `The request failed (${response.status}).`, data);
  return data;
}

function filterQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.filters)) {
    if (value === true) params.set(key, 'true');
    else if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

const hasFilters = () => Object.values(state.filters).some(Boolean);

let loadNumber = 0;

// Loads tasks, counts and Trash together, then redraws only if something changed.
async function load({ force = false } = {}) {
  const thisLoad = ++loadNumber;
  const query = filterQuery();
  try {
    const [list, dashboard, trash, unfiltered] = await Promise.all([
      api('GET', `/api/tasks${query}`),
      api('GET', `/api/dashboard${query}`),
      api('GET', '/api/trash'),
      query ? api('GET', '/api/dashboard') : null      // totals for the Overview page
    ]);
    if (thisLoad !== loadNumber) return;          // a newer request has started; ignore this answer
    $('load-error').hidden = true;
    const totals = (unfiltered || dashboard).summary;
    const snapshot = JSON.stringify([list, dashboard, trash, totals]);
    if (force || !state.loaded || snapshot !== state.snapshot) {
      state.tasks = list.tasks;
      state.dashboard = dashboard;
      state.totals = totals;
      state.trash = trash.tasks;
      state.snapshot = snapshot;
      state.loaded = true;
      render();
    }
    $('last-updated').textContent = `Updated ${clockFormat.format(new Date())}`;
  } catch (error) {
    if (thisLoad !== loadNumber) return;
    // The module being filtered no longer exists (for example an older name was just mapped):
    // drop that one filter and load again.
    if (error.status === 400 && error.data.fields?.module && state.filters.module) {
      state.filters.module = '';
      syncFilterInputs();
      return load({ force });
    }
    showLoadError(state.loaded ? `Could not refresh: ${error.message} The data shown may be out of date.` : error.message);
    if (!state.loaded) {
      for (const id of ['task-loading', 'trash-loading', 'overview-loading']) $(id).hidden = true;
    }
  }
}

function showLoadError(message) {
  $('load-error-text').textContent = message;
  $('load-error').hidden = false;
}

/* ---------- Toast messages ---------- */

function toast(message, type = 'success') {
  const item = el('div', { class: `toast toast-${type}` },
    el('span', { text: message }),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss message', text: '×', onclick: () => item.remove() })
  );
  $('toasts').append(item);
  setTimeout(() => item.remove(), type === 'error' ? 9000 : 5000);
}

/* ---------- Confirmation dialog ---------- */

function confirmAction({ title, message, confirmLabel, danger = false }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = confirmLabel;
  $('confirm-ok').className = danger ? 'btn danger' : 'btn primary';
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
    $('confirm-cancel').focus();               // the safe choice has focus first
  });
}

/* ---------- Reusable pieces of the page ---------- */

const badge = (kind, value) => el('span', { class: `badge ${kind}-${slug(value)}`, text: value });

function avatar(name) {
  if (!name) return el('span', { class: 'avatar avatar-none', 'aria-hidden': 'true', text: '–' });
  const index = state.meta.team.indexOf(name);
  return el('span', { class: `avatar avatar-${index}`, 'aria-hidden': 'true', text: name.slice(0, 2).toUpperCase() });
}

function person(name) {
  return el('span', { class: 'person' }, avatar(name), el('span', { class: name ? '' : 'muted', text: name || 'Unassigned' }));
}

const oldNameTag = () => el('span', { class: 'tag-old', title: OLD_NAME_HELP, text: 'old name' });

// A task's module. Names from before the module list changed are kept and marked "old name".
function moduleLabel(task) {
  if (!task.moduleIsOlderName) return el('span', { text: task.module });
  return el('span', { class: 'module-older' }, el('span', { text: task.module }), oldNameTag());
}

// Fills a module dropdown: ERP modules, cross-module categories, then any older names passed in.
function fillModuleSelect(select, { firstLabel = null, olderNames = [] } = {}) {
  const groups = state.meta.moduleGroups.map(group =>
    el('optgroup', { label: group.label }, group.options.map(name => el('option', { value: name, text: name }))));
  if (olderNames.length) {
    groups.push(el('optgroup', { label: 'Older names (still used by existing tasks)' },
      olderNames.map(name => el('option', { value: name, text: `${name} (old name)` }))));
  }
  select.replaceChildren(...(firstLabel === null ? [] : [el('option', { value: '', text: firstLabel })]), ...groups);
}

function dueInfo(task) {
  if (!task.dueDate) return el('span', { class: 'muted', text: 'No due date' });
  const parts = [el('span', { text: formatDate(task.dueDate) })];
  if (task.isOverdue) parts.push(el('span', { class: 'badge due-overdue', text: 'Overdue' }));
  else if (task.dueDate === state.dashboard?.today && task.status !== 'Completed' && !task.deletedAt) {
    parts.push(el('span', { class: 'badge due-today', text: 'Due today' }));
  }
  return el('span', { class: 'due' }, parts);
}

// A dropdown that saves the new status as soon as it is changed.
function statusSelect(task, keyPrefix) {
  const select = el('select', {
    class: `status-select status-${slug(task.status)}`,
    'aria-label': `Status of ${task.reference}`,
    dataset: { focusKey: `${keyPrefix}-status-${task.id}` }
  }, state.meta.statuses.map(status => el('option', { value: status, text: status, selected: status === task.status })));
  select.addEventListener('change', () => changeStatus(task, select.value, select));
  return select;
}

async function changeStatus(task, status, select) {
  // A disabled control loses keyboard focus, so remember it and give it back after redrawing.
  const focusKey = document.activeElement === select ? select.dataset.focusKey : null;
  select.disabled = true;
  try {
    await api('PATCH', `/api/tasks/${task.id}`, { version: task.version, status });
    toast(`${task.reference} is now “${status}”.`);
  } catch (error) {
    toast(error.data.code === 'VERSION_CONFLICT'
      ? `${task.reference} was changed by someone else, so your status change was not saved. The latest version is now shown. Please check it and try again.`
      : error.message, 'error');
  }
  await load({ force: true });
  if (detail && detail.task.id === task.id && $('detail-dialog').open) await refreshDetail();
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

function emptyState(title, text, action) {
  return [el('h3', { text: title }), el('p', { text }), action].filter(Boolean);
}

// A thin bar showing how much of the work is completed.
function progressBar(completed, total) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const bar = el('span', { class: 'progress', role: 'img', 'aria-label': total ? `${percent}% completed` : 'No tasks yet' },
    el('span', { class: 'progress-fill' }));
  bar.firstChild.style.width = `${percent}%`;
  return bar;
}

/* ---------- Drawing: everything ---------- */

function render() {
  // Remember which control had keyboard focus so it can be given back after redrawing.
  const focusKey = document.activeElement?.dataset?.focusKey;
  renderSummaries();
  renderSidebar();
  renderOverview();
  renderTasks();
  renderTrash();
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

/* ---------- Summary strips ---------- */

function fillSummary(container, summary) {
  const items = [
    ['Total tasks', summary.active, 'Every task that is not in Trash', ''],
    ['In Progress', summary.inProgress, 'Being worked on now', 'stat-progress'],
    ['Completed', summary.completed, 'Finished tasks', 'stat-completed'],
    ['Overdue', summary.overdue, 'Due before today (Dubai time) and not completed', 'stat-overdue']
  ];
  container.replaceChildren(...items.map(([label, value, help, className]) =>
    el('div', { class: `stat ${className}`, title: help },
      el('span', { class: 'stat-value', text: String(value) }),
      el('span', { class: 'stat-label', text: label }))));
}

function renderSummaries() {
  const filtered = state.dashboard.scope === 'filtered';
  const scope = $('dashboard-scope');
  scope.textContent = filtered ? 'Counts cover filtered results only' : 'Counts cover all tasks';
  scope.classList.toggle('scope-filtered', filtered);
  $('task-summary').setAttribute('aria-label', filtered ? 'Task totals, filtered results only' : 'Task totals, all tasks');
  fillSummary($('task-summary'), state.dashboard.summary);
  fillSummary($('overview-summary'), state.totals);
  $('overview-loading').hidden = true;
}

/* ---------- Sidebar: team and module filters ---------- */

function sideFilterButton({ key, value, label, count, leading, older = false, countHelp }) {
  const active = state.filters[key] === value;
  return el('li', {},
    el('button', {
      type: 'button',
      class: `side-filter${count === 0 ? ' side-filter-empty' : ''}`,
      'aria-pressed': String(active),
      dataset: { focusKey: `side-${key}-${value}` },
      onclick: () => {
        state.filters[key] = active ? '' : value;
        syncFilterInputs();
        setPage('tasks');
        closeSidebar();
        load();
      }
    },
      leading,
      el('span', { class: 'side-filter-name' }, label, older ? oldNameTag() : null),
      el('span', { class: 'side-count', title: countHelp, text: String(count) })));
}

function renderSidebar() {
  const { workload, unassigned, modules } = state.dashboard;

  const pill = $('trash-count');
  pill.hidden = state.trash.length === 0;
  pill.textContent = String(state.trash.length);
  pill.setAttribute('aria-label', `${plural(state.trash.length, 'task')} in Trash`);

  // Team: the number is pending (not completed) tasks.
  const team = workload.map(member => sideFilterButton({
    key: 'assignee', value: member.name, label: member.name, count: member.pending,
    leading: avatar(member.name), countHelp: `${member.pending} pending, ${member.completed} completed`
  }));
  if (unassigned.pending + unassigned.completed > 0) {
    team.push(sideFilterButton({
      key: 'assignee', value: state.meta.unassignedLabel, label: 'Unassigned', count: unassigned.pending,
      leading: avatar(null), countHelp: `${unassigned.pending} pending, ${unassigned.completed} completed`
    }));
  }
  $('team-filters').replaceChildren(...team);

  // Modules: the number is all tasks filed under the module (pending + completed).
  const moduleButton = item => sideFilterButton({
    key: 'module', value: item.name, label: item.name, count: item.pending + item.completed, older: item.olderName,
    countHelp: `${item.pending} pending, ${item.completed} completed`
  });
  const older = modules.filter(item => item.olderName);
  const groups = [
    ...state.meta.moduleGroups.map(group => [group.label, modules.filter(item => group.options.includes(item.name))]),
    ['Older names', older]
  ].filter(([, items]) => items.length);
  $('module-filters').replaceChildren(...groups.flatMap(([label, items]) => [
    el('h3', { class: 'side-subheading', text: label }),
    el('ul', { class: 'side-list' }, items.map(moduleButton))
  ]));

  // The module dropdown above the task list also offers older names while tasks still use them.
  const select = $('filter-module');
  const signature = older.map(item => item.name).join('|');
  if (select.dataset.older !== signature) {
    fillModuleSelect(select, { firstLabel: 'All modules', olderNames: older.map(item => item.name) });
    select.dataset.older = signature;
    select.value = state.filters.module;
  }
}

/* ---------- Overview page ---------- */

function showTasksFor(key, value) {
  state.filters = { q: '', assignee: '', module: '', priority: '', status: '', overdue: false, [key]: value };
  syncFilterInputs();
  setPage('tasks');
  load();
}

function renderOverview() {
  const { workload, unassigned, modules } = state.dashboard;

  const memberRow = (name, counts, filterValue) => {
    const total = counts.pending + counts.completed;
    return el('li', { class: 'workload-row' },
      avatar(name === 'Unassigned' ? null : name),
      el('span', { class: 'workload-name', text: name }),
      el('span', { class: 'workload-counts' },
        el('span', { class: 'count-pending', text: `${counts.pending} pending` }),
        el('span', { class: 'count-done', text: `${counts.completed} completed` })),
      progressBar(counts.completed, total),
      el('button', { type: 'button', class: 'btn-link', text: 'View tasks',
        'aria-label': `View ${name === 'Unassigned' ? 'unassigned tasks' : `${name}'s tasks`}`,
        dataset: { focusKey: `workload-${filterValue}` },
        onclick: () => showTasksFor('assignee', filterValue) }));
  };
  const rows = workload.map(member => memberRow(member.name, member, member.name));
  if (unassigned.pending + unassigned.completed > 0) rows.push(memberRow('Unassigned', unassigned, state.meta.unassignedLabel));
  $('workload').replaceChildren(...rows);

  const moduleRow = item => {
    const total = item.pending + item.completed;
    return el('li', { class: `module-row${total === 0 ? ' module-row-empty' : ''}` },
      el('button', { type: 'button', class: 'module-row-name', 'aria-label': `View tasks in ${item.name}`,
        dataset: { focusKey: `module-row-${item.name}` }, onclick: () => showTasksFor('module', item.name) },
        item.name),
      item.olderName ? oldNameTag() : null,
      el('span', { class: 'workload-counts' },
        el('span', { class: 'count-pending', text: `${item.pending} pending` }),
        el('span', { class: 'count-done', text: `${item.completed} completed` })),
      progressBar(item.completed, total));
  };
  const older = modules.filter(item => item.olderName);
  const groups = [
    ...state.meta.moduleGroups.map(group => [group.label, modules.filter(item => group.options.includes(item.name))]),
    ['Older names (not yet mapped)', older]
  ].filter(([, items]) => items.length);
  $('module-rows').replaceChildren(...groups.map(([label, items]) =>
    el('div', { class: 'module-group' }, el('h4', { text: label }), el('ul', { class: 'module-list' }, items.map(moduleRow)))));
  $('module-older-note').hidden = older.length === 0;
}

/* ---------- Tasks page ---------- */

function renderTasks() {
  const tasks = state.tasks;
  $('task-loading').hidden = true;
  $('result-count').textContent = hasFilters()
    ? `${plural(tasks.length, 'task')} match the filters`
    : plural(tasks.length, 'task');
  $('clear-filters').disabled = !hasFilters();

  const empty = $('task-empty');
  const table = $('task-table');
  const board = $('task-board');
  for (const button of document.querySelectorAll('.toggle')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }

  if (!tasks.length) {
    table.hidden = true;
    board.hidden = true;
    empty.hidden = false;
    empty.replaceChildren(...(hasFilters()
      ? emptyState('No tasks match your search and filters', 'Try different filters, or clear them to see every task.',
          el('button', { type: 'button', class: 'btn', text: 'Clear filters', onclick: clearFilters }))
      : emptyState('No tasks yet', 'Create the first task for the ERP rebuild.',
          el('button', { type: 'button', class: 'btn primary', text: '+ New task', onclick: () => openForm(null) }))));
    return;
  }

  empty.hidden = true;
  table.hidden = state.view !== 'table';
  board.hidden = state.view !== 'board';
  if (state.view === 'table') renderTable(tasks); else renderBoard(tasks);
}

function titleButton(task) {
  return el('button', {
    type: 'button', class: 'link-title', text: task.title,
    'aria-label': `Open ${task.reference}: ${task.title}`,
    dataset: { focusKey: `title-${task.id}` },
    onclick: () => openDetail(task.id)
  });
}

const commentNote = task => (task.commentCount
  ? el('span', { class: 'comment-count', text: plural(task.commentCount, 'comment') })
  : null);

// The task cell in the table: title, with its module and comment count on a quieter second line.
function taskCell(task) {
  return el('div', { class: 'title-stack' },
    titleButton(task),
    el('div', { class: 'task-sub' }, moduleLabel(task), commentNote(task)));
}

function renderTable(tasks) {
  const headings = ['Reference', 'Task and module', 'Assigned to', 'Priority', 'Status', 'Due date', 'Actions'];
  const cell = (label, className, ...content) => el('td', { 'data-label': label, class: className }, content);

  const rows = tasks.map(task => el('tr', { class: task.isOverdue ? 'row-overdue' : '' },
    cell('Reference', 'cell-ref', el('span', { class: 'reference', text: task.reference })),
    cell('Task', 'cell-title', taskCell(task)),
    cell('Assigned to', '', person(task.assignee)),
    cell('Priority', '', badge('priority', task.priority)),
    cell('Status', '', statusSelect(task, 'table')),
    cell('Due date', 'cell-due', dueInfo(task)),
    cell('Actions', 'cell-actions',
      el('button', { type: 'button', class: 'btn-quiet', text: 'Edit', 'aria-label': `Edit ${task.reference}`,
        dataset: { focusKey: `edit-${task.id}` }, onclick: () => openForm(task) }),
      el('button', { type: 'button', class: 'btn-quiet', text: 'Move to Trash', 'aria-label': `Move ${task.reference} to Trash`,
        dataset: { focusKey: `trash-${task.id}` }, onclick: () => moveToTrash(task) }))
  ));

  $('task-table').replaceChildren(el('table', { class: 'data-table' },
    el('caption', { class: 'sr-only', text: 'Tasks' }),
    el('thead', {}, el('tr', {}, headings.map(text => el('th', { scope: 'col', text })))),
    el('tbody', {}, rows)));
}

function renderBoard(tasks) {
  const columns = state.meta.statuses.map(status => {
    const inColumn = tasks.filter(task => task.status === status);
    const cards = inColumn.map(task => el('li', { class: `board-card${task.isOverdue ? ' board-card-overdue' : ''}` },
      el('div', { class: 'board-card-top' },
        el('span', { class: 'reference', text: task.reference }),
        badge('priority', task.priority)),
      titleButton(task),
      el('p', { class: 'board-module' }, moduleLabel(task)),
      el('div', { class: 'board-card-meta' }, person(task.assignee), dueInfo(task)),
      el('div', { class: 'board-card-foot' },
        statusSelect(task, 'board'),
        el('button', { type: 'button', class: 'btn-quiet', text: 'Edit', 'aria-label': `Edit ${task.reference}`,
          dataset: { focusKey: `board-edit-${task.id}` }, onclick: () => openForm(task) }))));
    const headingId = `board-${slug(status)}`;
    return el('section', { class: `board-column column-${slug(status)}`, 'aria-labelledby': headingId },
      el('h3', { id: headingId }, el('span', { class: 'column-dot', 'aria-hidden': 'true' }), status,
        el('span', { class: 'column-count', text: String(inColumn.length) })),
      inColumn.length ? el('ul', { class: 'board-list' }, cards) : el('p', { class: 'board-empty', text: 'No tasks' }));
  });
  $('task-board').replaceChildren(...columns);
}

/* ---------- Trash page ---------- */

function renderTrash() {
  const trash = state.trash;
  $('trash-loading').hidden = true;
  $('trash-empty').hidden = trash.length > 0;
  $('trash-table').hidden = trash.length === 0;
  if (!trash.length) {
    $('trash-empty').replaceChildren(...emptyState('Trash is empty', 'Tasks you move to Trash appear here and can be restored.'));
    return;
  }

  const headings = ['Reference', 'Title', 'ERP module', 'Assigned to', 'Moved to Trash', 'Actions'];
  const cell = (label, className, ...content) => el('td', { 'data-label': label, class: className }, content);
  const rows = trash.map(task => el('tr', {},
    cell('Reference', 'cell-ref', el('span', { class: 'reference', text: task.reference })),
    cell('Title', 'cell-title', el('div', { class: 'title-stack' }, titleButton(task), commentNote(task))),
    cell('ERP module', 'cell-module', moduleLabel(task)),
    cell('Assigned to', '', person(task.assignee)),
    cell('Moved to Trash', '', formatDateTime(task.deletedAt)),
    cell('Actions', 'cell-actions',
      el('button', { type: 'button', class: 'btn small', text: 'Restore', 'aria-label': `Restore ${task.reference}`,
        dataset: { focusKey: `restore-${task.id}` }, onclick: () => restoreTask(task) }),
      el('button', { type: 'button', class: 'btn small danger-outline', text: 'Delete permanently', 'aria-label': `Delete ${task.reference} permanently`,
        dataset: { focusKey: `destroy-${task.id}` }, onclick: () => deletePermanently(task) }))));

  $('trash-table').replaceChildren(el('table', { class: 'data-table' },
    el('caption', { class: 'sr-only', text: 'Tasks in Trash' }),
    el('thead', {}, el('tr', {}, headings.map(text => el('th', { scope: 'col', text })))),
    el('tbody', {}, rows)));
}

/* ---------- Trash actions ---------- */

async function moveToTrash(task) {
  const confirmed = await confirmAction({
    title: `Move ${task.reference} to Trash?`,
    message: `“${task.title}” will be hidden from the overview, lists and search. You can restore it from Trash at any time.`,
    confirmLabel: 'Move to Trash'
  });
  if (!confirmed) return false;
  try {
    await api('POST', `/api/tasks/${task.id}/trash`);
    toast(`${task.reference} moved to Trash. You can restore it from the Trash page.`);
  } catch (error) {
    toast(error.message, 'error');
  }
  await load({ force: true });
  return true;
}

async function restoreTask(task) {
  try {
    await api('POST', `/api/trash/${task.id}/restore`);
    toast(`${task.reference} restored with its details and comments.`);
  } catch (error) {
    toast(error.message, 'error');
  }
  await load({ force: true });
}

async function deletePermanently(task) {
  const confirmed = await confirmAction({
    title: `Delete ${task.reference} permanently?`,
    message: `“${task.title}” and its ${plural(task.commentCount, 'comment')} will be deleted for good. This cannot be undone.`,
    confirmLabel: 'Delete permanently',
    danger: true
  });
  if (!confirmed) return false;
  try {
    await api('DELETE', `/api/trash/${task.id}`);
    toast(`${task.reference} was permanently deleted.`);
  } catch (error) {
    toast(error.message, 'error');
  }
  await load({ force: true });
  return true;
}

/* ---------- Filters above the task list ---------- */

function fillSelect(select, options, firstLabel) {
  select.replaceChildren(
    ...(firstLabel === null ? [] : [el('option', { value: '', text: firstLabel })]),
    ...options.map(option => el('option', { value: option, text: option })));
}

function setFilter(key, value) {
  state.filters[key] = value;
  syncFilterInputs();
  load();
}

function syncFilterInputs() {
  $('filter-q').value = state.filters.q;
  $('filter-assignee').value = state.filters.assignee;
  $('filter-module').value = state.filters.module;
  $('filter-priority').value = state.filters.priority;
  $('filter-status').value = state.filters.status;
  $('filter-overdue').checked = state.filters.overdue;
  $('clear-filters').disabled = !hasFilters();
  // Filters that are switched on are highlighted.
  for (const key of ['assignee', 'module', 'priority', 'status']) {
    $(`filter-${key}`).classList.toggle('is-active', Boolean(state.filters[key]));
  }
  $('filter-overdue').closest('.pill-check').classList.toggle('is-active', state.filters.overdue);
}

function clearFilters() {
  state.filters = { q: '', assignee: '', module: '', priority: '', status: '', overdue: false };
  syncFilterInputs();
  load();
  $('filter-q').focus();
}

function setUpFilters() {
  const { team, priorities, statuses, unassignedLabel } = state.meta;
  fillSelect($('filter-assignee'), [...team, unassignedLabel], 'Everyone');
  fillModuleSelect($('filter-module'), { firstLabel: 'All modules' });
  $('filter-module').dataset.older = '';
  fillSelect($('filter-priority'), priorities, 'All priorities');
  fillSelect($('filter-status'), statuses, 'All statuses');

  for (const key of ['assignee', 'module', 'priority', 'status']) {
    $(`filter-${key}`).addEventListener('change', event => setFilter(key, event.target.value));
  }
  $('filter-overdue').addEventListener('change', event => setFilter('overdue', event.target.checked));

  let typingTimer;
  $('filter-q').addEventListener('input', event => {
    clearTimeout(typingTimer);                    // wait until typing pauses before searching
    typingTimer = setTimeout(() => {
      state.filters.q = event.target.value.trim();
      $('clear-filters').disabled = !hasFilters();
      load();
    }, 250);
  });
  $('filters').addEventListener('submit', event => event.preventDefault());
  $('clear-filters').addEventListener('click', clearFilters);
}

/* ---------- Add / edit task form ---------- */

const FORM_FIELDS = ['title', 'description', 'module', 'assignee', 'priority', 'status', 'dueDate'];
const FIELD_LABELS = {
  title: 'Title', description: 'Description', module: 'ERP module', assignee: 'Assigned to',
  priority: 'Priority', status: 'Status', dueDate: 'Due date'
};
let formContext = null;   // { original: task being edited (or null), initial: values when opened, reopenDetail }

function formValues() {
  const form = $('task-form').elements;
  return {
    title: form.title.value.trim(),
    description: form.description.value.trim(),
    module: form.module.value,
    assignee: form.assignee.value || null,
    priority: form.priority.value,
    status: form.status.value,
    dueDate: form.dueDate.value || null
  };
}

function fillForm(values) {
  const form = $('task-form').elements;
  form.title.value = values.title;
  form.description.value = values.description;
  form.module.value = values.module;
  form.assignee.value = values.assignee || '';
  form.priority.value = values.priority;
  form.status.value = values.status;
  form.dueDate.value = values.dueDate || '';
}

function clearFormMessages() {
  $('form-error').hidden = true;
  $('form-conflict').hidden = true;
  for (const key of FORM_FIELDS) {
    $(`error-${key}`).hidden = true;
    $('task-form').elements[key].removeAttribute('aria-invalid');
  }
}

function showFieldErrors(fields) {
  let first = null;
  for (const [key, message] of Object.entries(fields)) {
    const note = $(`error-${key}`);
    if (!note) continue;
    note.textContent = message;
    note.hidden = false;
    const input = $('task-form').elements[key];
    input.setAttribute('aria-invalid', 'true');
    first ??= input;
  }
  first?.focus();
}

// Opens the form. Pass a task to edit it, or null to add a new one.
function openForm(task, { reopenDetail = false } = {}) {
  const defaults = state.meta.defaults;
  const values = task
    ? Object.fromEntries(FORM_FIELDS.map(key => [key, task[key]]))
    : { title: '', description: '', module: defaults.module, assignee: null, priority: defaults.priority, status: defaults.status, dueDate: null };

  clearFormMessages();
  // A task saved under an older module name keeps it until a current module is chosen here.
  fillModuleSelect($('task-module'), { olderNames: task?.moduleIsOlderName ? [task.module] : [] });
  fillForm(values);
  formContext = { original: task, initial: JSON.stringify(formValues()), reopenDetail };
  $('form-title').textContent = task ? `Edit ${task.reference}` : 'New task';
  $('form-save').textContent = task ? 'Save changes' : 'Add task';
  $('form-save').disabled = false;
  if (!$('form-dialog').open) $('form-dialog').showModal();
  $('task-title').focus();
}

const isFormDirty = () => formContext && JSON.stringify(formValues()) !== formContext.initial;

async function requestCloseForm() {
  if (isFormDirty()) {
    const discard = await confirmAction({
      title: 'Discard unsaved changes?',
      message: 'You have changes in this form that have not been saved.',
      confirmLabel: 'Discard changes',
      danger: true
    });
    if (!discard) return;
  }
  closeForm();
}

function closeForm() {
  const context = formContext;
  formContext = null;
  $('form-dialog').close();
  if (context?.reopenDetail && context.original) openDetail(context.original.id);
}

async function submitForm(event) {
  event.preventDefault();
  if (!formContext) return;
  clearFormMessages();

  const values = formValues();
  if (!values.title) return showFieldErrors({ title: 'Enter a title.' });

  const original = formContext.original;
  let request;
  if (original) {
    // Send only what changed, plus the version we loaded (so newer changes are never overwritten silently).
    const changes = Object.fromEntries(FORM_FIELDS.filter(key => values[key] !== original[key]).map(key => [key, values[key]]));
    if (!Object.keys(changes).length) {
      toast('No changes to save.');
      return closeForm();
    }
    request = () => api('PATCH', `/api/tasks/${original.id}`, { version: original.version, ...changes });
  } else {
    request = () => api('POST', '/api/tasks', values);
  }

  const saveButton = $('form-save');
  const label = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  try {
    const saved = await request();
    toast(original ? `${saved.reference} saved.` : `${saved.reference} created.`);
    if (formContext) formContext.original = original ? saved : null;
    closeForm();
    load({ force: true });
  } catch (error) {
    if (error.data.code === 'VERSION_CONFLICT') showConflict(error.data.current);
    else if (error.data.fields) showFieldErrors(error.data.fields);
    else {
      $('form-error').textContent = error.message;
      $('form-error').hidden = false;
    }
    if (error.status === 409 || error.status === 404) load({ force: true });   // the list behind the form is out of date
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = label;
  }
}

// Someone else saved the task first. Explain what changed and let the user choose what to do.
function showConflict(current) {
  const original = formContext.original;
  const describe = value => (value === null || value === '' ? 'empty' : `“${value}”`);
  const changed = FORM_FIELDS.filter(key => current[key] !== original[key])
    .map(key => `${FIELD_LABELS[key]} is now ${key === 'description' ? 'different' : describe(current[key])}`);

  const box = $('form-conflict');
  box.replaceChildren(
    el('p', {}, el('strong', { text: `Someone else changed ${current.reference} while you were editing. ` }), 'Your changes have not been saved yet.'),
    el('p', { text: changed.length ? `Their changes: ${changed.join('; ')}.` : 'Their change did not alter the fields in this form.' }),
    el('div', { class: 'banner-actions' },
      el('button', { type: 'button', class: 'btn small', text: 'Load their version (discard my edits)', onclick: () => openForm(current, { reopenDetail: formContext.reopenDetail }) }),
      el('button', { type: 'button', class: 'btn small', text: 'Keep my edits and save', onclick: () => {
        // Start from their version, then re-apply only the fields I actually changed.
        const mine = formValues();
        const merged = Object.fromEntries(FORM_FIELDS.map(key => [key, mine[key] !== original[key] ? mine[key] : current[key]]));
        fillModuleSelect($('task-module'), { olderNames: current.moduleIsOlderName ? [current.module] : [] });
        fillForm(merged);
        formContext.original = current;
        $('task-form').requestSubmit();
      } })),
    el('p', { class: 'hint', text: '“Keep my edits” saves only the fields you changed; fields you did not touch keep their newer values.' }));
  box.hidden = false;
  box.querySelector('button').focus();
}

function setUpForm() {
  const { team, priorities, statuses } = state.meta;
  fillModuleSelect($('task-module'));
  fillSelect($('task-assignee'), team, 'Unassigned');
  fillSelect($('task-priority'), priorities, null);
  fillSelect($('task-status'), statuses, null);

  $('task-form').addEventListener('submit', submitForm);
  for (const button of $('form-dialog').querySelectorAll('[data-close]')) button.addEventListener('click', requestCloseForm);
  // Esc key: ask before throwing away unsaved typing.
  $('form-dialog').addEventListener('cancel', event => { event.preventDefault(); requestCloseForm(); });
}

/* ---------- Task details and comments ---------- */

let detail = null;   // { task, comments }

async function openDetail(id) {
  const dialog = $('detail-dialog');
  detail = null;
  $('detail-reference').textContent = '';
  $('detail-title').textContent = 'Loading task…';
  $('detail-body').replaceChildren(el('div', { class: 'state', role: 'status', text: 'Loading task…' }));
  if (!dialog.open) dialog.showModal();
  await refreshDetail(id);
}

async function refreshDetail(id = detail?.task.id) {
  try {
    const [task, comments] = await Promise.all([api('GET', `/api/tasks/${id}`), api('GET', `/api/tasks/${id}/comments`)]);
    detail = { task, comments: comments.comments };
    renderDetail();
  } catch (error) {
    detail = null;
    $('detail-title').textContent = 'Task unavailable';
    $('detail-body').replaceChildren(el('div', { class: 'banner banner-error', role: 'alert', text: error.message }));
    if (error.status === 404) load({ force: true });
  }
}

function renderDetail() {
  const { task, comments } = detail;
  const inTrash = Boolean(task.deletedAt);
  const body = $('detail-body');

  // Keep a half-written comment when the details are redrawn.
  const draft = body.querySelector('#comment-body')?.value ?? '';
  const draftAuthor = body.querySelector('#comment-author')?.value ?? readSetting('author') ?? '';

  $('detail-reference').textContent = task.reference;
  $('detail-title').textContent = task.title;

  const fact = (label, ...content) => el('div', { class: 'fact' }, el('dt', { text: label }), el('dd', {}, content));
  const closeThen = action => async () => { $('detail-dialog').close(); await action(); };

  const actions = inTrash
    ? [
        el('button', { type: 'button', class: 'btn', text: 'Restore', onclick: closeThen(() => restoreTask(task)) }),
        el('button', { type: 'button', class: 'btn danger-outline', text: 'Delete permanently', onclick: async () => {
          if (await deletePermanently(task)) $('detail-dialog').close();
        } })
      ]
    : [
        el('button', { type: 'button', class: 'btn primary', text: 'Edit task', onclick: () => {
          $('detail-dialog').close();
          openForm(task, { reopenDetail: true });
        } }),
        el('button', { type: 'button', class: 'btn', text: 'Move to Trash', onclick: async () => {
          if (await moveToTrash(task)) $('detail-dialog').close();
        } })
      ];

  const commentList = comments.length
    ? el('ol', { class: 'comments' }, comments.map(comment => el('li', { class: 'comment' },
        avatar(comment.author),
        el('div', { class: 'comment-main' },
          el('div', { class: 'comment-head' },
            el('strong', { text: comment.author }),
            el('time', { datetime: comment.createdAt, text: formatDateTime(comment.createdAt) })),
          el('p', { class: 'comment-body', text: comment.body })))))
    : el('p', { class: 'muted', text: 'No comments yet.' });

  const commentForm = inTrash
    ? el('p', { class: 'help', text: 'Restore this task to add comments.' })
    : el('form', { id: 'comment-form', class: 'comment-form', novalidate: true, onsubmit: submitComment },
        el('div', { id: 'comment-error', class: 'banner banner-error', role: 'alert', hidden: true }),
        el('div', { class: 'field' },
          el('label', { for: 'comment-author', text: 'Comment as' }),
          el('select', { id: 'comment-author', name: 'author', required: true },
            el('option', { value: '', text: 'Choose your name' }),
            state.meta.team.map(name => el('option', { value: name, text: name, selected: name === draftAuthor }))),
          el('p', { class: 'hint', text: 'There is no login yet, so this name is not verified.' })),
        el('div', { class: 'field' },
          el('label', { for: 'comment-body', text: 'Comment' }),
          el('textarea', { id: 'comment-body', name: 'body', rows: '3', maxlength: String(state.meta.limits.comment), required: true })),
        el('div', { class: 'comment-form-foot' },
          el('button', { type: 'submit', id: 'comment-save', class: 'btn primary', text: 'Add comment' })));

  body.replaceChildren(...[
    inTrash ? el('div', { class: 'banner banner-warning', text: `This task is in Trash (moved on ${formatDateTime(task.deletedAt)}). Restore it to edit or comment.` }) : null,
    el('dl', { class: 'facts' },
      fact('Status', inTrash ? badge('status', task.status) : statusSelect(task, 'detail')),
      fact('Priority', badge('priority', task.priority)),
      fact('Assigned to', person(task.assignee)),
      fact('ERP module', moduleLabel(task)),
      fact('Due date', dueInfo(task)),
      fact('Created', formatDateTime(task.createdAt)),
      fact('Last updated', formatDateTime(task.updatedAt))),
    el('p', { class: 'hint', text: 'Times are shown in Dubai time.' }),
    el('section', { class: 'detail-section' },
      el('h3', { text: 'Description' }),
      task.description ? el('p', { class: 'description', text: task.description }) : el('p', { class: 'muted', text: 'No description.' })),
    el('div', { class: 'detail-actions' }, actions),
    el('section', { class: 'detail-section' },
      el('h3', { text: `Comments (${comments.length})` }),
      commentList,
      commentForm)
  ].filter(Boolean));

  const textarea = body.querySelector('#comment-body');
  if (textarea) textarea.value = draft;
}

async function submitComment(event) {
  event.preventDefault();
  const form = event.target;
  const errorBox = $('comment-error');
  errorBox.hidden = true;
  const author = form.elements.author.value;
  const text = form.elements.body.value.trim();
  const fail = (message, input) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
    input?.focus();
  };
  if (!author) return fail('Choose your name before commenting.', form.elements.author);
  if (!text) return fail('Write a comment first.', form.elements.body);

  const button = $('comment-save');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await api('POST', `/api/tasks/${detail.task.id}/comments`, { author, body: text });
    saveSetting('author', author);
    form.elements.body.value = '';
    toast('Comment added.');
    await refreshDetail();
    $('comment-body')?.focus();
    load({ force: true });
  } catch (error) {
    const fields = error.data.fields;
    fail(fields ? Object.values(fields).join(' ') : error.message);
    button.disabled = false;
    button.textContent = 'Add comment';
  }
}

/* ---------- Navigation, sidebar menu, refresh and start-up ---------- */

function setPage(page) {
  state.page = PAGES.includes(page) ? page : 'tasks';
  for (const name of PAGES) $(`page-${name}`).hidden = name !== state.page;
  for (const link of document.querySelectorAll('.nav-link')) {
    if (link.dataset.page === state.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (location.hash !== `#${state.page}`) history.replaceState(null, '', `#${state.page}`);
}

// On small screens the sidebar is a slide-in menu.
const isMenuMode = () => window.matchMedia('(max-width: 1100px)').matches;

function openSidebar() {
  document.body.classList.add('sidebar-open');
  $('sidebar-backdrop').hidden = false;
  $('menu-button').setAttribute('aria-expanded', 'true');
  $('sidebar-close').focus();
}

function closeSidebar() {
  if (!document.body.classList.contains('sidebar-open')) return;
  const focusWasInside = $('sidebar').contains(document.activeElement) || document.activeElement === document.body;
  document.body.classList.remove('sidebar-open');
  $('sidebar-backdrop').hidden = true;
  $('menu-button').setAttribute('aria-expanded', 'false');
  if (focusWasInside && isMenuMode()) $('menu-button').focus();
}

// Background refresh so teammates' changes appear. It never runs while a dialog or form is open,
// or while someone is choosing a value in a dropdown inside the task list.
function autoRefresh() {
  if (document.hidden || !state.loaded) return;
  if (document.querySelector('dialog[open]')) return;
  if (document.activeElement?.matches('.status-select')) return;
  load();
}

// Remembers whether a collapsible section is open. Collapsed by default on small screens.
function rememberOpenState(details, settingName, openByDefault) {
  const saved = readSetting(settingName);
  details.open = saved === null ? openByDefault : saved === 'yes';
  details.addEventListener('toggle', () => saveSetting(settingName, details.open ? 'yes' : 'no'));
}

async function start() {
  try {
    state.meta = await api('GET', '/api/meta');
  } catch (error) {
    for (const id of ['task-loading', 'trash-loading', 'overview-loading']) $(id).hidden = true;
    showLoadError(error.message);
    return;
  }
  if (state.started) return load();
  state.started = true;

  setUpFilters();
  setUpForm();
  rememberOpenState($('module-nav'), 'side-modules-open', true);
  rememberOpenState($('module-summary'), 'modules-open', true);

  $('add-task').addEventListener('click', () => openForm(null));
  $('refresh').addEventListener('click', async () => {
    const button = $('refresh');
    button.disabled = true;
    button.textContent = 'Refreshing…';
    await load({ force: true });
    button.disabled = false;
    button.textContent = 'Refresh';
  });
  for (const link of document.querySelectorAll('.nav-link')) {
    link.addEventListener('click', () => { setPage(link.dataset.page); closeSidebar(); });
  }
  for (const button of document.querySelectorAll('.toggle')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      saveSetting('view', state.view);
      if (state.loaded) renderTasks();
    });
  }
  for (const button of $('detail-dialog').querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => $('detail-dialog').close());
  }

  $('menu-button').addEventListener('click', openSidebar);
  $('sidebar-close').addEventListener('click', closeSidebar);
  $('sidebar-backdrop').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeSidebar();
  });
  window.matchMedia('(max-width: 1100px)').addEventListener('change', closeSidebar);

  window.addEventListener('hashchange', () => setPage(location.hash.slice(1)));
  document.addEventListener('visibilitychange', autoRefresh);
  setInterval(autoRefresh, REFRESH_EVERY_MS);

  await load();
}

$('retry').addEventListener('click', () => { $('load-error').hidden = true; start(); });
setPage(location.hash.slice(1));
start();
