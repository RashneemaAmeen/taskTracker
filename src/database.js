// Opens the SQLite database file and creates the tables if they do not exist yet.
// Uses Node.js's built-in SQLite module, so there is nothing extra to install or compile.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- shown to users as ERP-001, ERP-002, ...
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    module      TEXT    NOT NULL,
    assignee    TEXT,                                -- NULL means unassigned
    priority    TEXT    NOT NULL CHECK (priority IN ('Low', 'Medium', 'High')),
    status      TEXT    NOT NULL CHECK (status IN ('To Do', 'In Progress', 'Blocked', 'Completed')),
    due_date    TEXT,                                -- "YYYY-MM-DD" or NULL
    created_at  TEXT    NOT NULL,                    -- ISO timestamp (UTC)
    updated_at  TEXT    NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,          -- increases on every change (conflict check)
    deleted_at  TEXT,                                -- set while the task is in Trash
    legacy_id   TEXT    UNIQUE                       -- id from the old tasks.json, if imported
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author     TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );

  -- Small key/value table for one-time jobs (old-data import, sample data).
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_deleted_status ON tasks (deleted_at, status);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id, id);
`;

function openDatabase(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');    // safer writes; readers are not blocked by a writer
  db.exec('PRAGMA foreign_keys = ON');     // deleting a task also deletes its comments
  db.exec('PRAGMA busy_timeout = 5000');   // wait briefly if another process is writing
  db.exec(SCHEMA);
  return db;
}

// Runs several statements as one all-or-nothing unit.
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

module.exports = { openDatabase, transaction, getMeta, setMeta };
