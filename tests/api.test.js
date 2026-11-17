// Automated API tests against a REAL MySQL server. Run with: npm test
//
// These tests are SKIPPED unless TEST_DB_ADMIN_USER (and TEST_DB_ADMIN_PASSWORD) are set; see
// tests/helpers/mysqlTestDb.js and the README ("Running the tests"). When they run, every test
// gets its own throw-away database (erp_task_tracker_test_xxxxxxxx) and a temporary account
// with only SELECT, INSERT, UPDATE and DELETE, like the real application. Your real
// database is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPool, verifyDatabase, closePool } = require('../src/database');
const { importLegacyTasks } = require('../src/legacyImport');
const { createApp } = require('../src/app');
const { todayInDubai, addDays } = require('../src/dates');
const { skipReason, createTestDatabase } = require('./helpers/mysqlTestDb');

const mysqlTest = (name, run) => test(name, { skip: skipReason }, run);

// Starts the app like server.js does (a connection pool, then the web server on a random port).
async function startApp(database) {
  const pool = createPool(database.dbConfig);
  await verifyDatabase(pool);
  const server = createApp(pool).listen(0, '127.0.0.1');
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
    await closePool(pool);
  }
  return { api, stop, base, pool };
}

async function withApp(run) {
  const database = await createTestDatabase();
  let app;
  try {
    app = await startApp(database);
    await run(app, database);
  } finally {
    if (app) await app.stop();
    await database.drop();
  }
}

const today = todayInDubai();
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);

mysqlTest('health and options endpoints', () => withApp(async ({ api }) => {
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

mysqlTest('the application account has only SELECT, INSERT, UPDATE and DELETE', () => withApp(async ({ pool }) => {
  const denied = new Set(['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR']);
  for (const statement of [
    'DROP TABLE tasks',
    'ALTER TABLE tasks ADD COLUMN extra INT',
    'CREATE TABLE sneaky (id INT)',
    'TRUNCATE TABLE comments',
    'CREATE INDEX extra_idx ON tasks (module)',
    'DROP DATABASE mysql'
  ]) {
    await assert.rejects(pool.query(statement), error => denied.has(error.code), `${statement} must be denied`);
  }
  // ...and everything the application needs still works with exactly those four permissions.
  const created = await pool.execute(`INSERT INTO tasks (title, description, module, priority, status, created_at, updated_at)
                                      VALUES ('permission check', '', 'CRM', 'Low', 'To Do', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`);
  assert.equal(created[0].affectedRows, 1);
}));

mysqlTest('creating a task applies defaults, trims input and generates ERP references', () => withApp(async ({ api }) => {
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
  assert.equal(first.body.deletedAt, null);
  assert.equal(first.body.isOverdue, false);
  assert.equal(first.body.commentCount, 0);

  const second = await api('POST', '/api/tasks', {
    title: 'OCR pilot', description: 'Try three vendors', module: 'Documents & OCR',
    assignee: 'Rashneema', priority: 'High', status: 'In Progress', dueDate: tomorrow
  });
  assert.equal(second.body.reference, 'ERP-002');
  assert.equal(second.body.assignee, 'Rashneema');
  assert.equal(second.body.dueDate, tomorrow);

  // A task can be opened by number or by reference.
  assert.equal((await api('GET', '/api/tasks/2')).body.title, 'OCR pilot');
  assert.equal((await api('GET', '/api/tasks/ERP-002')).body.title, 'OCR pilot');
}));

mysqlTest('timestamps are stored in UTC and returned as ISO strings', () => withApp(async ({ api }) => {
  const created = (await api('POST', '/api/tasks', { title: 'clock check' })).body;
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // If MySQL's clock or the connection time zone were misread, this would be off by hours.
  assert.ok(Math.abs(Date.parse(created.createdAt) - Date.now()) < 60000, `created ${created.createdAt} vs now ${new Date().toISOString()}`);
  const edited = (await api('PATCH', `/api/tasks/${created.id}`, { version: 1, status: 'In Progress' })).body;
  assert.ok(edited.updatedAt >= created.updatedAt);
  assert.equal(edited.createdAt, created.createdAt, 'creation time never changes');
}));

mysqlTest('due dates are plain calendar days: no timezone shift, leap days and year ends intact', () => withApp(async ({ api, pool }) => {
  const days = ['2026-01-01', '2026-12-31', '2028-02-29', '2026-03-29', '2026-10-25', '2026-11-16'];
  for (const dueDate of days) {
    const created = await api('POST', '/api/tasks', { title: `due ${dueDate}`, dueDate });
    assert.equal(created.body.dueDate, dueDate, `created ${dueDate}`);
    assert.equal((await api('GET', `/api/tasks/${created.body.id}`)).body.dueDate, dueDate, `read back ${dueDate}`);
  }
  assert.deepEqual((await api('GET', '/api/tasks')).body.tasks.map(task => task.dueDate).sort(), [...days].sort());
  const [rows] = await pool.query('SELECT due_date FROM tasks ORDER BY id');
  assert.ok(rows.every(row => typeof row.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)), 'the driver hands over text, not Date objects');
  // A due date can be cleared and set again.
  assert.equal((await api('PATCH', '/api/tasks/1', { version: 1, dueDate: null })).body.dueDate, null);
  assert.equal((await api('PATCH', '/api/tasks/1', { version: 2, dueDate: '2027-02-28' })).body.dueDate, '2027-02-28');
}));

mysqlTest('text in any language is stored and searched correctly (utf8mb4)', () => withApp(async ({ api }) => {
  const title = 'مهمة جديدة \u{1F4E6} café – 任务';
  const created = await api('POST', '/api/tasks', { title, description: 'emoji \u{1F69A} and "quotes" and \'apostrophes\' and \\ backslash' });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, title);
  assert.equal(created.body.description, 'emoji \u{1F69A} and "quotes" and \'apostrophes\' and \\ backslash');
  assert.equal((await api('GET', '/api/tasks?q=%D9%85%D9%87%D9%85%D8%A9')).body.count, 1);       // Arabic word
  assert.equal((await api('GET', `/api/tasks?q=${encodeURIComponent('CAFÉ')}`)).body.count, 1, 'search ignores letter case');
  const comment = await api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '\u{1F44D} شكرا' });
  assert.equal(comment.body.body, '\u{1F44D} شكرا');
}));

mysqlTest('references with four digits are not cut short and can be searched', () => withApp(async ({ api, pool }) => {
  await pool.execute(`INSERT INTO tasks (id, title, description, module, priority, status, created_at, updated_at)
                      VALUES (999, 'task nine ninety-nine', '', 'CRM', 'Low', 'To Do', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`);
  const next = await api('POST', '/api/tasks', { title: 'task one thousand' });
  assert.equal(next.body.id, 1000);
  assert.equal(next.body.reference, 'ERP-1000');
  assert.equal((await api('GET', '/api/tasks?q=ERP-1000')).body.tasks[0].title, 'task one thousand');
  assert.equal((await api('GET', '/api/tasks?q=erp-999')).body.tasks[0].title, 'task nine ninety-nine');
  assert.equal((await api('GET', '/api/tasks/ERP-1000')).body.id, 1000);
}));

mysqlTest('invalid input is rejected with clear errors and saves nothing', () => withApp(async ({ api }) => {
  const cases = [
    [{}, 'title'], [{ title: '   ' }, 'title'], [{ title: 'x'.repeat(151) }, 'title'],
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
  assert.equal((await api('GET', '/api/tasks')).body.count, 0, 'nothing invalid was saved');
}));

mysqlTest('values that look like SQL are stored as plain text, never run', () => withApp(async ({ api, pool }) => {
  const attack = "x'); DROP TABLE tasks; --";
  const created = await api('POST', '/api/tasks', { title: attack, description: "' OR '1'='1" });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, attack);
  assert.equal((await api('GET', `/api/tasks?q=${encodeURIComponent("' OR '1'='1")}`)).body.count, 1);
  assert.equal((await api('GET', `/api/tasks?q=${encodeURIComponent("zzz' OR '1'='1")}`)).body.count, 0);
  assert.equal((await api('GET', `/api/tasks?assignee=${encodeURIComponent("Thameem' OR '1'='1")}`)).status, 400);
  const [[row]] = await pool.query('SELECT COUNT(*) AS total FROM tasks');
  assert.equal(row.total, 1, 'the table still exists and holds exactly the one task');
}));

mysqlTest('requests from another website are blocked', () => withApp(async ({ api, base }) => {
  const foreign = await api('POST', '/api/tasks', { title: 'x' }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  const own = await api('POST', '/api/tasks', { title: 'x' }, { Origin: base });
  assert.equal(own.status, 201);
}));

mysqlTest('editing, reassigning and changing status; stale versions are refused', () => withApp(async ({ api }) => {
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

mysqlTest('concurrent edits: when several people save the same version at once, exactly one wins', () => withApp(async ({ api }) => {
  const created = (await api('POST', '/api/tasks', { title: 'Shared task' })).body;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    api('PATCH', `/api/tasks/${created.id}`, { version: created.version, title: `Edit number ${index}` })));

  assert.deepEqual(results.map(result => result.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
  const winner = results.find(result => result.status === 200).body;
  assert.equal(winner.version, 2, 'only one change was applied');
  for (const loser of results.filter(result => result.status === 409)) assert.equal(loser.body.code, 'VERSION_CONFLICT');

  const final = (await api('GET', `/api/tasks/${created.id}`)).body;
  assert.equal(final.version, 2);
  assert.equal(final.title, winner.title, 'the stored task is exactly the winner\'s version');
}));

mysqlTest('concurrent status changes and trashing never lose or double-apply an update', () => withApp(async ({ api }) => {
  const created = (await api('POST', '/api/tasks', { title: 'Race' })).body;
  const [edit, trash] = await Promise.all([
    api('PATCH', `/api/tasks/${created.id}`, { version: 1, status: 'In Progress' }),
    api('POST', `/api/tasks/${created.id}/trash`)
  ]);
  const final = (await api('GET', `/api/tasks/${created.id}`)).body;
  assert.equal(trash.status, 200, 'trashing always succeeds for a task that exists');
  assert.ok(final.deletedAt, 'the task ends up in Trash');
  if (edit.status === 200) {
    assert.equal(final.status, 'In Progress');
    assert.equal(final.version, 3, 'edit and trash were both applied, once each');
  } else {
    assert.equal(edit.status, 409);
    assert.equal(final.status, 'To Do');
    assert.equal(final.version, 2);
  }
}));

mysqlTest('search and filters work together', () => withApp(async ({ api }) => {
  const add = body => api('POST', '/api/tasks', body);
  await add({ title: 'Invoice template', module: 'Financials', assignee: 'Parimitha', priority: 'High', status: 'In Progress' });
  await add({ title: 'Invoice numbering', module: 'Financials', assignee: 'Mausooq', priority: 'Low', status: 'To Do' });
  await add({ title: 'Ledger export', description: 'Needed for the invoice audit', module: 'Financials', assignee: 'Parimitha', priority: 'High', status: 'To Do' });
  await add({ title: 'Lead import', module: 'CRM', assignee: 'Parimitha', priority: 'High', status: 'To Do', dueDate: yesterday });
  await add({ title: '100% coverage_report!', module: 'General / Cross-module' });

  const titles = async query => (await api('GET', `/api/tasks?${query}`)).body.tasks.map(task => task.title).sort();

  assert.deepEqual(await titles('q=invoice'), ['Invoice numbering', 'Invoice template', 'Ledger export']);
  assert.deepEqual(await titles('q=INVOICE&assignee=Parimitha'), ['Invoice template', 'Ledger export']);
  assert.deepEqual(await titles('q=invoice&assignee=Parimitha&status=To%20Do'), ['Ledger export']);
  assert.deepEqual(await titles('module=Financials&priority=High&assignee=Parimitha&status=In%20Progress'), ['Invoice template']);
  assert.deepEqual(await titles('q=erp-004'), ['Lead import']);
  assert.deepEqual(await titles('overdue=true&assignee=Parimitha'), ['Lead import']);
  assert.deepEqual(await titles('overdue=true&assignee=Mausooq'), []);
  assert.deepEqual(await titles('assignee=Unassigned'), ['100% coverage_report!']);
  // % _ and ! typed by a person are searched literally, not treated as wildcards.
  assert.deepEqual(await titles('q=100%25'), ['100% coverage_report!']);
  assert.deepEqual(await titles('q=e_r'), ['100% coverage_report!']);
  assert.deepEqual(await titles('q=report!'), ['100% coverage_report!']);
  assert.deepEqual(await titles('q=%25'), ['100% coverage_report!'], 'a lone % matches only a real percent sign');
  assert.deepEqual(await titles('q=_'), ['100% coverage_report!'], 'a lone _ matches only a real underscore');
}));

mysqlTest('tasks are listed open first, by due date, then priority', () => withApp(async ({ api }) => {
  await api('POST', '/api/tasks', { title: 'no date, low', priority: 'Low' });
  await api('POST', '/api/tasks', { title: 'later, high', dueDate: tomorrow, priority: 'High' });
  await api('POST', '/api/tasks', { title: 'done', status: 'Completed', dueDate: yesterday });
  await api('POST', '/api/tasks', { title: 'soon, low', dueDate: yesterday, priority: 'Low' });
  await api('POST', '/api/tasks', { title: 'soon, high', dueDate: yesterday, priority: 'High' });
  await api('POST', '/api/tasks', { title: 'no date, high', priority: 'High' });
  const order = (await api('GET', '/api/tasks')).body.tasks.map(task => task.title);
  assert.deepEqual(order, ['soon, high', 'soon, low', 'later, high', 'no date, high', 'no date, low', 'done']);
}));

mysqlTest('dashboard counts and overdue rules (Asia/Dubai dates)', () => withApp(async ({ api }) => {
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
  assert.ok(Object.values(all.summary).every(value => typeof value === 'number'), 'counts are numbers, not text');
  assert.deepEqual(all.workload, [
    { name: 'Thameem', pending: 2, completed: 0 },
    { name: 'Parimitha', pending: 1, completed: 1 },
    { name: 'Mausooq', pending: 0, completed: 0 },
    { name: 'Rashneema', pending: 0, completed: 0 }
  ]);
  assert.deepEqual(all.unassigned, { pending: 0, completed: 0 });

  const filtered = (await api('GET', '/api/dashboard?assignee=Parimitha')).body;
  assert.equal(filtered.scope, 'filtered');
  assert.deepEqual(filtered.summary, { active: 2, inProgress: 0, completed: 1, overdue: 0 });
  assert.equal(filtered.workload[0].pending, 2, 'workload always covers all tasks');

  const overdueOnly = (await api('GET', '/api/dashboard?overdue=true')).body;
  assert.deepEqual(overdueOnly.summary, { active: 1, inProgress: 1, completed: 0, overdue: 1 });

  // Completing the late task clears "overdue".
  await api('PATCH', `/api/tasks/${late.id}`, { version: late.version, status: 'Completed' });
  assert.equal((await api('GET', '/api/dashboard')).body.summary.overdue, 0);
  assert.equal((await api('GET', '/api/tasks?overdue=true')).body.count, 0);
}));

mysqlTest('comments are validated, ordered and survive a restart', async () => {
  const database = await createTestDatabase();
  let app = await startApp(database);
  try {
    await app.api('POST', '/api/tasks', { title: 'Discuss shipment statuses' });
    const first = await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '  First note  ' });
    assert.equal(first.status, 201);
    assert.equal(first.body.body, 'First note');
    assert.equal(first.body.taskId, 1);
    assert.ok(!Number.isNaN(Date.parse(first.body.createdAt)));
    await app.api('POST', '/api/tasks/1/comments', { author: 'Rashneema', body: '<script>alert(1)</script> second' });

    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Nobody', body: 'x' })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '   ' })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: 'x'.repeat(2001) })).status, 400);
    assert.equal((await app.api('POST', '/api/tasks/9/comments', { author: 'Mausooq', body: 'x' })).status, 404);

    // Restart: close the web server and the connection pool, then open a new pool on the same database.
    await app.stop();
    app = await startApp(database);

    const list = (await app.api('GET', '/api/tasks/1/comments')).body;
    assert.equal(list.count, 2);
    assert.deepEqual(list.comments.map(comment => comment.author), ['Mausooq', 'Rashneema']);
    assert.equal(list.comments[1].body, '<script>alert(1)</script> second', 'text is stored as typed; the browser renders it as plain text');
    assert.equal((await app.api('GET', '/api/tasks/1')).body.commentCount, 2);
    assert.equal((await app.api('GET', '/api/tasks/1')).body.title, 'Discuss shipment statuses');
  } finally {
    await app.stop();
    await database.drop();
  }
});

mysqlTest('trash, restore and permanent deletion', () => withApp(async ({ api }, database) => {
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
  assert.equal(trash.tasks[0].commentCount, 1);

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

  // The database itself removed the comments with the task (foreign key, ON DELETE CASCADE).
  const [[left]] = await database.admin.query(`SELECT COUNT(*) AS total FROM \`${database.database}\`.comments`);
  assert.equal(left.total, 0);

  // References are never reused after a permanent deletion.
  assert.equal((await api('POST', '/api/tasks', { title: 'Newer task' })).body.reference, 'ERP-003');
}));

mysqlTest('the foreign key rejects a comment for a task that does not exist', () => withApp(async ({ pool }) => {
  await assert.rejects(
    pool.execute("INSERT INTO comments (task_id, author, body, created_at) VALUES (12345, 'Mausooq', 'orphan', UTC_TIMESTAMP(3))"),
    error => error.code === 'ER_NO_REFERENCED_ROW_2');
}));

mysqlTest('old tasks.json is imported only by the explicit command, once, unchanged, with no duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-tracker-legacy-'));
  const legacyFile = path.join(dir, 'tasks.json');
  const legacyText = JSON.stringify([
    { id: 'aaa-1', title: 'start the research work', completed: false, createdAt: '2026-11-16T08:44:04.180Z' },
    { id: 'aaa-2', title: 'get the assignment completed', completed: true, createdAt: '2026-11-15T10:00:00.000Z' },
    { id: 'aaa-3', title: '   ', completed: false }
  ], null, 2);
  fs.writeFileSync(legacyFile, legacyText);

  const database = await createTestDatabase();
  let app = await startApp(database);
  try {
    // Starting the application does NOT import anything.
    assert.equal((await app.api('GET', '/api/tasks')).body.count, 0);

    const result = await importLegacyTasks(app.pool, legacyFile);
    assert.equal(result.status, 'imported');
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 1);

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

    // Running it again changes nothing. A task deleted permanently does not come back.
    assert.equal((await importLegacyTasks(app.pool, legacyFile)).status, 'already-imported');
    await app.api('POST', `/api/tasks/${done.id}/trash`);
    await app.api('DELETE', `/api/trash/${done.id}`);

    await app.stop();
    app = await startApp(database);
    assert.equal((await importLegacyTasks(app.pool, legacyFile)).status, 'already-imported');
    assert.equal((await app.api('GET', '/api/tasks')).body.count, 1);
    assert.equal((await app.api('GET', '/api/trash')).body.count, 0);

    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyText, 'the old file is left exactly as it was');
  } finally {
    await app.stop();
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('two imports at the same moment import the old tasks only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-tracker-legacy-'));
  const legacyFile = path.join(dir, 'tasks.json');
  fs.writeFileSync(legacyFile, JSON.stringify([{ id: 'a', title: 'one', completed: false }, { id: 'b', title: 'two', completed: true }]));
  const database = await createTestDatabase();
  const pool = createPool({ ...database.dbConfig, connectionLimit: 6 });
  try {
    const results = await Promise.all([importLegacyTasks(pool, legacyFile), importLegacyTasks(pool, legacyFile), importLegacyTasks(pool, legacyFile)]);
    assert.deepEqual(results.map(result => result.status).sort(), ['already-imported', 'already-imported', 'imported']);
    const [[row]] = await pool.query('SELECT COUNT(*) AS total FROM tasks');
    assert.equal(row.total, 2);
  } finally {
    await closePool(pool);
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('real ERP module names are offered; MIS, BI and both Warehouse modules stay separate', () => withApp(async ({ api }) => {
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

mysqlTest('tasks saved under older module names are preserved until explicitly remapped', () => withApp(async ({ api }, database) => {
  // Simulate tasks created before the module list changed.
  const insert = `INSERT INTO \`${database.database}\`.tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at)
                  VALUES (?, 'older data', ?, 'Parimitha', 'High', 'In Progress', NULL, '2026-11-01 08:00:00.000', '2026-11-01 08:00:00.000')`;
  await database.admin.query(insert, ['Old finance task', 'Finance & Accounts']);
  await database.admin.query(insert, ['Old general task', 'General']);
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

  // An older name cannot be chosen for another task, or for a new one.
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
