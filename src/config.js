// Reads settings from environment variables, with safe defaults for a laptop.
// See .env.example for the full list.

const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function loadConfig(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535 (received "${env.PORT}").`);
  }

  const dataDir = path.resolve(projectRoot, env.DATA_DIR || 'data');
  const dbFile = env.DB_FILE ? path.resolve(projectRoot, env.DB_FILE) : path.join(dataDir, 'erp-tracker.db');

  // Extra site addresses allowed to send changes, e.g. "http://erp-tasks.company.local".
  // Only needed behind a reverse proxy that does not forward the original host name.
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => item.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir,
    dbFile,
    legacyFile: path.join(dataDir, 'tasks.json'),
    backupDir: path.resolve(projectRoot, env.BACKUP_DIR || 'backups'),
    allowedOrigins
  };
}

module.exports = { loadConfig, projectRoot };
