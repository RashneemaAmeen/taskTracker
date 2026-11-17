// Tests for the explicit, one-time SQLite -> MySQL import (npm run import-sqlite).
//
// The first group needs NO MySQL server: it checks how the old SQLite file is read, checked
// and converted, and, with a recording stand-in for MySQL, exactly which statements the
// import would run. The second group runs the real import against MySQL and is skipped
// unless TEST_DB_ADMIN_USER is set (see tests/helpers/mysqlTestDb.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { importSqliteFile, readSqliteFile, prepareRows, ImportProblem } = require('../src/sqliteImport');
const { createPool, verifyDatabase, closePool, getMeta } = require('../src/database');
const { createApp } = require('../src/app');
const { buildOldDatabase, OLD_SCHEMA } = require('./helpers/sqliteFixture');
const { skipReason, createTestDatabase } = require('./helpers/mysqlTestDb');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sqlite-test-'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Everything about the files in a folder that would change if something wrote to them.
function fingerprint(dir) {
  return fs.readdirSync(dir).sort().map(name => `${name}:${fs.statSync(path.join(dir, name)).size}:${sha(path.join(dir, name))}`);
}

// A stand-in for the MySQL pool that records every statement and answers like an EMPTY database.
function recordingPool({ existingMarker = null, counts = { tasks: 0, comments: 0 } } = {}) {
  const statements = [];
  let transaction = 'none';
  const execute = async (sql, params = []) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params, transaction });
    if (/^SELECT meta_value FROM app_meta/.test(sql)) return [existingMarker ? [{ meta_value: existingMarker }] : [], []];
    if (/COUNT\(\*\) FROM tasks\) AS tasks/.test(sql)) return [[counts], []];
    return [{ affectedRows: 1, insertId: 0 }, []];
  };
  const connection = {
    execute,
    beginTransaction: async () => { transaction = 'open'; },
    commit: async () => { transaction = 'committed'; },
    rollback: async () => { transaction = 'rolled-back'; },
    release() {}
  };
  return { statements, execute, getConnection: async () => connection, get transaction() { return transaction; } };
}

/* ---------- Reading and checking the SQLite file (no MySQL needed) ---------- */

test('the SQLite file is read completely, including recent changes that are still in its -wal file', () => {
  const dir = tempDir();
  const { file, db } = buildOldDatabase(dir);
  try {
    assert.ok(fs.existsSync(`${file}-wal`), 'the fixture has an un-checkpointed -wal file, like an app that was not shut down cleanly');
    const before = fingerprint(dir);

    const source = readSqliteFile(file);
    assert.deepEqual(source.tasks.map(task => task.id), [1, 2, 3]);
    assert.equal(source.comments.length, 3);
    assert.equal(source.highestIdEverUsed, 4);
    assert.deepEqual(source.markers.map(marker => marker.key).sort(), ['legacy_import', 'sample_seeded'], 'only the one-time-job markers are carried over');

    assert.deepEqual(fingerprint(dir), before, 'the original SQLite files are byte-for-byte unchanged');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rows are converted for MySQL: ids, versions, Trash state, dates and text are preserved', () => {
  const dir = tempDir();
  const { file, db } = buildOldDatabase(dir);
  try {
    const { tasks, comments } = prepareRows(readSqliteFile(file));
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks[0], {
      id: 1, title: 'start the research work', description: '', module: 'General / Cross-module', assignee: null,
      priority: 'Medium', status: 'To Do', dueDate: null,
      createdAt: '2026-11-16 08:44:04.180', updatedAt: '2026-11-16 08:44:04.180', version: 1, deletedAt: null, legacyId: 'aaa-1'
    });
    assert.equal(tasks[1].module, 'Finance & Accounts', 'an older module name is kept as it is');
    assert.equal(tasks[1].dueDate, '2026-11-20', 'due dates stay plain calendar days');
    assert.equal(tasks[1].updatedAt, '2026-11-12 09:15:30.250');
    assert.equal(tasks[1].version, 3);
    assert.equal(tasks[2].deletedAt, '2026-11-15 09:30:00.000', 'Trash state is kept');
    assert.equal(tasks[2].dueDate, '2028-02-29');
    assert.deepEqual(comments.map(comment => [comment.id, comment.taskId, comment.author]), [[1, 2, 'Parimitha'], [2, 2, 'Mausooq'], [3, 3, 'Thameem']]);
    assert.ok(comments[1].body.includes('\u{1F4E6}') && comments[1].body.includes('مهمة'), 'emoji and Arabic text survive');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('data that does not fit the MySQL tables is rejected up front, listing every problem', () => {
  const dir = tempDir();
  const file = path.join(dir, 'broken.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(OLD_SCHEMA.replace(/CHECK \(\w+ IN \([^)]*\)\)/g, ''));      // no CHECK constraints, so bad values can exist
    const insert = db.prepare('INSERT INTO tasks (title, description, module, priority, status, due_date, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('x'.repeat(151), '', 'CRM', 'Low', 'To Do', null, '2026-11-16T08:00:00.000Z', '2026-11-16T08:00:00.000Z', 1);
    insert.run('fine', '', 'CRM', 'Urgent', 'To Do', null, '2026-11-16T08:00:00.000Z', '2026-11-16T08:00:00.000Z', 1);
    insert.run('fine', '', 'CRM', 'Low', 'Done', '2026-02-30', 'not a time', '2026-11-16T08:00:00.000Z', 1);
    db.close();

    assert.throws(() => prepareRows(readSqliteFile(file)), error => {
      assert.ok(error instanceof ImportProblem);
      assert.match(error.message, /Nothing was imported/);
      assert.match(error.message, /task 1: title is empty or longer than 150/);
      assert.match(error.message, /task 2: priority "Urgent"/);
      assert.match(error.message, /task 3: status "Done"/);
      assert.match(error.message, /task 3: due date "2026-02-30"/);
      assert.match(error.message, /task 3: created\/updated time is not a valid timestamp/);
      return true;
    });
  } finally {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file or a file that is not a task-tracker database gives a clear message', () => {
  const dir = tempDir();
  try {
    assert.throws(() => readSqliteFile(path.join(dir, 'nope.db')), /SQLite file not found/);

    const other = path.join(dir, 'other.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE something_else (a INTEGER)');
    db.close();
    assert.throws(() => readSqliteFile(other), /not an ERP Rebuild Task Tracker database/);

    const text = path.join(dir, 'notes.db');
    fs.writeFileSync(text, 'this is not a database, just some text '.repeat(50));
    assert.throws(() => readSqliteFile(text), ImportProblem);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- What the import would run (stand-in for MySQL) ---------- */

test('a dry run writes nothing', async () => {
  const dir = tempDir();
  const { file, db } = buildOldDatabase(dir);
  try {
    const pool = recordingPool();
    const result = await importSqliteFile(pool, file, { dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.tasks, 3);
    assert.equal(result.inTrash, 1);
    assert.equal(result.comments, 3);
    assert.equal(result.highestTaskId, 3);
    assert.ok(pool.statements.every(statement => /^SELECT/.test(statement.sql)), 'only reads');
    assert.equal(pool.transaction, 'none');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the import is refused when it was already done or when the tables are not empty', async () => {
  const dir = tempDir();
  const { file, db } = buildOldDatabase(dir);
  try {
    const marker = JSON.stringify({ importedAt: '2026-11-17T10:00:00.000Z', tasks: 3, inTrash: 1, comments: 3 });
    const done = recordingPool({ existingMarker: marker });
    const again = await importSqliteFile(done, file);
    assert.equal(again.status, 'already-imported');
    assert.equal(again.importedAt, '2026-11-17T10:00:00.000Z');
    assert.ok(done.statements.every(statement => /^SELECT/.test(statement.sql)));

    const busy = recordingPool({ counts: { tasks: 2, comments: 0 } });
    const refused = await importSqliteFile(busy, file);
    assert.deepEqual({ status: refused.status, tasks: refused.tasks }, { status: 'target-not-empty', tasks: 2 });
    assert.ok(busy.statements.every(statement => /^SELECT/.test(statement.sql)), 'nothing was written');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the import saves tasks, comments and markers in one transaction, in the right order', async () => {
  const dir = tempDir();
  const { file, db } = buildOldDatabase(dir);
  try {
    const pool = recordingPool();
    const result = await importSqliteFile(pool, file);
    assert.equal(result.status, 'imported');
    assert.deepEqual([result.tasks, result.inTrash, result.comments], [3, 1, 3]);
    assert.equal(pool.transaction, 'committed');

    const writes = pool.statements.filter(statement => /^(INSERT|DELETE)/.test(statement.sql));
    assert.ok(writes.every(statement => statement.transaction === 'open'), 'every write is inside the transaction');
    for (const { sql, params } of pool.statements) {
      assert.equal((sql.match(/\?/g) || []).length, params.length, `placeholders vs values: ${sql.slice(0, 80)}`);
      assert.ok(params.every(value => value !== undefined), 'no undefined values');
    }

    const kinds = writes.map(statement => statement.sql.match(/^(INSERT INTO \w+|DELETE FROM \w+)/)[1]);
    assert.equal(kinds[0], 'INSERT INTO app_meta', 'the job is claimed first');
    assert.deepEqual(kinds.slice(1, 4), ['INSERT INTO tasks', 'INSERT INTO tasks', 'INSERT INTO tasks']);
    assert.deepEqual(kinds.slice(4, 7), ['INSERT INTO comments', 'INSERT INTO comments', 'INSERT INTO comments'], 'comments come after their tasks');

    const taskInserts = writes.filter(statement => statement.sql.startsWith('INSERT INTO tasks (id,'));
    assert.deepEqual(taskInserts.slice(0, 3).map(statement => statement.params[0]), [1, 2, 3], 'task ids are kept');
    const trashed = taskInserts[2].params;
    assert.equal(trashed[11], '2026-11-15 09:30:00.000', 'deleted_at (Trash state) is kept');
    assert.equal(trashed[10], 2, 'version is kept');

    // Task number 4 was used once and deleted. MySQL's counter must move past it.
    const placeholder = writes.find(statement => /'placeholder'/.test(statement.sql));
    assert.equal(placeholder.params[0], 4);
    const removal = writes.find(statement => statement.sql.startsWith('DELETE FROM tasks WHERE id = ?'));
    assert.deepEqual(removal.params, [4]);
    assert.ok(writes.indexOf(placeholder) < writes.indexOf(removal));

    const markers = writes.filter(statement => statement.sql.startsWith('INSERT INTO app_meta') && statement.sql.includes('ON DUPLICATE KEY'));
    assert.deepEqual(markers.map(statement => statement.params[0]), ['legacy_import', 'sample_seeded', 'sqlite_import']);
    assert.ok(!markers.some(statement => statement.params[0] === 'unrelated_key'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- The real import against MySQL (skipped without TEST_DB_ADMIN_USER) ---------- */

const mysqlTest = (name, run) => test(name, { skip: skipReason }, run);

mysqlTest('MySQL: tasks keep their numbers, Trash state, versions, comments and timestamps; nothing is duplicated', async () => {
  const dir = tempDir();
  const { file, db: sqlite } = buildOldDatabase(dir);
  const database = await createTestDatabase();
  const pool = createPool(database.dbConfig);
  try {
    await verifyDatabase(pool);
    sqlite.close();                                               // let SQLite merge its -wal file, as a clean shutdown would
    const before = fingerprint(dir);

    const result = await importSqliteFile(pool, file);
    assert.equal(result.status, 'imported');
    assert.deepEqual([result.tasks, result.inTrash, result.comments], [3, 1, 3]);
    assert.deepEqual(fingerprint(dir), before, 'the SQLite file is unchanged and still there');

    const server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async url => (await fetch(base + url)).json();
    const post = async (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const active = (await get('/api/tasks')).tasks;
      assert.deepEqual(active.map(task => task.reference).sort(), ['ERP-001', 'ERP-002']);
      const chart = active.find(task => task.reference === 'ERP-002');
      assert.equal(chart.title, 'Define chart of accounts');
      assert.equal(chart.status, 'Completed');
      assert.equal(chart.assignee, 'Parimitha');
      assert.equal(chart.module, 'Finance & Accounts');
      assert.equal(chart.moduleIsOlderName, true);
      assert.equal(chart.dueDate, '2026-11-20');
      assert.equal(chart.version, 3);
      assert.equal(chart.createdAt, '2026-11-10T07:00:00.000Z');
      assert.equal(chart.updatedAt, '2026-11-12T09:15:30.250Z');
      assert.equal(chart.commentCount, 2);

      const trash = (await get('/api/trash')).tasks;
      assert.deepEqual(trash.map(task => [task.reference, task.deletedAt]), [['ERP-003', '2026-11-15T09:30:00.000Z']]);
      assert.equal(trash[0].dueDate, '2028-02-29');

      const comments = (await get('/api/tasks/2/comments')).comments;
      assert.deepEqual(comments.map(comment => comment.id), [1, 2]);
      assert.equal(comments[1].createdAt, '2026-11-12T09:15:30.250Z');
      assert.ok(comments[1].body.includes('\u{1F4E6}') && comments[1].body.includes('مهمة'));
      assert.equal((await get('/api/tasks/3/comments')).comments[0].body, 'Comment on the trashed task');

      // Restoring the imported Trash task works and its comment is intact.
      assert.equal((await post('/api/trash/3/restore', {})).status, 200);
      assert.equal((await get('/api/tasks/3')).deletedAt, null);

      // Number 4 was used before and deleted for good: the next new task is 5, never 4.
      const created = await (await post('/api/tasks', { title: 'First task after the import' })).json();
      assert.equal(created.reference, 'ERP-005');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }

    // One-time markers were carried over, the unrelated key was not, and the import is recorded.
    assert.ok(await getMeta(pool, 'legacy_import'));
    assert.ok(await getMeta(pool, 'sample_seeded'));
    assert.equal(await getMeta(pool, 'unrelated_key'), null);
    assert.ok(await getMeta(pool, 'sqlite_import'));

    // Running it again changes nothing: no duplicates.
    const again = await importSqliteFile(pool, file);
    assert.equal(again.status, 'already-imported');
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM comments) AS comments');
    assert.deepEqual([counts.tasks, counts.comments], [4, 3]);   // 3 imported + 1 created above
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    await closePool(pool);
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('MySQL: the import refuses to mix data into tables that already hold tasks', async () => {
  const dir = tempDir();
  const { file, db: sqlite } = buildOldDatabase(dir);
  sqlite.close();
  const database = await createTestDatabase();
  const pool = createPool(database.dbConfig);
  try {
    await pool.execute(`INSERT INTO tasks (title, description, module, priority, status, created_at, updated_at)
                        VALUES ('already here', '', 'CRM', 'Low', 'To Do', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`);
    const result = await importSqliteFile(pool, file);
    assert.equal(result.status, 'target-not-empty');
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM comments) AS comments');
    assert.deepEqual([counts.tasks, counts.comments], [1, 0], 'nothing was added');
    assert.equal(await getMeta(pool, 'sqlite_import'), null, 'the import was not recorded as done');
  } finally {
    await closePool(pool);
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('MySQL: if anything fails during the import, nothing at all is saved', async () => {
  const dir = tempDir();
  const { file, db: sqlite } = buildOldDatabase(dir);
  sqlite.close();
  const database = await createTestDatabase();
  const pool = createPool(database.dbConfig);
  try {
    // Make the SECOND task fail inside MySQL (a legacy id that already exists would be a duplicate key),
    // after the first task was already inserted in the same transaction.
    const original = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await original();
      const execute = connection.execute.bind(connection);
      let taskInserts = 0;
      connection.execute = async (sql, params) => {
        if (/^\s*INSERT INTO tasks \(id,/.test(sql) && ++taskInserts === 2) throw Object.assign(new Error('simulated failure'), { code: 'ER_SIMULATED' });
        return execute(sql, params);
      };
      return connection;
    };
    await assert.rejects(importSqliteFile(pool, file), /simulated failure/);
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM comments) AS comments');
    assert.deepEqual([counts.tasks, counts.comments], [0, 0], 'the first task was rolled back too');
    assert.equal(await getMeta(pool, 'sqlite_import'), null, 'and the import can simply be run again');
  } finally {
    await closePool(pool);
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
