// API behaviour that must hold WITHOUT touching the database: input validation, security
// checks and the answer when MySQL is down. Uses a stand-in database that fails the test if
// the application asks it anything it should not. Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { createRoutes } = require('../src/routes');
const store = require('../src/taskStore');

// A "database" that records every statement and answers with whatever the test supplies.
function fakeDatabase(answer = () => { throw new Error('the database must not be used for this request'); }) {
  const calls = [];
  const execute = async (sql, params = []) => { calls.push({ sql, params }); return answer(sql, params); };
  const database = {
    calls,
    execute,
    query: execute,
    async getConnection() {
      return { execute, query: execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    }
  };
  return database;
}

async function withApp(database, run) {
  const server = createApp(database).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, url, body, headers = {}) => {
    const options = { method, headers: { ...headers } };
    if (body !== undefined) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] ??= 'application/json';
    }
    const response = await fetch(base + url, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try { await run({ api, base }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('invalid requests are refused before the database is used', async () => {
  const database = fakeDatabase();
  await withApp(database, async ({ api }) => {
    const bad = [
      [{}, 'title'], [{ title: '   ' }, 'title'], [{ title: 'x'.repeat(151) }, 'title'],
      [{ title: 'ok', description: 'x'.repeat(4001) }, 'description'],
      [{ title: 'ok', module: 'Payroll' }, 'module'], [{ title: 'ok', module: 'Finance & Accounts' }, 'module'],
      [{ title: 'ok', assignee: 'Stranger' }, 'assignee'], [{ title: 'ok', priority: 'Urgent' }, 'priority'],
      [{ title: 'ok', status: 'Done' }, 'status'], [{ title: 'ok', dueDate: '2026-02-30' }, 'dueDate'],
      [{ title: 'ok', dueDate: '16/11/2026' }, 'dueDate']
    ];
    for (const [body, field] of bad) {
      const response = await api('POST', '/api/tasks', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(response.body.fields[field], field);
    }
    assert.equal((await api('POST', '/api/tasks', '{not json')).status, 400);
    assert.equal((await api('POST', '/api/tasks', '[1,2]')).status, 400);
    assert.equal((await api('POST', '/api/tasks', 'title=x', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await api('POST', '/api/tasks', { title: 'x'.repeat(60000) })).status, 413);
    assert.equal((await api('GET', '/api/tasks/abc')).status, 400);
    assert.equal((await api('GET', '/api/nothing-here')).status, 404);
    assert.equal((await api('GET', '/api/tasks?status=Done')).status, 400);
    assert.equal((await api('GET', '/api/tasks?overdue=maybe')).status, 400);
    assert.equal((await api('GET', '/api/dashboard?priority=Urgent')).status, 400);
    assert.equal((await api('PATCH', '/api/tasks/1', { title: 'no version' })).status, 400);
    assert.equal((await api('POST', '/api/tasks/1/comments', { author: 'Nobody', body: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/tasks/1/comments', { author: 'Mausooq', body: '  ' })).status, 400);
  });
  assert.equal(database.calls.length, 0, 'no statement reached the database');
});

test('requests from another website are blocked before the database is used', async () => {
  const database = fakeDatabase();
  await withApp(database, async ({ api }) => {
    assert.equal((await api('POST', '/api/tasks', { title: 'x' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await api('POST', '/api/tasks', { title: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await api('DELETE', '/api/trash/1', undefined, { Origin: 'http://evil.example' })).status, 403);
  });
  assert.equal(database.calls.length, 0);
});

test('when MySQL is unreachable the API answers 503 with a plain message and leaks nothing', async () => {
  const secret = 'S3cret-Passw0rd!';
  const down = () => { throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:3306 (${secret})`), { code: 'ECONNREFUSED', errno: -4078 }); };
  const database = fakeDatabase(down);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await withApp(database, async ({ api }) => {
      const list = await api('GET', '/api/tasks');
      assert.equal(list.status, 503);
      assert.equal(list.body.code, 'DATABASE_UNAVAILABLE');
      assert.match(list.body.error, /not reachable/);
      assert.ok(!JSON.stringify(list.body).includes(secret));
      assert.ok(!JSON.stringify(list.body).includes('127.0.0.1'));

      assert.equal((await api('POST', '/api/tasks', { title: 'x' })).status, 503);
      assert.equal((await api('GET', '/api/tasks/1')).status, 503);

      const health = await api('GET', '/health');
      assert.equal(health.status, 503);
      assert.deepEqual(health.body, { status: 'error', app: 'ERP Rebuild Task Tracker', database: 'unavailable' });
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some(line => line.includes('ECONNREFUSED')), 'the problem is logged for the administrator');
});

test('a deadlock or lock timeout is reported as "busy", not as a crash', async () => {
  const database = fakeDatabase(() => { throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }); });
  const originalError = console.error;
  console.error = () => {};
  try {
    await withApp(database, async ({ api }) => {
      const response = await api('GET', '/api/tasks/1');
      assert.equal(response.status, 503);
      assert.match(response.body.error, /busy/);
    });
  } finally {
    console.error = originalError;
  }
});

test('an unexpected programming or SQL error becomes a safe 500', async () => {
  const database = fakeDatabase(() => { throw Object.assign(new Error("You have an error in your SQL syntax near 'secret'"), { code: 'ER_PARSE_ERROR', errno: 1064 }); });
  const originalError = console.error;
  console.error = () => {};
  try {
    await withApp(database, async ({ api }) => {
      const response = await api('GET', '/api/tasks/1');
      assert.equal(response.status, 500);
      assert.ok(!JSON.stringify(response.body).toLowerCase().includes('syntax'), 'SQL details are not shown to users');
    });
  } finally {
    console.error = originalError;
  }
});

/* ---------- Every SQL statement is parameterised correctly ---------- */

// Exercises every store function against a stand-in and checks, for EVERY statement, that the
// number of "?" placeholders equals the number of values and that no value is undefined
// (the MySQL driver rejects undefined). This does not replace running against MySQL.
test('every statement has exactly as many values as placeholders, and none is undefined', async () => {
  const task = { id: 7, title: 't', description: '', module: 'CRM', assignee: null, priority: 'Low', status: 'To Do',
    due_date: '2026-12-31', created_at: '2026-11-16 08:00:00.000', updated_at: '2026-11-16 08:00:00.000', version: 1, deleted_at: null, comment_count: 0 };
  const database = fakeDatabase(sql => {
    if (/^\s*(UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1 }, []];
    if (/^\s*INSERT/i.test(sql)) return [{ affectedRows: 1, insertId: 7 }, []];
    if (/COUNT\(\*\) AS active/.test(sql)) return [[{ active: 1, in_progress: 0, completed: 0, overdue: 0 }], []];
    if (/FROM comments WHERE/.test(sql)) return [[{ id: 1, task_id: 7, author: 'Mausooq', body: 'x', created_at: '2026-11-16 08:00:00.000' }], []];
    return [[task], []];
  });

  const filterSets = [
    {}, { q: 'invoice' }, { q: '100%_!' }, { assignee: 'Thameem' }, { assignee: 'Unassigned' }, { module: 'CRM' },
    { priority: 'High' }, { status: 'Blocked' }, { overdue: true },
    { q: 'x', assignee: 'Mausooq', module: 'Pricing', priority: 'Low', status: 'To Do', overdue: true }
  ];
  for (const filters of filterSets) {
    await store.listTasks(database, filters);
    await store.getDashboard(database, filters);
  }
  await store.listOlderModules(database);
  await store.getTask(database, 7);
  await store.createTask(database, { title: 't', description: '', module: 'CRM', priority: 'Low', status: 'To Do' });   // assignee and dueDate omitted
  await store.createTask(database, { title: 't', description: 'd', module: 'CRM', assignee: 'Thameem', priority: 'High', status: 'Completed', dueDate: '2026-12-31' });
  await store.updateTask(database, 7, { title: 'n', description: '', module: 'CRM', assignee: null, priority: 'Low', status: 'Blocked', dueDate: null }, 1);
  await store.updateTask(database, 7, { status: 'Completed' }, 1);
  await store.moveToTrash(database, 7);
  await store.restoreTask(database, 7);
  await store.deletePermanently(database, 7);
  await store.listTrash(database);
  await store.listComments(database, 7);
  await store.addComment(database, 7, { author: 'Mausooq', body: 'hello' });

  assert.ok(database.calls.length > 40, 'a good number of statements were checked');
  for (const { sql, params } of database.calls) {
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(params.length, placeholders, `placeholders vs values in: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    assert.ok(params.every(value => value !== undefined), `undefined value in: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    assert.doesNotMatch(sql, /\bSELECT\b[^;]*['"][^'"?]*\b(Thameem|invoice)\b/i, 'user values are never written into the SQL text');
  }
  // Statements that change data never contain a value from the request inline either.
  const updates = database.calls.filter(call => /^\s*UPDATE tasks SET (title|status)/i.test(call.sql));
  assert.ok(updates.length >= 2);
  assert.ok(updates.every(call => /WHERE id = \? AND version = \? AND deleted_at IS NULL/.test(call.sql)), 'optimistic concurrency condition is part of the UPDATE');
});

test('createRoutes returns a router (smoke test)', () => {
  assert.equal(typeof createRoutes(fakeDatabase()), 'function');
});
