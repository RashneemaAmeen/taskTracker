// Every database query for tasks and comments lives here. All functions are asynchronous.
//
// - Values are always passed as "?" parameters (server-side prepared statements via
//   execute()), never glued into the SQL text.
// - The first argument "db" is either the connection pool or one connection that is inside
//   a transaction; both offer the same execute() method.
// - Changes use single atomic statements with a condition (for example
//   "WHERE id = ? AND version = ?") and then check how many rows were affected, so two
//   people saving at the same moment can never overwrite each other silently.
// - Timestamps are written with UTC_TIMESTAMP(3), the database's own clock, so every
//   created/updated/deleted time comes from one place.

const { withTransaction, toIsoUtc, toDateOnly } = require('./database');
const { TEAM, MODULES, UNASSIGNED } = require('./constants');
const { todayInDubai } = require('./dates');

// All columns the browser needs. (The reference "ERP-007" is built in JavaScript from the id.)
const SELECT_TASK = `
  SELECT t.id, t.title, t.description, t.module, t.assignee, t.priority, t.status,
         t.due_date, t.created_at, t.updated_at, t.version, t.deleted_at,
         (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t`;

// The same reference built in SQL, used only for searching. Like "ERP-%03d": three digits,
// and longer numbers (ERP-1000) are not cut short.
const REFERENCE_SQL = "CONCAT('ERP-', IF(t.id < 1000, LPAD(t.id, 3, '0'), CAST(t.id AS CHAR)))";

// Overdue = has a due date before today (Dubai) and is not completed. Takes one "?" (today).
const OVERDUE_SQL = "(t.due_date IS NOT NULL AND t.due_date < CAST(? AS DATE) AND t.status <> 'Completed')";

// Field names accepted from the API, mapped to their database columns (a fixed whitelist).
const EDITABLE_COLUMNS = {
  title: 'title', description: 'description', module: 'module', assignee: 'assignee',
  priority: 'priority', status: 'status', dueDate: 'due_date'
};

const referenceFor = id => `ERP-${String(id).padStart(3, '0')}`;

// Counts come back as numbers (or numeric text for SUM); make them plain numbers.
const count = value => Number(value ?? 0);

// Converts a database row into the JSON shape sent to the browser.
function toTask(row, today) {
  const dueDate = toDateOnly(row.due_date);
  const deletedAt = toIsoUtc(row.deleted_at);
  return {
    id: row.id,
    reference: referenceFor(row.id),
    title: row.title,
    description: row.description,
    module: row.module,
    moduleIsOlderName: !MODULES.includes(row.module),   // saved under a name no longer in the list
    assignee: row.assignee,
    priority: row.priority,
    status: row.status,
    dueDate,
    isOverdue: !deletedAt && Boolean(dueDate) && dueDate < today && row.status !== 'Completed',
    commentCount: count(row.comment_count),
    createdAt: toIsoUtc(row.created_at),
    updatedAt: toIsoUtc(row.updated_at),
    version: row.version,
    deletedAt
  };
}

// Builds the WHERE part for the active (not trashed) task list from validated filters.
function buildWhere(filters, today) {
  const clauses = ['t.deleted_at IS NULL'];
  const params = [];
  if (filters.q) {
    // "!" is the LIKE escape character here, so % _ and ! typed by a person are searched literally.
    const like = `%${filters.q.replace(/[!%_]/g, character => `!${character}`)}%`;
    clauses.push(`(${REFERENCE_SQL} LIKE ? ESCAPE '!' OR t.title LIKE ? ESCAPE '!' OR t.description LIKE ? ESCAPE '!')`);
    params.push(like, like, like);
  }
  if (filters.assignee === UNASSIGNED) clauses.push('t.assignee IS NULL');
  else if (filters.assignee) { clauses.push('t.assignee = ?'); params.push(filters.assignee); }
  if (filters.module) { clauses.push('t.module = ?'); params.push(filters.module); }
  if (filters.priority) { clauses.push('t.priority = ?'); params.push(filters.priority); }
  if (filters.status) { clauses.push('t.status = ?'); params.push(filters.status); }
  if (filters.overdue) { clauses.push(OVERDUE_SQL); params.push(today); }
  return { where: clauses.join(' AND '), params };
}

async function rows(db, sql, params = []) {
  const [result] = await db.execute(sql, params);
  return result;
}

// Module names used by existing tasks (including Trash) that are not in the current list.
async function listOlderModules(db) {
  const found = await rows(db, 'SELECT DISTINCT module FROM tasks ORDER BY module');
  return found.map(row => row.module).filter(name => !MODULES.includes(name));
}

async function listTasks(db, filters = {}) {
  const today = todayInDubai();
  const { where, params } = buildWhere(filters, today);
  const found = await rows(db, `
    ${SELECT_TASK}
    WHERE ${where}
    ORDER BY (t.status = 'Completed'), (t.due_date IS NULL), t.due_date,
             CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, t.id
  `, params);
  return found.map(row => toTask(row, today));
}

async function getDashboard(db, filters = {}) {
  const today = todayInDubai();
  const { where, params } = buildWhere(filters, today);
  const [totals] = await rows(db, `
    SELECT COUNT(*) AS active,
           COALESCE(SUM(t.status = 'In Progress'), 0) AS in_progress,
           COALESCE(SUM(t.status = 'Completed'), 0) AS completed,
           COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue
    FROM tasks t WHERE ${where}
  `, [today, ...params]);

  // Workload always covers every task outside Trash, whatever filters are applied.
  const workloadRows = await rows(db, `
    SELECT assignee,
           COALESCE(SUM(status <> 'Completed'), 0) AS pending,
           COALESCE(SUM(status = 'Completed'), 0) AS completed
    FROM tasks WHERE deleted_at IS NULL GROUP BY assignee
  `);
  const countsFor = name => {
    const row = workloadRows.find(item => item.assignee === name);
    return { pending: row ? count(row.pending) : 0, completed: row ? count(row.completed) : 0 };
  };

  // Module summary: like workload, it always covers every task outside Trash.
  const moduleRows = await rows(db, `
    SELECT module,
           COALESCE(SUM(status <> 'Completed'), 0) AS pending,
           COALESCE(SUM(status = 'Completed'), 0) AS completed
    FROM tasks WHERE deleted_at IS NULL GROUP BY module
  `);
  const olderInUse = moduleRows.map(row => row.module).filter(name => !MODULES.includes(name)).sort();
  const moduleSummary = [...MODULES, ...olderInUse].map(name => {
    const row = moduleRows.find(item => item.module === name);
    return { name, pending: row ? count(row.pending) : 0, completed: row ? count(row.completed) : 0, olderName: !MODULES.includes(name) };
  });

  return {
    scope: Object.keys(filters).length ? 'filtered' : 'all',
    today,
    summary: {
      active: count(totals.active),
      inProgress: count(totals.in_progress),
      completed: count(totals.completed),
      overdue: count(totals.overdue)
    },
    workloadScope: 'all',
    workload: TEAM.map(name => ({ name, ...countsFor(name) })),
    unassigned: countsFor(null),
    moduleScope: 'all',
    modules: moduleSummary
  };
}

// Returns one task (trashed or not), or null when it does not exist.
async function getTask(db, id) {
  const [row] = await rows(db, `${SELECT_TASK} WHERE t.id = ?`, [id]);
  return row ? toTask(row, todayInDubai()) : null;
}

async function createTask(db, task) {
  const [result] = await db.execute(`
    INSERT INTO tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
  `, [task.title, task.description, task.module, task.assignee ?? null, task.priority, task.status, task.dueDate ?? null]);
  return getTask(db, result.insertId);
}

// Saves changes only if nobody else changed the task since `version` was loaded.
// Returns { outcome: 'updated' | 'not-found' | 'in-trash' | 'conflict', task }.
//
// The UPDATE itself checks the version and "not in Trash" in one atomic statement. If it
// matched no row, we look the task up again to say why. Update and lookup share one
// transaction so the task returned is exactly the state our change produced.
async function updateTask(pool, id, changes, version) {
  const keys = Object.keys(changes).filter(key => EDITABLE_COLUMNS[key]);
  const assignments = keys.map(key => `${EDITABLE_COLUMNS[key]} = ?`);
  const values = keys.map(key => changes[key] ?? null);
  const sql = `UPDATE tasks SET ${[...assignments, 'updated_at = UTC_TIMESTAMP(3)', 'version = version + 1'].join(', ')}
               WHERE id = ? AND version = ? AND deleted_at IS NULL`;

  return withTransaction(pool, async connection => {
    const [result] = await connection.execute(sql, [...values, id, version]);
    const task = await getTask(connection, id);
    if (result.affectedRows === 1) return { outcome: 'updated', task };
    if (!task) return { outcome: 'not-found' };
    if (task.deletedAt) return { outcome: 'in-trash', task };
    return { outcome: 'conflict', task };
  });
}

// Soft delete: the task stays in the database with a deletion timestamp.
async function moveToTrash(pool, id) {
  return withTransaction(pool, async connection => {
    const [result] = await connection.execute(
      'UPDATE tasks SET deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3), version = version + 1 WHERE id = ? AND deleted_at IS NULL',
      [id]);
    const task = await getTask(connection, id);
    if (result.affectedRows === 1) return { outcome: 'trashed', task };
    if (!task) return { outcome: 'not-found' };
    return { outcome: 'in-trash', task };
  });
}

async function listTrash(db) {
  const today = todayInDubai();
  const found = await rows(db, `${SELECT_TASK} WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC, t.id DESC`);
  return found.map(row => toTask(row, today));
}

async function restoreTask(pool, id) {
  return withTransaction(pool, async connection => {
    const [result] = await connection.execute(
      'UPDATE tasks SET deleted_at = NULL, updated_at = UTC_TIMESTAMP(3), version = version + 1 WHERE id = ? AND deleted_at IS NOT NULL',
      [id]);
    const task = await getTask(connection, id);
    if (result.affectedRows === 1) return { outcome: 'restored', task };
    if (!task) return { outcome: 'not-found' };
    return { outcome: 'not-in-trash', task };
  });
}

// Permanent deletion is only possible for tasks already in Trash. The database removes the
// task's comments with it (ON DELETE CASCADE), in the same statement.
async function deletePermanently(pool, id) {
  const [result] = await pool.execute('DELETE FROM tasks WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (result.affectedRows === 1) return { outcome: 'deleted' };
  const task = await getTask(pool, id);
  if (!task) return { outcome: 'not-found' };
  return { outcome: 'not-in-trash', task };
}

async function listComments(db, taskId) {
  const found = await rows(db,
    'SELECT id, task_id, author, body, created_at FROM comments WHERE task_id = ? ORDER BY created_at, id', [taskId]);
  return found.map(toComment);
}

const toComment = row => ({
  id: row.id, taskId: row.task_id, author: row.author, body: row.body, createdAt: toIsoUtc(row.created_at)
});

// Adds a comment unless the task is missing or in Trash. The check and the insert are one
// statement, so a task trashed a moment earlier cannot receive a comment.
// Returns { outcome: 'added' | 'not-found' | 'in-trash', comment | task }.
async function addComment(db, taskId, comment) {
  const [result] = await db.execute(`
    INSERT INTO comments (task_id, author, body, created_at)
    SELECT t.id, ?, ?, UTC_TIMESTAMP(3) FROM tasks t WHERE t.id = ? AND t.deleted_at IS NULL
  `, [comment.author, comment.body, taskId]);
  if (result.affectedRows === 1) {
    const [row] = await rows(db, 'SELECT id, task_id, author, body, created_at FROM comments WHERE id = ?', [result.insertId]);
    return { outcome: 'added', comment: toComment(row) };
  }
  const task = await getTask(db, taskId);
  if (!task) return { outcome: 'not-found' };
  return { outcome: 'in-trash', task };
}

module.exports = {
  listOlderModules, listTasks, getDashboard, getTask, createTask, updateTask,
  moveToTrash, listTrash, restoreTask, deletePermanently,
  listComments, addComment
};
