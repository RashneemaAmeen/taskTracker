// Automated API tests. Run with: npm test
// Each test group starts the real app on a random port with a temporary database,
// so your real data in /data is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/database');
const { importLegacyTasks } = require('../src/legacyImport');
const { createApp } = require('../src/app');
const { todayInDubai, addDays } = require('../src/dates');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'erp-tracker-test-'));

// Starts the app like server.js does. Returns helpers to call it and to stop it.
async function startApp(dir) {
  const db = openDatabase(path.join(dir, 'erp-tracker.db'));
  const legacy = importLegacyTasks(db, path.join(dir, 'tasks.json'));
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, url, body, headers = {}) {
    const options = { method, headers: { ...headers } };
    if (body !== undefined) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] ??= 'application/json';
    }
    const response = await fetch(base + url, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function stop() {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
  return { api, stop, legacy, base, db };
}

async function withApp(run) {
  const dir = tempDir();
  const app = await startApp(dir);
  try { await run(app, dir); } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const today = todayInDubai();
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

test('health and options endpoints', () => withApp(async ({ api }) => {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.database, 'ok');

  const meta = await api('GET', '/api/meta');
  assert.deepEqual(meta.body.team, ['Thameem', 'Parimitha', 'Mausooq', 'Rashneema']);
  assert.equal(meta.body.modules.length, 20);
  assert.deepEqual(meta.body.moduleGroups.map(group => group.options.length), [16, 4]);
  assert.deepEqual(meta.body.olderModules, []);
  assert.deepEqual(meta.body.statuses, ['To Do', 'In Progress', 'Blocked', 'Completed']);
  assert.equal(meta.body.timeZone, 'Asia/Dubai');
  assert.equal(meta.body.today, today);
}));

test('creating a task applies defaults, trims input and generates ERP references', () => withApp(async ({ api }) => {
  const first = await api('POST', '/api/tasks', { title: '   Set up invoices   ' });
  assert.equal(first.status, 201);
  assert.equal(first.body.reference, 'ERP-001');
  assert.equal(first.body.title, 'Set up invoices');
  assert.equal(first.body.module, 'General / Cross-module');
  assert.equal(first.body.priority, 'Medium');
  assert.equal(first.body.status, 'To Do');
  assert.equal(first.body.assignee, null);
  assert.equal(first.body.dueDate, null);
  assert.equal(first.body.version, 1);
  assert.ok(!Number.isNaN(Date.parse(first.body.createdAt)));
  assert.equal(first.body.createdAt, first.body.updatedAt);

  const second = await api('POST', '/api/tasks', {
    title: 'OCR pilot', description: 'Try three vendors', module: 'Documents & OCR',
    assignee: 'Rashneema', priority: 'High', status: 'In Progress', dueDate: tomorrow
  });
  assert.equal(second.body.reference, 'ERP-002');
  assert.equal(second.body.assignee, 'Rashneema');

  // A task can be opened by number or by reference.
  assert.equal((await api('GET', '/api/tasks/2')).body.title, 'OCR pilot');
  assert.equal((await api('GET', '/api/tasks/ERP-002')).body.title, 'OCR pilot');
}));

test('invalid input is rejected with clear errors', () => withApp(async ({ api }) => {
  const cases = [
    [{}, 'title'],
    [{ title: '   ' }, 'title'],
    [{ title: 'x'.repeat(151) }, 'title'],
    [{ title: 'ok', description: 'x'.repeat(4001) }, 'description'],
    [{ title: 'ok', module: 'Payroll' }, 'module'],
    [{ title: 'ok', module: 'Finance & Accounts' }, 'module'],   // an older name is not accepted for new tasks
    [{ title: 'ok', module: 'Warehouse' }, 'module'],            // must say which Warehouse module
    [{ title: 'ok', assignee: 'Stranger' }, 'assignee'],
    [{ title: 'ok', priority: 'Urgent' }, 'priority'],
    [{ title: 'ok', status: 'Done' }, 'status'],
    [{ title: 'ok', dueDate: '2026-02-30' }, 'dueDate'],
    [{ title: 'ok', dueDate: '16/11/2026' }, 'dueDate']
  ];
  for (const [body, field] of cases) {
    const response = await api('POST', '/api/tasks', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok(response.body.fields[field], `expected an error for ${field}`);
  }

  assert.equal((await api('POST', '/api/tasks', '{not json')).status, 400);
  assert.equal((await api('POST', '/api/tasks', '[1,2]')).status, 400);
  assert.equal((await api('POST', '/api/tasks', 'title=x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api('POST', '/api/tasks', { title: 'x'.repeat(60000) })).status, 413);
  assert.equal((await api('GET', '/api/tasks/abc')).status, 400);
  assert.equal((await api('GET', '/api/tasks/999')).status, 404);
  assert.equal((await api('GET', '/api/nothing-here')).status, 404);
  assert.equal((await api('GET', '/api/tasks?status=Done')).status, 400);
  assert.equal((await api('GET', '/api/tasks?overdue=maybe')).status, 400);

  // Nothing invalid was saved.
  assert.equal((await api('GET', '/api/tasks')).body.count, 0);
}));

test('requests from another website are blocked', () => withApp(async ({ api, base }) => {
  const foreign = await api('POST', '/api/tasks', { title: 'x' }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  const own = await api('POST', '/api/tasks', { title: 'x' }, { Origin: base });
  assert.equal(own.status, 201);
}));

test('editing, reassigning and changing status; stale versions are refused', () => withApp(async ({ api }) => {
  const created = (await api('POST', '/api/tasks', { title: 'Draft quote screen', assignee: 'Thameem' })).body;

  const edited = await api('PATCH', '/api/tasks/1', {
    version: created.version, title: 'Draft instant quote screen', description: 'First pass',
    module: 'CRM', priority: 'High', dueDate: tomorrow
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'Draft instant quote screen');
  assert.equal(edited.body.module, 'CRM');
  assert.equal(edited.body.version, 2);
  assert.equal(edited.body.assignee, 'Thameem', 'fields that were not sent stay unchanged');
  assert.ok(edited.body.updatedAt >= created.updatedAt);

  const reassigned = await api('PATCH', '/api/tasks/1', { version: 2, assignee: 'Mausooq' });
  assert.equal(reassigned.body.assignee, 'Mausooq');
  const moved = await api('PATCH', '/api/tasks/1', { version: 3, status: 'Blocked' });
  assert.equal(moved.body.status, 'Blocked');
  const unassigned = await api('PATCH', '/api/tasks/1', { version: 4, assignee: null, dueDate: null });
  assert.equal(unassigned.body.assignee, null);
  assert.equal(unassigned.body.dueDate, null);

  // A second person still holding version 2 must not overwrite the newer changes.
  const stale = await api('PATCH', '/api/tasks/1', { version: 2, title: 'Old browser tab' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'VERSION_CONFLICT');
  assert.equal(stale.body.current.version, 5);
  assert.equal((await api('GET', '/api/tasks/1')).body.title, 'Draft instant quote screen');

  assert.equal((await api('PATCH', '/api/tasks/1', { title: 'No version' })).status, 400);
  assert.equal((await api('PATCH', '/api/tasks/1', { version: 5 })).status, 400);
  assert.equal((await api('PATCH', '/api/tasks/1', { version: 5, status: 'Nope' })).status, 400);
  assert.equal((await api('PATCH', '/api/tasks/77', { version: 1, title: 'Ghost' })).status, 404);
}));

test('search and filters work together', () => withApp(async ({ api }) => {
  const add = body => api('POST', '/api/tasks', body);
  await add({ title: 'Invoice template', module: 'Financials', assignee: 'Parimitha', priority: 'High', status: 'In Progress' });
  await add({ title: 'Invoice numbering', module: 'Financials', assignee: 'Mausooq', priority: 'Low', status: 'To Do' });
  await add({ title: 'Ledger export', description: 'Needed for the invoice audit', module: 'Financials', assignee: 'Parimitha', priority: 'High', status: 'To Do' });
  await add({ title: 'Lead import', module: 'CRM', assignee: 'Parimitha', priority: 'High', status: 'To Do', dueDate: yesterday });
  await add({ title: '100% coverage_report', module: 'General / Cross-module' });

  const titles = async query => (await api('GET', `/api/tasks?${query}`)).body.tasks.map(task => task.title).sort();

  assert.deepEqual(await titles('q=invoice'), ['Invoice numbering', 'Invoice template', 'Ledger export']);
  assert.deepEqual(await titles('q=INVOICE&assignee=Parimitha'), ['Invoice template', 'Ledger export']);
  assert.deepEqual(await titles('q=invoice&assignee=Parimitha&status=To%20Do'), ['Ledger export']);
  assert.deepEqual(await titles('module=Financials&priority=High&assignee=Parimitha&status=In%20Progress'), ['Invoice template']);
  assert.deepEqual(await titles('q=erp-004'), ['Lead import']);
  assert.deepEqual(await titles('overdue=true&assignee=Parimitha'), ['Lead import']);
  assert.deepEqual(await titles('overdue=true&assignee=Mausooq'), []);
  assert.deepEqual(await titles('assignee=Unassigned'), ['100% coverage_report']);
  // % and _ are searched literally, not treated as wildcards.
  assert.deepEqual(await titles('q=100%25'), ['100% coverage_report']);
  assert.deepEqual(await titles('q=e_r'), ['100% coverage_report']);
}));

test('dashboard counts and overdue rules (Asia/Dubai dates)', () => withApp(async ({ api }) => {
  const add = async body => (await api('POST', '/api/tasks', body)).body;
  const late = await add({ title: 'Due yesterday', dueDate: yesterday, assignee: 'Thameem', status: 'In Progress' });
  const dueToday = await add({ title: 'Due today', dueDate: today, assignee: 'Thameem' });
  const doneLate = await add({ title: 'Finished late', dueDate: yesterday, status: 'Completed', assignee: 'Parimitha' });
  await add({ title: 'No date', status: 'Blocked', assignee: 'Parimitha' });
  const trashed = await add({ title: 'Trashed and late', dueDate: yesterday, assignee: 'Mausooq', status: 'In Progress' });
  await api('POST', `/api/tasks/${trashed.id}/trash`);

  assert.equal(late.isOverdue, true);
  assert.equal(dueToday.isOverdue, false, 'a task due today is not overdue');
  assert.equal(doneLate.isOverdue, false, 'a completed task is never overdue');

  const all = (await api('GET', '/api/dashboard')).body;
  assert.equal(all.scope, 'all');
  assert.equal(all.today, today);
  assert.deepEqual(all.summary, { active: 4, inProgress: 1, completed: 1, overdue: 1 });
  assert.deepEqual(all.workload, [
    { name: 'Thameem', pending: 2, completed: 0 },
    { name: 'Parimitha', pending: 1, completed: 1 },
    { name: 'Mausooq', pending: 0, completed: 0 },
    { name: 'Rashneema', pending: 0, completed: 0 }
  ]);

  const filtered = (await api('GET', '/api/dashboard?assignee=Parimitha')).body;
  assert.equal(filtered.scope, 'filtered');
  assert.deepEqual(filtered.summary, { active: 2, inProgress: 0, completed: 1, overdue: 0 });
  assert.equal(filtered.workload[0].pending, 2, 'workload always covers all tasks');

  // Completing the late task clears "overdue".
  await api('PATCH', `/api/tasks/${late.id}`, { version: late.version, status: 'Completed' });
  assert.equal((await api('GET', '/api/dashboard')).body.summary.overdue, 0);
  assert.equal((await api('GET', '/api/tasks?overdue=true')).body.count, 0);
}));

test('comments are validated, ordered and survive a restart', async () => {
  const dir = tempDir();
  let app = await startApp(dir);
  try {
    await app.api('POST', '/api/tasks', { title: 'Discuss shipment statuses' });
    const first = await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '  First note  ' });
    assert.equal(first.status, 201);
    assert.equal(first.body.body, 'First note');
    assert.ok(!Number.isNaN(Date.parse(first.body.createdAt)));
    await app.api('POST', '/api/tasks/1/comments', { author: 'Rashneema', body: '<script>alert(1)</script> second' });

    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Nobody', body: 'x' })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '   ' })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: 'x'.repeat(2001) })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/9/comments', { author: 'Mausooq', body: 'x' })).status, 404);

    // Restart: close the server and database, then open the same database file again.
    await app.stop();
    app = await startApp(dir);

    const list = (await app.api('GET', '/api/tasks/1/comments')).body;
    assert.equal(list.count, 2);
    assert.deepEqual(list.comments.map(comment => comment.author), ['Mausooq', 'Rashneema']);
    assert.equal(list.comments[1].body, '<script>alert(1)</script> second', 'text is stored as typed; the browser renders it as plain text');
    assert.equal((await app.api('GET', '/api/tasks/1')).body.commentCount, 2);
    assert.equal((await app.api('GET', '/api/tasks/1')).body.title, 'Discuss shipment statuses');
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trash, restore and permanent deletion', () => withApp(async ({ api }) => {
  await api('POST', '/api/tasks', { title: 'Keep me' });
  const doomed = (await api('POST', '/api/tasks', { title: 'Findable widget', description: 'details', assignee: 'Thameem', priority: 'High' })).body;
  await api('POST', '/api/tasks/2/comments', { author: 'Thameem', body: 'Important context' });

  // Permanent deletion is refused while the task is not in Trash.
  assert.equal((await api('DELETE', '/api/trash/2')).status, 409);

  const trashed = await api('POST', '/api/tasks/2/trash');
  assert.equal(trashed.status, 200);
  assert.ok(trashed.body.deletedAt);
  assert.equal((await api('POST', '/api/tasks/2/trash')).status, 409);

  // Trashed tasks disappear from lists, search and the dashboard.
  assert.deepEqual((await api('GET', '/api/tasks')).body.tasks.map(task => task.id), [1]);
  assert.equal((await api('GET', '/api/tasks?q=widget')).body.count, 0);
  assert.equal((await api('GET', '/api/dashboard')).body.summary.active, 1);
  assert.equal((await api('GET', '/api/dashboard')).body.workload[0].pending, 0);

  // They cannot be edited or commented on while in Trash.
  assert.equal((await api('PATCH', '/api/tasks/2', { version: trashed.body.version, title: 'Sneaky' })).status, 409);
  assert.equal((await api('POST', '/api/tasks/2/comments', { author: 'Thameem', body: 'x' })).status, 409);

  const trash = (await api('GET', '/api/trash')).body;
  assert.equal(trash.count, 1);
  assert.equal(trash.tasks[0].reference, 'ERP-002');
  assert.ok(!Number.isNaN(Date.parse(trash.tasks[0].deletedAt)));

  // Restore brings everything back.
  const restored = await api('POST', '/api/trash/2/restore');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.deletedAt, null);
  assert.equal(restored.body.title, doomed.title);
  assert.equal(restored.body.description, 'details');
  assert.equal(restored.body.assignee, 'Thameem');
  assert.equal(restored.body.priority, 'High');
  assert.equal((await api('GET', '/api/tasks/2/comments')).body.comments[0].body, 'Important context');
  assert.equal((await api('GET', '/api/tasks')).body.count, 2);
  assert.equal((await api('POST', '/api/trash/2/restore')).status, 409);

  // Trash again, then delete permanently.
  await api('POST', '/api/tasks/2/trash');
  assert.equal((await api('DELETE', '/api/trash/2')).status, 204);
  assert.equal((await api('GET', '/api/tasks/2')).status, 404);
  assert.equal((await api('GET', '/api/tasks/2/comments')).status, 404);
  assert.equal((await api('GET', '/api/trash')).body.count, 0);
  assert.equal((await api('DELETE', '/api/trash/2')).status, 404);

  // References are never reused after a permanent deletion.
  assert.equal((await api('POST', '/api/tasks', { title: 'Newer task' })).body.reference, 'ERP-003');
}));

test('old tasks.json is imported once, unchanged, with no duplicates after restart', async () => {
  const dir = tempDir();
  const legacyFile = path.join(dir, 'tasks.json');
  const legacyText = JSON.stringify([
    { id: 'aaa-1', title: 'start the research work', completed: false, createdAt: '2026-11-16T08:44:04.180Z' },
    { id: 'aaa-2', title: 'get the assignment completed', completed: true, createdAt: '2026-11-15T10:00:00.000Z' },
    { id: 'aaa-3', title: '   ', completed: false }
  ], null, 2);
  fs.writeFileSync(legacyFile, legacyText);

  let app = await startApp(dir);
  try {
    assert.equal(app.legacy.status, 'imported');
    assert.equal(app.legacy.imported, 2);
    assert.equal(app.legacy.skipped, 1);

    const tasks = (await app.api('GET', '/api/tasks')).body.tasks;
    assert.equal(tasks.length, 2);
    const open = tasks.find(task => task.title === 'start the research work');
    const done = tasks.find(task => task.title === 'get the assignment completed');
    assert.equal(open.status, 'To Do');
    assert.equal(open.createdAt, '2026-11-16T08:44:04.180Z');
    assert.equal(done.status, 'Completed');
    assert.equal(done.createdAt, '2026-11-15T10:00:00.000Z');
    for (const task of tasks) {
      assert.equal(task.module, 'General / Cross-module');
      assert.equal(task.priority, 'Medium');
      assert.equal(task.assignee, null);
      assert.equal(task.dueDate, null);
    }

    // Permanently delete one imported task: it must not come back after a restart.
    await app.api('POST', `/api/tasks/${done.id}/trash`);
    await app.api('DELETE', `/api/trash/${done.id}`);

    await app.stop();
    app = await startApp(dir);
    assert.equal(app.legacy.status, 'already-imported');
    assert.equal((await app.api('GET', '/api/tasks')).body.count, 1);
    assert.equal((await app.api('GET', '/api/trash')).body.count, 0);

    await app.stop();
    app = await startApp(dir);
    assert.equal((await app.api('GET', '/api/tasks')).body.count, 1);

    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyText, 'the old file is left exactly as it was');
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real ERP module names are offered; MIS, BI and both Warehouse modules stay separate', () => withApp(async ({ api }) => {
  const meta = (await api('GET', '/api/meta')).body;
  assert.deepEqual(meta.moduleGroups[0], { label: 'ERP modules', options: [
    'CRM', 'Forwarding', 'Transport (By Land)', 'Customs', 'NVOCC (Liner)', 'Trading & Service',
    'Warehouse (Advance)', 'Warehouse (Basic)', 'Pricing', 'Financials', 'MIS', 'Business Intelligence',
    'Credit Control', 'Purchase', 'Tracking', 'AWB Stock'
  ] });
  assert.deepEqual(meta.moduleGroups[1], { label: 'Cross-module categories', options: [
    'General / Cross-module', 'Documents & OCR', 'Integrations & APIs', 'Deployment & Infrastructure'
  ] });

  // Every option can be used to create a task, and each is filtered and summarised on its own.
  for (const name of meta.modules) {
    const created = await api('POST', '/api/tasks', { title: `Work on ${name}`, module: name });
    assert.equal(created.status, 201, name);
    assert.equal(created.body.module, name);
    assert.equal(created.body.moduleIsOlderName, false);
    assert.equal(created.body.assignee, null, 'choosing a module never assigns a person');
  }
  for (const name of ['MIS', 'Business Intelligence', 'Warehouse (Advance)', 'Warehouse (Basic)', 'NVOCC (Liner)', 'Transport (By Land)']) {
    const list = (await api('GET', `/api/tasks?module=${encodeURIComponent(name)}`)).body;
    assert.deepEqual(list.tasks.map(task => task.module), [name]);
  }

  const dashboard = (await api('GET', '/api/dashboard')).body;
  assert.deepEqual(dashboard.modules.map(item => item.name), meta.modules);
  assert.ok(dashboard.modules.every(item => item.pending === 1 && item.completed === 0 && item.olderName === false));
  assert.ok(dashboard.workload.every(member => member.pending === 0), 'no one was given work automatically');
}));

test('tasks saved under older module names are preserved until explicitly remapped', () => withApp(async ({ api, db }) => {
  // Simulate tasks created before the module list changed.
  const insert = db.prepare(`INSERT INTO tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at)
    VALUES (?, 'older data', ?, 'Parimitha', 'High', 'In Progress', NULL, '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:00.000Z')`);
  insert.run('Old finance task', 'Finance & Accounts');
  insert.run('Old general task', 'General');
  await api('POST', '/api/tasks/1/comments', { author: 'Parimitha', body: 'Keep this comment' });
  await api('POST', '/api/tasks', { title: 'New finance task', module: 'Financials' });

  // Nothing was renamed, moved or lost.
  const old = (await api('GET', '/api/tasks/1')).body;
  assert.equal(old.module, 'Finance & Accounts');
  assert.equal(old.moduleIsOlderName, true);
  assert.equal(old.createdAt, '2026-11-01T08:00:00.000Z');
  assert.equal((await api('GET', '/api/tasks')).body.count, 3);
  assert.deepEqual((await api('GET', '/api/meta')).body.olderModules, ['Finance & Accounts', 'General']);

  // Older names can still be filtered, and are counted separately in the module summary.
  const filtered = (await api('GET', '/api/tasks?module=Finance%20%26%20Accounts')).body;
  assert.deepEqual(filtered.tasks.map(task => task.title), ['Old finance task']);
  assert.equal((await api('GET', '/api/tasks?module=Financials')).body.count, 1, 'not merged into Financials');
  assert.equal((await api('GET', '/api/tasks?module=Never%20Existed')).status, 400);
  const summary = (await api('GET', '/api/dashboard')).body.modules;
  assert.equal(summary.length, 22);
  assert.deepEqual(summary.filter(item => item.olderName), [
    { name: 'Finance & Accounts', pending: 1, completed: 0, olderName: true },
    { name: 'General', pending: 1, completed: 0, olderName: true }
  ]);

  // Editing other fields keeps the older module, whether or not the unchanged module is sent.
  const edited = await api('PATCH', '/api/tasks/1', { version: 1, status: 'Blocked' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.module, 'Finance & Accounts');
  const resent = await api('PATCH', '/api/tasks/1', { version: 2, module: 'Finance & Accounts', title: 'Old finance task (reviewed)' });
  assert.equal(resent.status, 200);
  assert.equal(resent.body.module, 'Finance & Accounts');

  // An older name cannot be chosen for another task, or swapped for a different older name.
  assert.equal((await api('PATCH', '/api/tasks/2', { version: 1, module: 'Finance & Accounts' })).status, 400);
  assert.equal((await api('POST', '/api/tasks', { title: 'x', module: 'General' })).status, 400);

  // Explicit reassignment to a current module works, and keeps everything else.
  const mapped = await api('PATCH', '/api/tasks/1', { version: 3, module: 'Financials' });
  assert.equal(mapped.status, 200);
  assert.equal(mapped.body.module, 'Financials');
  assert.equal(mapped.body.moduleIsOlderName, false);
  assert.equal(mapped.body.assignee, 'Parimitha');
  assert.equal(mapped.body.title, 'Old finance task (reviewed)');
  assert.equal((await api('GET', '/api/tasks/1/comments')).body.comments[0].body, 'Keep this comment');
  assert.deepEqual((await api('GET', '/api/meta')).body.olderModules, ['General']);
}));
