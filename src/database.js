// MySQL access for the whole application: one connection pool, transactions, value
// conversion and readable error messages. Uses mysql2/promise with parameterised
// ("?") statements only, so user text is never mixed into SQL.
//
// The application account needs only SELECT, INSERT, UPDATE and DELETE. Nothing in this
// project creates, alters or drops tables at runtime: scripts/schema.mysql.sql is applied
// by an administrator.

const mysql = require('mysql2/promise');

// The tables the application needs (created by scripts/schema.mysql.sql).
const REQUIRED_TABLES = ['tasks', 'comments', 'app_meta'];

// Set on every new connection so behaviour does not depend on the server's configuration:
// UTC times, and strict mode so oversized or invalid values are rejected, never truncated.
const SESSION_SETTINGS = "SET SESSION time_zone = '+00:00', "
  + "SESSION sql_mode = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ENGINE_SUBSTITUTION'";

function createPool(dbConfig) {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: 'UTF8MB4_UNICODE_CI',
    waitForConnections: true,
    connectionLimit: dbConfig.connectionLimit ?? 10,
    queueLimit: 0,
    connectTimeout: dbConfig.connectTimeoutMs ?? 10000,
    enableKeepAlive: true,
    multipleStatements: false,        // one statement per call: no statement stacking
    // DATE / DATETIME values are returned as plain strings. Without this the driver builds
    // JavaScript Date objects in the server's local timezone, which can shift a due date
    // by a day.
    dateStrings: true,
    timezone: 'Z',
    decimalNumbers: true              // SUM() returns DECIMAL in MySQL; read it as a number
  });
  pool.pool.on('connection', connection => {
    connection.query(SESSION_SETTINGS, error => {
      if (error) console.error(`Could not apply MySQL session settings: ${summarizeError(error)}`);
    });
  });
  return pool;
}

// Runs the work on ONE connection inside a transaction: everything commits together, or
// (if anything throws) nothing is saved. The work function receives the connection and
// must use it for every statement that belongs to the transaction.
async function withTransaction(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* the connection is already gone */ }
    throw error;
  } finally {
    connection.release();
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The database did not answer in time.'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Quick "is the database answering?" test used by /health.
async function checkDatabase(pool, timeoutMs = 3000) {
  await withTimeout(pool.query('SELECT 1'), timeoutMs);
}

// Startup check: can we log in, and do the tables created by schema.mysql.sql exist?
async function verifyDatabase(pool) {
  await pool.query('SELECT 1');
  for (const table of REQUIRED_TABLES) {
    await pool.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);     // fixed table names, no user input
  }
}

async function closePool(pool) {
  await pool.end();
}

/* ---------- Errors ---------- */

// Short, safe text for log files: error code and MySQL's own message only. It never
// includes connection settings, passwords or the values sent in a query.
function summarizeError(error) {
  const code = error.code || error.name || 'Error';
  const errno = error.errno && typeof error.errno === 'number' && error.errno > 0 ? ` (${error.errno})` : '';
  // Node reports a failed connection to "localhost" (tried on IPv6 and IPv4) as an AggregateError with no message of its own.
  const detail = error.sqlMessage || error.message || (Array.isArray(error.errors) && error.errors[0]?.message) || '';
  return `${code}${errno}: ${detail}`;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'POOL_CLOSED', 'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN', 'ER_ACCESS_DENIED_ERROR'
]);
const BUSY_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

// True when a request failed because the database is down, unreachable or busy,
// as opposed to a bug or bad input.
function isDatabaseUnavailable(error) {
  return Boolean(error) && (UNREACHABLE_CODES.has(error.code) || BUSY_CODES.has(error.code));
}

function unavailableMessage(error) {
  return BUSY_CODES.has(error?.code)
    ? 'The database was busy with another change. Please try again.'
    : 'The database is not reachable right now. Please try again in a moment.';
}

// Turns a startup or script error into an actionable sentence. dbConfig supplies the host,
// port, user and database NAMES for the message; the password is never read here.
function describeDatabaseError(error, dbConfig = {}) {
  const host = dbConfig.host?.includes(':') ? `[${dbConfig.host}]` : dbConfig.host;     // IPv6 addresses go in brackets
  const where = `${host ?? 'the database host'}:${dbConfig.port ?? ''}`.replace(/:$/, '');
  switch (error.code) {
    case 'ECONNREFUSED':
      return `Could not connect to MySQL at ${where}. Check that the MySQL service is running, and that DB_HOST and DB_PORT in .env are correct.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The MySQL host name "${dbConfig.host}" could not be found. Check DB_HOST in .env.`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `MySQL at ${where} did not answer in time. Check DB_HOST and DB_PORT in .env, and that the server is reachable.`;
    case 'ER_ACCESS_DENIED_ERROR':
      return `MySQL refused the login for user "${dbConfig.user}". Check DB_USER and DB_PASSWORD in .env.`
        + (dbConfig.password === '' ? ' DB_PASSWORD is empty.' : '');
    case 'ER_BAD_DB_ERROR':
      return `The database "${dbConfig.database}" does not exist. Check DB_NAME in .env, or ask your MySQL administrator to create it.`;
    case 'ER_DBACCESS_DENIED_ERROR':
      return `User "${dbConfig.user}" is not allowed to use database "${dbConfig.database}". It needs SELECT, INSERT, UPDATE and DELETE on it.`;
    case 'ER_TABLEACCESS_DENIED_ERROR':
      return `User "${dbConfig.user}" lacks a permission it needs on a table (${error.sqlMessage}). It needs SELECT, INSERT, UPDATE and DELETE.`;
    case 'ER_NO_SUCH_TABLE':
      return `A required table is missing (${error.sqlMessage}). Ask an administrator to apply scripts/schema.mysql.sql to the database (see the README).`;
    case 'HANDSHAKE_SSL_ERROR':
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return `MySQL rejected the connection settings (${summarizeError(error)}).`;
    default:
      return summarizeError(error);
  }
}

/* ---------- Value conversion ---------- */

// MySQL DATETIME(3) text ("2026-11-16 12:35:20.945", always UTC) -> ISO 8601 ("...T...Z").
function toIsoUtc(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) throw new Error(`Unexpected date-time value from MySQL: ${value}`);
  return `${match[1]}T${match[2]}.${(match[3] || '').padEnd(3, '0').slice(0, 3)}Z`;
}

// ISO 8601 text -> MySQL DATETIME(3) text in UTC.
function toMysqlDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid date-time: ${iso}`);
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

// MySQL DATE -> "YYYY-MM-DD". The pool returns plain strings, so nothing shifts by timezone.
// The Date branch is a safety net: a JavaScript Date made from a DATE column is local midnight.
function toDateOnly(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const pad = number => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (!match) throw new Error(`Unexpected date value from MySQL: ${value}`);
  return match[1];
}

/* ---------- One-time job markers (app_meta) ---------- */

async function getMeta(db, key) {
  const [rows] = await db.execute('SELECT meta_value FROM app_meta WHERE meta_key = ?', [key]);
  return rows.length ? rows[0].meta_value : null;
}

async function setMeta(db, key, value) {
  await db.execute(
    'INSERT INTO app_meta (meta_key, meta_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE meta_value = ?',
    [key, value, value]);
}

// Records that a one-time job has started. Returns false if some other run already did, so
// two runs at the same moment can never both proceed. Use inside a transaction: the second
// run waits until the first commits, then gets "false".
async function claimMeta(db, key, value) {
  try {
    await db.execute('INSERT INTO app_meta (meta_key, meta_value) VALUES (?, ?)', [key, value]);
    return true;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return false;
    throw error;
  }
}

module.exports = {
  REQUIRED_TABLES,
  createPool, withTransaction, checkDatabase, verifyDatabase, closePool,
  summarizeError, describeDatabaseError, isDatabaseUnavailable, unavailableMessage,
  toIsoUtc, toMysqlDateTime, toDateOnly,
  getMeta, setMeta, claimMeta
};
