// One-time import of tasks from the ORIGINAL app's data/tasks.json file into MySQL.
// Run it by hand: `npm run import-legacy`. It never runs when the application starts.
// The JSON file is only read, never changed or deleted.
// Imported tasks get the default category ("General / Cross-module") and no assignee.

const fs = require('node:fs');
const { withTransaction, getMeta, setMeta, claimMeta, toMysqlDateTime } = require('./database');
const { DEFAULTS, LIMITS } = require('./constants');

const META_KEY = 'legacy_import';

async function importLegacyTasks(pool, legacyFile) {
  const earlier = await getMeta(pool, META_KEY);
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
  return withTransaction(pool, async connection => {
    // Claim the job first. If another run got here first this waits for it, then stops.
    if (!(await claimMeta(connection, META_KEY, JSON.stringify({ importedAt: now, imported: 0, skipped: 0, source: legacyFile })))) {
      return { status: 'already-imported', ...JSON.parse(await getMeta(connection, META_KEY)) };
    }

    let imported = 0;
    let skipped = 0;
    for (const [index, old] of oldTasks.entries()) {
      const title = typeof old?.title === 'string' ? old.title.trim().slice(0, LIMITS.title) : '';
      if (!title) { skipped += 1; continue; }
      const createdAt = toMysqlDateTime(Number.isNaN(Date.parse(old.createdAt)) ? now : new Date(old.createdAt).toISOString());
      const status = old.completed === true ? 'Completed' : 'To Do';
      const legacyId = (typeof old.id === 'string' && old.id ? old.id : `position-${index}`).slice(0, 100);
      try {
        // legacy_id is UNIQUE, so the same old task can never be created twice.
        await connection.execute(`
          INSERT INTO tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at, legacy_id)
          VALUES (?, '', ?, ?, ?, ?, NULL, ?, ?, ?)
        `, [title, DEFAULTS.module, DEFAULTS.assignee, DEFAULTS.priority, status, createdAt, createdAt, legacyId]);
        imported += 1;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        skipped += 1;
      }
    }
    const summary = { importedAt: now, imported, skipped, source: legacyFile };
    await setMeta(connection, META_KEY, JSON.stringify(summary));
    return { status: 'imported', ...summary };
  });
}

module.exports = { importLegacyTasks };
