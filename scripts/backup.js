// `npm run backup` writes a complete, consistent copy of the database into the backups folder.
// It is safe to run while the app is running (SQLite's VACUUM INTO makes a clean snapshot).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');

const config = loadConfig();
if (!fs.existsSync(config.dbFile)) {
  console.error(`No database found at ${config.dbFile}. Start the app once first.`);
  process.exit(1);
}

fs.mkdirSync(config.backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(config.backupDir, `erp-tracker-${stamp}.db`);

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('VACUUM INTO ?').run(target);
db.close();

// Open the copy and check it before reporting success.
const copy = new DatabaseSync(target, { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get();
const tasks = copy.prepare('SELECT COUNT(*) AS total FROM tasks').get().total;
const comments = copy.prepare('SELECT COUNT(*) AS total FROM comments').get().total;
copy.close();

if (check.integrity_check !== 'ok') {
  console.error(`Backup written to ${target} but it failed the integrity check: ${check.integrity_check}`);
  process.exit(1);
}
console.log(`Backup saved: ${target}`);
console.log(`Contains ${tasks} task(s) and ${comments} comment(s). Integrity check: ok.`);
