// One-time import of an OLD SQLite database (the file used before the move to MySQL) into
// MySQL. Run it by hand: `npm run import-sqlite`. It never runs when the application starts.
//
// - The SQLite file is only COPIED (to a temporary folder) and read. The original, and its
//   -wal / -shm companions, are never opened for writing and never deleted.
// - Task ids are kept, so references such as ERP-007 stay exactly the same. Comments,
//   Trash state (deleted_at), versions and timestamps are kept too.
// - Everything is saved in ONE transaction: if anything is wrong, nothing is saved.
// - Duplicate protection: the import refuses to run when it has already been done, or when
//   the MySQL tables already contain tasks or comments.
// - Stop the application first, so the SQLite file is not being written while it is copied.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withTransaction, getMeta, setMeta, claimMeta, toMysqlDateTime } = require('./database');
const { PRIORITIES, STATUSES, DEFAULTS } = require('./constants');
const { isValidDateString } = require('./dates');

const META_KEY = 'sqlite_import';
const CARRIED_MARKERS = ['legacy_import', 'sample_seeded'];   // so those one-time jobs are not repeated

// A problem with the SQLite file or the target that should be shown to the person running it.
class ImportProblem extends Error {}

// Reads every task, comment and marker from the SQLite file into plain JavaScript objects.
function readSqliteFile(sourceFile) {
  if (!fs.existsSync(sourceFile)) throw new ImportProblem(`SQLite file not found: ${sourceFile}`);
  const { DatabaseSync } = require('node:sqlite');          // built into Node.js; used only by this command
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sqlite-import-'));
  try {
    const copy = path.join(tempDir, 'copy.db');
    fs.copyFileSync(sourceFile, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(sourceFile + suffix)) fs.copyFileSync(sourceFile + suffix, copy + suffix);
    }
    let sqlite;
    try {
      sqlite = new DatabaseSync(copy);
    } catch (error) {
      throw new ImportProblem(`${sourceFile} could not be opened as a SQLite database (${error.message}).`);
    }
    try {
      // SQLite only notices that a file is not a database when the first query runs.
      const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!tables.has('tasks') || !tables.has('comments')) {
        throw new ImportProblem(`${sourceFile} is not an ERP Rebuild Task Tracker database (no tasks and comments tables).`);
      }
      const sequence = tables.has('sqlite_sequence')
        ? sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get() : undefined;
      return {
        tasks: sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(),
        comments: sqlite.prepare('SELECT * FROM comments ORDER BY id').all(),
        markers: tables.has('app_meta')
          ? sqlite.prepare('SELECT key, value FROM app_meta').all().filter(row => CARRIED_MARKERS.includes(row.key)) : [],
        highestIdEverUsed: sequence ? Number(sequence.seq) : 0
      };
    } catch (error) {
      if (error instanceof ImportProblem) throw error;
      throw new ImportProblem(`${sourceFile} could not be read as a SQLite database (${error.message}).`);
    } finally {
      sqlite.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// VARCHAR(n) limits count characters (a JavaScript length is never smaller), TEXT limits count bytes.
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const TEXT_BYTES = 65535;
const fitsText = value => typeof value === 'string' && Buffer.byteLength(value) <= TEXT_BYTES;
const isInstant = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));

// Checks every row against the MySQL columns BEFORE anything is written, and converts values.
function prepareRows(source) {
  const problems = [];
  const problem = (label, text) => problems.push(`${label}: ${text}`);
  const taskIds = new Set();

  const tasks = source.tasks.map(row => {
    const label = `task ${row.id}`;
    if (!Number.isInteger(row.id) || row.id < 1) problem(label, 'id is not a positive whole number');
    taskIds.add(row.id);
    if (!isText(row.title, 150)) problem(label, 'title is empty or longer than 150 characters');
    if (!fitsText(row.description)) problem(label, 'description is not text, or is too long');
    if (!isText(row.module, 100)) problem(label, 'module is empty or longer than 100 characters');
    if (row.assignee !== null && !isText(row.assignee, 50)) problem(label, 'assignee is longer than 50 characters');
    if (!PRIORITIES.includes(row.priority)) problem(label, `priority "${row.priority}" is not one of ${PRIORITIES.join(', ')}`);
    if (!STATUSES.includes(row.status)) problem(label, `status "${row.status}" is not one of ${STATUSES.join(', ')}`);
    if (row.due_date !== null && !isValidDateString(row.due_date)) problem(label, `due date "${row.due_date}" is not a real YYYY-MM-DD date`);
    if (!isInstant(row.created_at) || !isInstant(row.updated_at)) problem(label, 'created/updated time is not a valid timestamp');
    if (row.deleted_at !== null && !isInstant(row.deleted_at)) problem(label, 'deleted time is not a valid timestamp');
    if (!Number.isInteger(row.version) || row.version < 1) problem(label, 'version is not a positive whole number');
    if (row.legacy_id !== null && !isText(row.legacy_id, 100)) problem(label, 'legacy id is longer than 100 characters');
    if (problems.length) return null;
    return {
      id: row.id, title: row.title, description: row.description, module: row.module, assignee: row.assignee,
      priority: row.priority, status: row.status, dueDate: row.due_date,
      createdAt: toMysqlDateTime(row.created_at), updatedAt: toMysqlDateTime(row.updated_at),
      version: row.version, deletedAt: row.deleted_at === null ? null : toMysqlDateTime(row.deleted_at),
      legacyId: row.legacy_id
    };
  });

  const comments = source.comments.map(row => {
    const label = `comment ${row.id}`;
    if (!Number.isInteger(row.id) || row.id < 1) problem(label, 'id is not a positive whole number');
    if (!taskIds.has(row.task_id)) problem(label, `belongs to task ${row.task_id}, which is not in the file`);
    if (!isText(row.author, 50)) problem(label, 'author is empty or longer than 50 characters');
    if (!fitsText(row.body) || row.body.length === 0) problem(label, 'text is empty or too long');
    if (!isInstant(row.created_at)) problem(label, 'time is not a valid timestamp');
    if (problems.length) return null;
    return { id: row.id, taskId: row.task_id, author: row.author, body: row.body, createdAt: toMysqlDateTime(row.created_at) };
  });

  if (problems.length) {
    const shown = problems.slice(0, 20).map(text => `  - ${text}`).join('\n');
    const more = problems.length > 20 ? `\n  ...and ${problems.length - 20} more` : '';
    throw new ImportProblem(`The SQLite file has data that does not fit the MySQL tables. Nothing was imported.\n${shown}${more}`);
  }
  return { tasks, comments };
}

async function targetCounts(db) {
  const [[row]] = await db.execute('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM comments) AS comments');
  return { tasks: Number(row.tasks), comments: Number(row.comments) };
}

// Imports sourceFile into MySQL. Returns { status, ... } where status is one of:
//   'imported', 'dry-run', 'already-imported', 'target-not-empty'
// Throws ImportProblem for a bad or unreadable SQLite file.
async function importSqliteFile(pool, sourceFile, { dryRun = false } = {}) {
  const earlier = await getMeta(pool, META_KEY);
  if (earlier) return { status: 'already-imported', ...JSON.parse(earlier) };
  const existing = await targetCounts(pool);
  if (existing.tasks || existing.comments) return { status: 'target-not-empty', ...existing };

  const source = readSqliteFile(sourceFile);
  const { tasks, comments } = prepareRows(source);
  const summary = {
    source: sourceFile,
    tasks: tasks.length,
    inTrash: tasks.filter(task => task.deletedAt !== null).length,
    comments: comments.length,
    highestTaskId: tasks.reduce((highest, task) => Math.max(highest, task.id), 0),
    highestIdEverUsed: source.highestIdEverUsed
  };
  if (dryRun) return { status: 'dry-run', ...summary };

  return withTransaction(pool, async connection => {
    if (!(await claimMeta(connection, META_KEY, JSON.stringify({ importedAt: new Date().toISOString(), ...summary, inProgress: true })))) {
      return { status: 'already-imported', ...JSON.parse(await getMeta(connection, META_KEY)) };
    }
    const recheck = await targetCounts(connection);
    if (recheck.tasks || recheck.comments) return { status: 'target-not-empty', ...recheck };

    for (const task of tasks) {
      await connection.execute(`
        INSERT INTO tasks (id, title, description, module, assignee, priority, status, due_date,
                           created_at, updated_at, version, deleted_at, legacy_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [task.id, task.title, task.description, task.module, task.assignee, task.priority, task.status, task.dueDate,
        task.createdAt, task.updatedAt, task.version, task.deletedAt, task.legacyId]);
    }
    for (const comment of comments) {
      await connection.execute(
        'INSERT INTO comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
        [comment.id, comment.taskId, comment.author, comment.body, comment.createdAt]);
    }

    // SQLite never reused a task number, even after a permanent deletion. Keep that true: if
    // the highest number ever used is above the highest remaining task, move MySQL's counter
    // past it by inserting and removing a placeholder row. (MySQL 8.0 keeps the counter even
    // after the row is deleted, and this needs no ALTER privilege.)
    if (source.highestIdEverUsed > summary.highestTaskId) {
      await connection.execute(`
        INSERT INTO tasks (id, title, description, module, priority, status, created_at, updated_at, version)
        VALUES (?, 'placeholder', '', ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)
      `, [source.highestIdEverUsed, DEFAULTS.module, DEFAULTS.priority, DEFAULTS.status]);
      await connection.execute('DELETE FROM tasks WHERE id = ?', [source.highestIdEverUsed]);
    }

    for (const marker of source.markers) await setMeta(connection, marker.key, marker.value);
    const finished = { importedAt: new Date().toISOString(), ...summary };
    await setMeta(connection, META_KEY, JSON.stringify(finished));
    return { status: 'imported', ...finished };
  });
}

module.exports = { importSqliteFile, readSqliteFile, prepareRows, ImportProblem };
