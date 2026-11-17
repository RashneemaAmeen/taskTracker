// Tests that need NO database: settings, value conversion, error messages, dates,
// validation and the contents of the schema file. Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, loadDotEnv, projectRoot } = require('../src/config');
const {
  toIsoUtc, toMysqlDateTime, toDateOnly, describeDatabaseError, summarizeError,
  isDatabaseUnavailable, unavailableMessage, REQUIRED_TABLES
} = require('../src/database');
const { todayInDubai, addDays, isValidDateString } = require('../src/dates');
const { validateTask, validateFilters, parseTaskId, HttpError } = require('../src/validation');

/* ---------- Settings ---------- */

test('settings have the documented MySQL defaults', () => {
  const config = loadConfig({});
  assert.equal(config.db.host, 'localhost');
  assert.equal(config.db.port, 3306);
  assert.equal(config.db.database, 'erp_task_tracker');
  assert.equal(config.db.user, 'erp_tracker_app');
  assert.equal(config.db.password, '');
  assert.equal(config.db.connectionLimit, 10);
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
});

test('settings are read from DB_* and application HOST/PORT variables', () => {
  const config = loadConfig({
    HOST: '0.0.0.0', PORT: '8080', DB_HOST: 'db.internal', DB_PORT: '3307', DB_NAME: 'other',
    DB_USER: 'someone', DB_PASSWORD: 'p@ss#word with spaces', DB_CONNECTION_LIMIT: '4'
  });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.deepEqual({ ...config.db }, {
    host: 'db.internal', port: 3307, database: 'other', user: 'someone', connectionLimit: 4, connectTimeoutMs: 10000
  });
  assert.equal(config.db.password, 'p@ss#word with spaces');
});

test('the database password cannot leak through logging or JSON', () => {
  const config = loadConfig({ DB_PASSWORD: 'top-secret-value' });
  assert.ok(!JSON.stringify(config).includes('top-secret-value'));
  assert.ok(!require('node:util').inspect(config, { depth: 5 }).includes('top-secret-value'));
});

test('invalid settings are rejected with a clear message', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be a whole number/);
  assert.throws(() => loadConfig({ DB_PORT: '0' }), /DB_PORT must be a whole number/);
  assert.throws(() => loadConfig({ DB_PORT: '70000' }), /DB_PORT/);
  assert.throws(() => loadConfig({ DB_CONNECTION_LIMIT: '0' }), /DB_CONNECTION_LIMIT/);
});

test('.env loading: values are read, existing variables win, a UTF-8 BOM is tolerated, UTF-16 is explained', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-env-test-'));
  try {
    const file = path.join(dir, '.env');

    fs.writeFileSync(file, "DB_USER=from_file\nDB_NAME=erp_task_tracker\nDB_PASSWORD='pa ss#word'\n");
    let env = { DB_USER: 'from_environment' };
    assert.deepEqual(loadDotEnv(file, env), { loaded: true, file });
    assert.equal(env.DB_USER, 'from_environment', 'a variable that is already set is not overridden');
    assert.equal(env.DB_NAME, 'erp_task_tracker');
    assert.equal(env.DB_PASSWORD, 'pa ss#word', 'single quotes keep # and spaces');

    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('DB_HOST=bom-host\n')]));
    env = {};
    loadDotEnv(file, env);
    assert.equal(env.DB_HOST, 'bom-host', 'the first variable is not damaged by a byte-order mark');

    fs.writeFileSync(file, Buffer.from('﻿DB_HOST=x\n', 'utf16le'));
    assert.throws(() => loadDotEnv(file, {}), /UTF-16.*UTF-8/);

    assert.deepEqual(loadDotEnv(path.join(dir, 'missing.env'), {}), { loaded: false, file: path.join(dir, 'missing.env') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- MySQL value conversion ---------- */

test('MySQL date-times convert to ISO strings and back without timezone shifts', () => {
  assert.equal(toIsoUtc('2026-11-16 12:35:20.945'), '2026-11-16T12:35:20.945Z');
  assert.equal(toIsoUtc('2026-11-16 08:44:04.180'), '2026-11-16T08:44:04.180Z');
  assert.equal(toIsoUtc('2026-11-16 08:44:04'), '2026-11-16T08:44:04.000Z');
  assert.equal(toIsoUtc(null), null);
  assert.equal(toIsoUtc(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01T00:00:00.000Z');
  assert.throws(() => toIsoUtc('not a date'), /Unexpected date-time/);

  assert.equal(toMysqlDateTime('2026-11-16T08:44:04.180Z'), '2026-11-16 08:44:04.180');
  assert.equal(toMysqlDateTime('2026-11-16T08:44:04Z'), '2026-11-16 08:44:04.000');
  assert.equal(toMysqlDateTime('2026-11-16T12:00:00.000+04:00'), '2026-11-16 08:00:00.000', 'offsets are converted to UTC');
  assert.throws(() => toMysqlDateTime('nonsense'), /Not a valid date-time/);

  for (const iso of ['2026-02-28T23:59:59.999Z', '2028-02-29T00:00:00.000Z', '2026-12-31T20:00:00.001Z']) {
    assert.equal(toIsoUtc(toMysqlDateTime(iso)), iso, 'round trip');
  }
});

test('MySQL DATE values stay plain calendar days', () => {
  assert.equal(toDateOnly('2026-12-31'), '2026-12-31');
  assert.equal(toDateOnly('2026-01-01'), '2026-01-01');
  assert.equal(toDateOnly('2028-02-29'), '2028-02-29');
  assert.equal(toDateOnly(null), null);
  // If a driver ever hands over a Date, it is local midnight; the local fields are the calendar day.
  assert.equal(toDateOnly(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(toDateOnly(new Date(2026, 11, 31)), '2026-12-31');
  assert.throws(() => toDateOnly('garbage'), /Unexpected date value/);
});

/* ---------- Errors ---------- */

test('database error messages are actionable and never contain the password', () => {
  const secret = 'S3cret-Passw0rd!';
  const db = { host: 'localhost', port: 3306, user: 'erp_tracker_app', database: 'erp_task_tracker', password: secret };
  const cases = [
    [{ code: 'ECONNREFUSED' }, /Could not connect to MySQL at localhost:3306.*service is running/],
    [{ code: 'ENOTFOUND' }, /host name "localhost" could not be found/],
    [{ code: 'ETIMEDOUT' }, /did not answer in time/],
    [{ code: 'ER_ACCESS_DENIED_ERROR', sqlMessage: `Access denied for user 'erp_tracker_app'@'localhost'` }, /refused the login for user "erp_tracker_app".*DB_PASSWORD/],
    [{ code: 'ER_BAD_DB_ERROR' }, /database "erp_task_tracker" does not exist/],
    [{ code: 'ER_DBACCESS_DENIED_ERROR' }, /not allowed to use database "erp_task_tracker".*SELECT, INSERT, UPDATE and DELETE/],
    [{ code: 'ER_NO_SUCH_TABLE', sqlMessage: "Table 'erp_task_tracker.tasks' doesn't exist" }, /table is missing.*schema\.mysql\.sql/],
    [{ code: 'ER_TABLEACCESS_DENIED_ERROR', sqlMessage: 'SELECT command denied' }, /lacks a permission/]
  ];
  for (const [error, pattern] of cases) {
    const text = describeDatabaseError(Object.assign(new Error('x'), error), db);
    assert.match(text, pattern);
    assert.ok(!text.includes(secret), `message for ${error.code} must not contain the password`);
  }
  assert.match(describeDatabaseError(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' }), { ...db, password: '' }), /DB_PASSWORD is empty/);
  assert.match(describeDatabaseError(Object.assign(new Error('boom'), { code: 'SOMETHING_ELSE', errno: 9 }), db), /SOMETHING_ELSE \(9\): boom/);

  const summary = summarizeError(Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR', errno: 1040, sql: 'SELECT secret_column', password: secret }));
  assert.equal(summary, 'ER_CON_COUNT_ERROR (1040): Too many connections');
});

test('runtime errors are classified as "database unavailable" only when they should be', () => {
  for (const code of ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ER_CON_COUNT_ERROR', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'POOL_CLOSED']) {
    assert.equal(isDatabaseUnavailable({ code }), true, code);
  }
  for (const code of ['ER_DUP_ENTRY', 'ER_PARSE_ERROR', 'ER_DATA_TOO_LONG', undefined]) {
    assert.equal(isDatabaseUnavailable({ code }), false, String(code));
  }
  assert.match(unavailableMessage({ code: 'ECONNREFUSED' }), /not reachable/);
  assert.match(unavailableMessage({ code: 'ER_LOCK_DEADLOCK' }), /busy/);
});

/* ---------- Dates and validation ---------- */

test('Dubai date helpers', () => {
  assert.equal(todayInDubai(new Date('2026-11-16T19:59:59Z')), '2026-11-16');
  assert.equal(todayInDubai(new Date('2026-11-16T20:00:00Z')), '2026-11-17', 'Dubai is UTC+4: 20:00 UTC is already tomorrow');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(isValidDateString('2028-02-29'), true);
  assert.equal(isValidDateString('2026-02-29'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('1999-12-31'), false);
});

test('task input is trimmed and validated before it ever reaches the database', () => {
  const task = validateTask({ title: '  Hello  ', dueDate: '2026-12-31' });
  assert.equal(task.title, 'Hello');
  assert.equal(task.dueDate, '2026-12-31');
  assert.equal(task.assignee, null);
  assert.equal(task.module, 'General / Cross-module');
  for (const body of [{}, { title: 'x'.repeat(151) }, { title: 'ok', status: 'Done' }, { title: 'ok', dueDate: '2026-02-30' }, { title: 'ok', assignee: 'Nobody' }]) {
    assert.throws(() => validateTask(body), error => error instanceof HttpError && error.status === 400);
  }
  assert.equal(parseTaskId('ERP-012'), 12);
  assert.equal(parseTaskId('7'), 7);
  assert.throws(() => parseTaskId('0'), HttpError);
  assert.throws(() => validateFilters({ status: 'Done' }), HttpError);
  assert.deepEqual(validateFilters({ q: ' invoice ', overdue: 'true' }), { q: 'invoice', overdue: true });
});

/* ---------- The schema file ---------- */

test('schema.mysql.sql describes every table, column, index and foreign key the application uses', () => {
  const sql = fs.readFileSync(path.join(projectRoot, 'scripts', 'schema.mysql.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');             // statements only, without comments

  for (const table of REQUIRED_TABLES) assert.match(code, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  for (const column of ['id', 'title', 'description', 'module', 'assignee', 'priority', 'status', 'due_date',
    'created_at', 'updated_at', 'version', 'deleted_at', 'legacy_id']) {
    assert.match(code, new RegExp(`\\n  ${column}\\s+`), `tasks.${column}`);
  }
  for (const column of ['task_id', 'author', 'body', 'meta_key', 'meta_value']) assert.match(code, new RegExp(`\\n  ${column}\\s+`), column);

  assert.match(code, /priority\s+ENUM\('Low', 'Medium', 'High'\) NOT NULL/);
  assert.match(code, /status\s+ENUM\('To Do', 'In Progress', 'Blocked', 'Completed'\) NOT NULL/);
  assert.match(code, /due_date\s+DATE NULL/, 'due dates are date-only');
  assert.match(code, /created_at\s+DATETIME\(3\) NOT NULL/);
  assert.match(code, /UNIQUE KEY uq_tasks_legacy_id \(legacy_id\)/);
  assert.match(code, /KEY idx_tasks_deleted_status \(deleted_at, status\)/);
  assert.match(code, /KEY idx_comments_task \(task_id, id\)/);
  assert.match(code, /FOREIGN KEY \(task_id\) REFERENCES tasks \(id\) ON DELETE CASCADE/);
  assert.equal((code.match(/ENGINE=InnoDB/g) || []).length, 3, 'every table is InnoDB');
  assert.equal((code.match(/COLLATE=utf8mb4_unicode_ci/g) || []).length, 3);
});

test('schema.mysql.sql is safe to apply: no destructive statements, no credentials, plain ASCII', () => {
  const raw = fs.readFileSync(path.join(projectRoot, 'scripts', 'schema.mysql.sql'));
  const sql = raw.toString('utf8');
  const code = sql.replace(/--.*$/gm, '');
  // Every statement is either "SET NAMES" or "CREATE TABLE IF NOT EXISTS": nothing else can run.
  const statements = code.split(';').map(statement => statement.trim()).filter(Boolean);
  assert.equal(statements.length, 4);
  for (const statement of statements) {
    assert.match(statement, /^(SET NAMES utf8mb4|CREATE TABLE IF NOT EXISTS (tasks|comments|app_meta) \()/);
  }
  for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bALTER\b/i, /CREATE\s+DATABASE/i, /\bUSE\s+\w/i, /\bGRANT\b/i, /CREATE\s+USER/i, /IDENTIFIED/i]) {
    assert.doesNotMatch(code, forbidden);
  }
  assert.ok(raw.every(byte => byte < 128), 'ASCII only');
  assert.doesNotMatch(code, /password/i, 'no credentials in the statements');
});

test('the project contains no hardcoded MySQL credentials and .env is ignored by Git', () => {
  const ignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('.env'));
  assert.ok(ignore.includes('.env.*') && ignore.includes('!.env.example'));
  assert.ok(ignore.includes('backups/'));
  const example = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  assert.match(example, /^DB_HOST=localhost$/m);
  assert.match(example, /^DB_PORT=3306$/m);
  assert.match(example, /^DB_NAME=erp_task_tracker$/m);
  assert.match(example, /^DB_USER=erp_tracker_app$/m);
  assert.match(example, /^DB_PASSWORD=$/m, 'the example password is empty');
  assert.match(example, /^PORT=3000$/m);
  assert.match(example, /^HOST=127\.0\.0\.1$/m);

  const files = ['server.js', 'ecosystem.config.cjs', ...fs.readdirSync(path.join(projectRoot, 'src')).map(f => `src/${f}`),
    ...fs.readdirSync(path.join(projectRoot, 'scripts')).map(f => `scripts/${f}`)];
  for (const file of files) {
    const text = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    assert.doesNotMatch(text, /password\s*[:=]\s*['"][^'"]+['"]/i, `${file} must not contain a literal password`);
    assert.doesNotMatch(text, /mysql:\/\/[^\s]*:[^\s]*@/i, `${file} must not contain a connection URL with a password`);
  }
});

test('no code path writes to the database at start-up and nothing needs CREATE, ALTER or DROP', () => {
  const runtimeFiles = ['server.js', ...fs.readdirSync(path.join(projectRoot, 'src')).map(f => `src/${f}`)];
  for (const file of runtimeFiles) {
    const text = fs.readFileSync(path.join(projectRoot, file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|DATABASE|INDEX|USER)\b/i, `${file} must not run DDL`);
  }
  const server = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(server, /importLegacyTasks|importSqliteFile|legacyImport|sqliteImport|seed/i, 'server.js never imports or seeds');
});
