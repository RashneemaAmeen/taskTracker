// Builds a small SQLite database in the OLD format (the one the application used before the
// move to MySQL), for testing the explicit import. It is created in a temporary folder and
// never touches the real data folder.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const OLD_SCHEMA = `
  CREATE TABLE tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    module      TEXT    NOT NULL,
    assignee    TEXT,
    priority    TEXT    NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
    status      TEXT    NOT NULL CHECK (status IN ('To Do', 'In Progress', 'Blocked', 'Completed')),
    due_date    TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    deleted_at  TEXT,
    legacy_id   TEXT    UNIQUE
  );
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author     TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Tasks 1 to 3 remain. Task 4 was created and then permanently deleted, so SQLite's counter
// has reached 4 while the highest remaining task is 3 (a number that must never be reused).
// The connection is returned still OPEN and in WAL mode, so the recent writes are still in the
// -wal file, as they would be if the application had not been shut down cleanly.
function buildOldDatabase(dir) {
  const file = path.join(dir, 'erp-tracker.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(OLD_SCHEMA);

  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at, version, deleted_at, legacy_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertTask.run('start the research work', '', 'General / Cross-module', null, 'Medium', 'To Do', null,
    '2026-11-16T08:44:04.180Z', '2026-11-16T08:44:04.180Z', 1, null, 'aaa-1');
  insertTask.run('Define chart of accounts', 'Waiting for the cost-centre list', 'Finance & Accounts', 'Parimitha', 'High', 'Completed', '2026-11-20',
    '2026-11-10T07:00:00.000Z', '2026-11-12T09:15:30.250Z', 3, null, null);
  insertTask.run('A task in the bin', 'still has its comment', 'CRM', 'Thameem', 'Low', 'In Progress', '2028-02-29',
    '2026-11-11T07:00:00.000Z', '2026-11-15T09:30:00.000Z', 2, '2026-11-15T09:30:00.000Z', null);
  insertTask.run('Deleted for good', '', 'CRM', null, 'Low', 'To Do', null,
    '2026-11-12T07:00:00.000Z', '2026-11-12T07:00:00.000Z', 1, null, null);

  const insertComment = db.prepare('INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)');
  insertComment.run(2, 'Parimitha', 'First note', '2026-11-12T09:00:00.000Z');
  insertComment.run(2, 'Mausooq', '<b>second</b> note with an emoji \u{1F4E6} and Arabic مهمة', '2026-11-12T09:15:30.250Z');
  insertComment.run(3, 'Thameem', 'Comment on the trashed task', '2026-11-14T10:00:00.000Z');
  db.prepare('DELETE FROM tasks WHERE id = 4').run();

  const insertMeta = db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)');
  insertMeta.run('legacy_import', JSON.stringify({ importedAt: '2026-11-16T08:44:00.000Z', imported: 1, skipped: 0, source: 'tasks.json' }));
  insertMeta.run('sample_seeded', '2026-11-16T09:00:00.000Z');
  insertMeta.run('unrelated_key', 'must not be carried over');

  return { file, db };
}

module.exports = { buildOldDatabase, OLD_SCHEMA };
