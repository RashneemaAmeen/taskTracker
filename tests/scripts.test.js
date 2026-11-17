// The command-line scripts (npm run seed, db:check, import-legacy, import-sqlite, map-module,
// backup), run as real child processes against a throw-away MySQL database.
// Skipped without TEST_DB_ADMIN_USER (see tests/helpers/mysqlTestDb.js).
// The backup test also needs mysqldump (set MYSQLDUMP_PATH if it is not on PATH).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { projectRoot } = require('../src/config');
const { skipReason, createTestDatabase } = require('./helpers/mysqlTestDb');
const { buildOldDatabase } = require('./helpers/sqliteFixture');

const mysqlTest = (name, run) => test(name, { skip: skipReason }, run);

function runScript(name, args, database, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join('scripts', name), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      DB_HOST: database.dbConfig.host, DB_PORT: String(database.dbConfig.port), DB_NAME: database.database,
      DB_USER: database.dbConfig.user, DB_PASSWORD: database.dbConfig.password, ...extraEnv
    }
  });
  return { code: result.status, out: result.stdout + result.stderr, stdout: result.stdout, stderr: result.stderr };
}

const count = async (database, table, where = '1=1') => {
  const [[row]] = await database.admin.query(`SELECT COUNT(*) AS total FROM \`${database.database}\`.\`${table}\` WHERE ${where}`);
  return row.total;
};

mysqlTest('db:check connects with the application account and never prints the password', async () => {
  const database = await createTestDatabase();
  try {
    const result = runScript('db-check.js', [], database);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Connected to MySQL \d+\./);
    assert.match(result.out, new RegExp(`database: ${database.database}`));
    assert.match(result.out, /tasks\s+0 row\(s\)/);
    assert.match(result.out, /comments\s+0 row\(s\)/);
    assert.match(result.out, /app_meta\s+0 row\(s\)/);
    assert.ok(!result.out.includes(database.dbConfig.password));
  } finally {
    await database.drop();
  }
});

mysqlTest('scripts explain a wrong password or missing tables instead of crashing', async () => {
  const database = await createTestDatabase({ schema: false });
  try {
    const missing = runScript('db-check.js', [], database);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /required table is missing.*schema\.mysql\.sql/s);
    assert.doesNotMatch(missing.out, /\n\s+at /, 'no stack trace');

    const wrong = runScript('db-check.js', [], database, { DB_PASSWORD: 'not-the-password' });
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /refused the login/);
    assert.ok(!wrong.out.includes('not-the-password'));
  } finally {
    await database.drop();
  }
});

mysqlTest('seed adds the sample tasks once, labelled, and refuses to run twice', async () => {
  const database = await createTestDatabase();
  try {
    const first = runScript('seed.js', [], database);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Added 17 sample tasks/);
    assert.equal(await count(database, 'tasks'), 17);
    assert.equal(await count(database, 'comments'), 5);
    assert.equal(await count(database, 'tasks', "title NOT LIKE '[Sample] %'"), 0, 'every sample title starts with [Sample]');

    const second = runScript('seed.js', [], database);
    assert.equal(second.code, 0);
    assert.match(second.out, /already added/);
    assert.equal(await count(database, 'tasks'), 17, 'no duplicates');
  } finally {
    await database.drop();
  }
});

mysqlTest('import-legacy imports tasks.json only when run, once, and leaves the file alone', async () => {
  const database = await createTestDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-script-legacy-'));
  const text = JSON.stringify([{ id: 'q1', title: 'one', completed: false, createdAt: '2026-11-16T08:44:04.180Z' }, { id: 'q2', title: 'two', completed: true }]);
  fs.writeFileSync(path.join(dir, 'tasks.json'), text);
  try {
    const first = runScript('import-legacy.js', [], database, { DATA_DIR: dir });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Imported 2 task\(s\)/);
    assert.equal(await count(database, 'tasks'), 2);
    assert.equal(await count(database, 'tasks', "status = 'Completed'"), 1);

    const second = runScript('import-legacy.js', [], database, { DATA_DIR: dir });
    assert.match(second.out, /Already imported/);
    assert.equal(await count(database, 'tasks'), 2);
    assert.equal(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'), text);

    const none = runScript('import-legacy.js', [], database, { DATA_DIR: path.join(dir, 'missing') });
    assert.equal(none.code, 0);
  } finally {
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('import-sqlite: dry run, import, repeat, and refusal on a used database', async () => {
  const database = await createTestDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-script-sqlite-'));
  const { file, db: sqlite } = buildOldDatabase(dir);
  sqlite.close();
  try {
    const dry = runScript('import-sqlite.js', [file, '--dry-run'], database);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Dry run: .* holds 3 task\(s\) \(1 in Trash\) and 3 comment\(s\)\. Highest task number: ERP-003/);
    assert.equal(await count(database, 'tasks'), 0, 'a dry run writes nothing');

    const real = runScript('import-sqlite.js', [file], database);
    assert.equal(real.code, 0, real.out);
    assert.match(real.out, /Imported 3 task\(s\) \(1 in Trash\) and 3 comment\(s\)/);
    assert.match(real.out, /matches the file/);
    assert.equal(await count(database, 'tasks'), 3);
    assert.equal(await count(database, 'tasks', 'deleted_at IS NOT NULL'), 1);
    assert.equal(await count(database, 'comments'), 3);
    assert.ok(fs.existsSync(file), 'the SQLite file is still there');

    const again = runScript('import-sqlite.js', [file], database);
    assert.equal(again.code, 0);
    assert.match(again.out, /already done/);
    assert.equal(await count(database, 'tasks'), 3);

    const bad = runScript('import-sqlite.js', [path.join(dir, 'nope.db')], database);
    assert.match(bad.out, /already done|not found/);

    const unknownOption = runScript('import-sqlite.js', ['--force'], database);
    assert.equal(unknownOption.code, 1);
    assert.match(unknownOption.out, /Unknown option --force/);
  } finally {
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

mysqlTest('map-module lists older names and moves them only when asked', async () => {
  const database = await createTestDatabase();
  try {
    const insert = `INSERT INTO \`${database.database}\`.tasks (title, description, module, priority, status, created_at, updated_at, deleted_at)
                    VALUES (?, '', ?, 'Low', 'To Do', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`;
    await database.admin.query(insert, ['a', 'Finance & Accounts', null]);
    await database.admin.query(insert, ['b', 'Finance & Accounts', '2026-11-01 10:00:00.000']);
    await database.admin.query(insert, ['c', 'Financials', null]);

    const list = runScript('map-module.js', [], database);
    assert.equal(list.code, 0, list.out);
    assert.match(list.out, /"Finance & Accounts"\s+-\s+2 task\(s\), 1 of them in Trash/);
    assert.doesNotMatch(list.out, /"Financials"\s+-/);

    assert.equal(runScript('map-module.js', ['Finance & Accounts'], database).code, 1);
    assert.equal(runScript('map-module.js', ['Finance & Accounts', 'Nowhere'], database).code, 1);
    assert.equal(runScript('map-module.js', ['Financials', 'CRM'], database).code, 1, 'a current name is not an older name');
    assert.equal(await count(database, 'tasks', "module = 'Finance & Accounts'"), 2, 'nothing moved yet');

    const moved = runScript('map-module.js', ['Finance & Accounts', 'Financials'], database);
    assert.equal(moved.code, 0, moved.out);
    assert.match(moved.out, /Moved 2 task\(s\)/);
    assert.equal(await count(database, 'tasks', "module = 'Financials'"), 3);
    assert.equal(await count(database, 'tasks', 'version = 2'), 2, 'moved tasks count as edited, so open browsers are told');

    assert.match(runScript('map-module.js', [], database).out, /Nothing needs mapping/);
  } finally {
    await database.drop();
  }
});

// ---- Backup and restore (needs mysqldump) ----

const mysqldumpPath = process.env.MYSQLDUMP_PATH || 'mysqldump';
const mysqldump = spawnSync(mysqldumpPath, ['--version'], { encoding: 'utf8', windowsHide: true });
const backupSkip = skipReason || (mysqldump.status === 0 ? false
  : `mysqldump was not found ("${mysqldumpPath}"). Add MySQL's bin folder to PATH or set MYSQLDUMP_PATH to run the backup test.`);

test('backup writes a complete .sql file with the application account, and it restores correctly', { skip: backupSkip }, async () => {
  const database = await createTestDatabase();
  const target = await createTestDatabase({ schema: false });          // an empty database to restore into
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-script-backup-'));
  try {
    assert.equal(runScript('seed.js', [], database).code, 0);
    await database.admin.query(
      `INSERT INTO \`${database.database}\`.tasks (title, description, module, priority, status, due_date, created_at, updated_at)
       VALUES (?, ?, 'CRM', 'High', 'Blocked', '2028-02-29', '2026-11-16 08:00:00.123', '2026-11-16 08:00:00.123')`,
      ["unicode \u{1F4E6} مهمة and 'quotes'", 'line one\nline two \\ backslash "double"']);

    const backup = runScript('backup.js', [], database, { BACKUP_DIR: dir, MYSQLDUMP_PATH: mysqldumpPath });
    assert.equal(backup.code, 0, backup.out);
    assert.match(backup.out, /Backup saved: /);
    assert.match(backup.out, /Dump completed/);
    assert.ok(!backup.out.includes(database.dbConfig.password), 'the password is never printed');

    const files = fs.readdirSync(dir).filter(name => name.endsWith('.sql'));
    assert.equal(files.length, 1);
    assert.match(files[0], new RegExp(`^${database.database}-\\d{8}-\\d{6}\\.sql$`));
    const dump = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(dump, /CREATE TABLE `tasks`/);
    assert.match(dump, /CREATE TABLE `comments`/);
    assert.match(dump, /-- Dump completed/);
    assert.ok(!dump.includes(database.dbConfig.password), 'the password is not inside the backup either');
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('erp-backup-') && fs.existsSync(path.join(os.tmpdir(), name, 'client.cnf'))), [],
      'the temporary credentials file was deleted');

    // Restore into the empty database as the administrator, then compare everything.
    await target.admin.query(`USE \`${target.database}\``);
    await target.admin.query(dump);
    for (const table of ['tasks', 'comments', 'app_meta']) {
      assert.equal(await count(target, table), await count(database, table), `${table} row count after restore`);
    }
    const q = db => `SELECT id, title, description, module, assignee, priority, status, DATE_FORMAT(due_date, '%Y-%m-%d') AS due,
                            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created, version, deleted_at IS NULL AS live, legacy_id
                     FROM \`${db.database}\`.tasks ORDER BY id`;
    const [original] = await database.admin.query(q(database));
    const [restored] = await target.admin.query(q(target));
    const plain = rows => JSON.parse(JSON.stringify(rows));
    assert.equal(original.length, 18, '17 sample tasks and the unicode task');
    assert.deepEqual(plain(restored), plain(original), 'every task field, including due dates and emoji, survived backup and restore');
    const [[special]] = await target.admin.query(`SELECT description FROM \`${target.database}\`.tasks WHERE id = 18`);
    assert.equal(special.description, 'line one\nline two \\ backslash "double"', 'newlines, backslashes and quotes survived');
    const [[fk]] = await target.admin.query(`SELECT COUNT(*) AS total FROM information_schema.REFERENTIAL_CONSTRAINTS
                                            WHERE CONSTRAINT_SCHEMA = ? AND DELETE_RULE = 'CASCADE'`, [target.database]);
    assert.equal(fk.total, 1, 'the foreign key came back with the restore');
  } finally {
    await database.drop();
    await target.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup explains how to fix a missing mysqldump', { skip: skipReason }, async () => {
  const database = await createTestDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-script-backup-'));
  try {
    const result = runScript('backup.js', [], database, { BACKUP_DIR: dir, MYSQLDUMP_PATH: path.join(dir, 'no-such-mysqldump.exe') });
    assert.equal(result.code, 1);
    assert.match(result.out, /mysqldump was not found.*PATH.*MYSQLDUMP_PATH/s);
    assert.deepEqual(fs.readdirSync(dir), [], 'no half-written backup is left behind');
  } finally {
    await database.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
