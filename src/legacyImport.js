// One-time import of tasks from the original app's data/tasks.json into SQLite.
// The JSON file is only read, never changed or deleted.
// Imported tasks get the default category ("General / Cross-module") and no assignee.

const fs = require('node:fs');
const { transaction, getMeta, setMeta } = require('./database');
const { DEFAULTS, LIMITS } = require('./constants');

const META_KEY = 'legacy_import';

function importLegacyTasks(db, legacyFile) {
  const earlier = getMeta(db, META_KEY);
  if (earlier) return { status: 'already-imported', ...JSON.parse(earlier) };
  if (!fs.existsSync(legacyFile)) return { status: 'no-file' };

  let oldTasks;
  try {
    oldTasks = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    if (!Array.isArray(oldTasks)) throw new Error('the file does not contain a list');
  } catch (error) {
    // Do not record the import as done: it can be retried after the file is repaired.
    return { status: 'unreadable', message: error.message };
  }

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (title, description, module, assignee, priority, status, due_date, created_at, updated_at, legacy_id)
    VALUES (?, '', ?, ?, ?, ?, NULL, ?, ?, ?)
  `);

  return transaction(db, () => {
    let imported = 0;
    let skipped = 0;
    oldTasks.forEach((old, index) => {
      const title = typeof old?.title === 'string' ? old.title.trim().slice(0, LIMITS.title) : '';
      if (!title) { skipped += 1; return; }
      const createdAt = Number.isNaN(Date.parse(old.createdAt)) ? now : new Date(old.createdAt).toISOString();
      const status = old.completed === true ? 'Completed' : 'To Do';
      const legacyId = typeof old.id === 'string' && old.id ? old.id : `position-${index}`;
      // legacy_id is UNIQUE, so "INSERT OR IGNORE" can never create the same old task twice.
      const result = insert.run(title, DEFAULTS.module, DEFAULTS.assignee, DEFAULTS.priority, status, createdAt, createdAt, legacyId);
      if (result.changes === 1) imported += 1; else skipped += 1;
    });
    const summary = { importedAt: now, imported, skipped, source: legacyFile };
    setMeta(db, META_KEY, JSON.stringify(summary));
    return { status: 'imported', ...summary };
  });
}

module.exports = { importLegacyTasks };
