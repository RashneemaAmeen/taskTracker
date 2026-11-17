// Reads settings from environment variables (and the .env file), with safe defaults.
// See .env.example for the full list. Passwords are never printed or hardcoded.

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const projectRoot = path.resolve(__dirname, '..');

// Loads KEY=value lines from a .env file into process.env.
// - A missing file is fine (settings may come from real environment variables instead).
// - Variables that are already set win over the file, so PM2 or Windows settings override it.
// - A UTF-8 byte-order mark (added by some editors) is ignored; UTF-16 files are rejected
//   with a clear message, because PowerShell's ">" redirection creates those.
function loadDotEnv(file = path.join(projectRoot, '.env'), env = process.env) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, file };
    throw error;
  }
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) {
    throw new Error(`${file} is saved as UTF-16. Re-save it as UTF-8 (Notepad: File > Save As > Encoding: UTF-8).`);
  }
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
  return { loaded: true, file };
}

function integerSetting(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (received "${raw}").`);
  }
  return value;
}

function textSetting(env, name, fallback) {
  const value = (env[name] ?? '').trim();
  return value === '' ? fallback : value;
}

function loadConfig(env = process.env) {
  const port = integerSetting(env, 'PORT', 3000, 0, 65535);

  // Folder for old files that are only read by the explicit import commands.
  const dataDir = path.resolve(projectRoot, env.DATA_DIR || 'data');

  // Extra site addresses allowed to send changes, e.g. "http://erp-tasks.company.local".
  // Only needed behind a reverse proxy that does not forward the original host name.
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => item.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);

  const db = {
    host: textSetting(env, 'DB_HOST', 'localhost'),
    port: integerSetting(env, 'DB_PORT', 3306, 1, 65535),
    database: textSetting(env, 'DB_NAME', 'erp_task_tracker'),
    user: textSetting(env, 'DB_USER', 'erp_tracker_app'),
    connectionLimit: integerSetting(env, 'DB_CONNECTION_LIMIT', 10, 1, 100),
    connectTimeoutMs: 10000
  };
  // Not enumerable: the password cannot leak through console.log(config) or JSON.stringify.
  Object.defineProperty(db, 'password', { value: env.DB_PASSWORD ?? '', enumerable: false });

  return {
    port,
    host: env.HOST || '127.0.0.1',
    db,
    dataDir,
    legacyFile: path.join(dataDir, 'tasks.json'),
    sqliteFile: env.SQLITE_FILE ? path.resolve(projectRoot, env.SQLITE_FILE) : path.join(dataDir, 'erp-tracker.db'),
    backupDir: path.resolve(projectRoot, env.BACKUP_DIR || 'backups'),
    mysqldumpPath: textSetting(env, 'MYSQLDUMP_PATH', 'mysqldump'),
    allowedOrigins
  };
}

module.exports = { loadConfig, loadDotEnv, projectRoot };
