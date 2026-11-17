// Every database query for tasks and comments lives here.
// All values are passed as "?" parameters, never glued into the SQL text.

const { transaction } = require('./database');
const { TEAM, MODULES, UNASSIGNED } = require('./constants');
const { todayInDubai } = require('./dates');

const SELECT_TASK = `
  SELECT t.id, printf('ERP-%03d', t.id) AS reference, t.title, t.description, t.module, t.assignee,
         t.priority, t.status, t.due_date, t.created_at, t.updated_at, t.version, t.deleted_at,
         (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t`;

// Overdue = has a due date before today (Dubai) and is not completed. Takes one "?" (today).
const OVERDUE_SQL = "(t.due_date IS NOT NULL AND t.due_date < ? AND t.status <> 'Completed')";

// Field names accepted from the API, mapped to their database columns.
const EDITABLE_COLUMNS = {
  title: 'title', description: 'description', module: 'module', assignee: 'assignee',
  priority: 'priority', status: 'status', dueDate: 'due_date'
};

// Converts a database row into the JSON shape sent to the browser.
function toTask(row, today) {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    description: row.description,
    module: row.module,
    moduleIsOlderName: !MODULES.includes(row.module),   // saved under a name no longer in the list
    assignee: row.assignee,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    isOverdue: !row.deleted_at && Boolean(row.due_date) && row.due_date < today && row.status !== 'Completed',
    commentCount: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at
  };
}

// Builds the WHERE part for the active (not trashed) task list from validated filters.
function buildWhere(filters, today) {
  const clauses = ['t.deleted_at IS NULL'];
  const params = [];
  if (filters.q) {
    // Escape % and _ so they are searched for literally.
    const like = `%${filters.q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
    clauses.push(`(printf('ERP-%03d', t.id) LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`);
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

// Module names used by existing tasks (including Trash) that are not in the current list.
function listOlderModules(db) {
  return db.prepare('SELECT DISTINCT module FROM tasks ORDER BY module').all()
    .map(row => row.module)
    .filter(name => !MODULES.includes(name));
}

function listTasks(db, filters = {}) {
  const today = todayInDubai();
  const { where, params } = buildWhere(filters, today);
  const rows = db.prepare(`
    ${SELECT_TASK}
    WHERE ${where}
    ORDER BY (t.status = 'Completed'), (t.due_date IS NULL), t.due_date,
             CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, t.id
  `).all(...params);
  return rows.map(row => toTask(row, today));
}

function getDashboard(db, filters = {}) {
  const today = todayInDubai();
  const { where, params } = buildWhere(filters, today);
  const totals = db.prepare(`
    SELECT COUNT(*) AS active,
           COALESCE(SUM(t.status = 'In Progress'), 0) AS in_progress,
           COALESCE(SUM(t.status = 'Completed'), 0) AS completed,
           COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue
    FROM tasks t WHERE ${where}
  `).get(today, ...params);

  // Workload always covers every task outside Trash, whatever filters are applied.
  const rows = db.prepare(`
    SELECT assignee,
           SUM(status <> 'Completed') AS pending,
           SUM(status = 'Completed') AS completed
    FROM tasks WHERE deleted_at IS NULL GROUP BY assignee
  `).all();
  const countsFor = name => {
    const row = rows.find(item => item.assignee === name);
    return { pending: row ? row.pending : 0, completed: row ? row.completed : 0 };
  };

  // Module summary: like workload, it always covers every task outside Trash.
  const moduleRows = db.prepare(`
    SELECT module,
           SUM(status <> 'Completed') AS pending,
           SUM(status = 'Completed') AS completed
    FROM tasks WHERE deleted_at IS NULL GROUP BY module
  `).all();
  const olderInUse = moduleRows.map(row => row.module).filter(name => !MODULES.includes(name)).sort();
  const moduleSummary = [...MODULES, ...olderInUse].map(name => {
    const row = moduleRows.find(item => item.module === name);
    return { name, pending: row ? row.pending : 0, completed: row ? row.completed : 0, olderName: !MODULES.includes(name) };
  });

  return {
    scope: Object.keys(filters).length ? 'filtered' : 'all',
    today,
    summary: {
      active: totals.active,
      inProgress: totals.in_progress,
      completed: totals.completed,
      overdue: totals.overdue
    },
    workloadScope: 'all',
    workload: TEAM.map(name => ({ name, ...countsFor(name) })),
    unassigned: countsFor(null),
    moduleScope: 'all',
    modules: moduleSummary
  };
}

// Returns one task (trashed or not), or null when it does not exist.
function getTask(db, id) {
  const row = db.prepare(`${SELECT_TASK} WHERE t.id = ?`).get(id);
  return row ? toTask(row, todayInDubai()) : null;
}

function createTask(db, task) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO tasks (title, description, module, assignee, priority, status, due_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.title, task.description, task.module, task.assignee, task.priority, task.status, task.dueDate, now, now);
  return getTask(db, Number(result.lastInsertRowid));
}

// Saves changes only if nobody else changed the task since `version` was loaded.
// Returns { outcome: 'updated' | 'not-found' | 'in-trash' | 'conflict', task }.
function updateTask(db, id, changes, version) {
  return transaction(db, () => {
    const current = getTask(db, id);
    if (!current) return { outcome: 'not-found' };
    if (current.deletedAt) return { outcome: 'in-trash', task: current };
    if (current.version !== version) return { outcome: 'conflict', task: current };

    const keys = Object.keys(changes).filter(key => EDITABLE_COLUMNS[key]);
    const assignments = keys.map(key => `${EDITABLE_COLUMNS[key]} = ?`);
    const values = keys.map(key => changes[key]);
    db.prepare(`UPDATE tasks SET ${[...assignments, 'updated_at = ?', 'version = version + 1'].join(', ')} WHERE id = ? AND version = ?`)
      .run(...values, new Date().toISOString(), id, version);
    return { outcome: 'updated', task: getTask(db, id) };
  });
}

// Soft delete: the task stays in the database with a deletion timestamp.
function moveToTrash(db, id) {
  return transaction(db, () => {
    const current = getTask(db, id);
    if (!current) return { outcome: 'not-found' };
    if (current.deletedAt) return { outcome: 'in-trash', task: current };
    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, now, id);
    return { outcome: 'trashed', task: getTask(db, id) };
  });
}

function listTrash(db) {
  const today = todayInDubai();
  return db.prepare(`${SELECT_TASK} WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC, t.id DESC`)
    .all()
    .map(row => toTask(row, today));
}

function restoreTask(db, id) {
  return transaction(db, () => {
    const current = getTask(db, id);
    if (!current) return { outcome: 'not-found' };
    if (!current.deletedAt) return { outcome: 'not-in-trash', task: current };
    db.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(new Date().toISOString(), id);
    return { outcome: 'restored', task: getTask(db, id) };
  });
}

// Permanent deletion is only possible for tasks already in Trash. Comments are removed too.
function deletePermanently(db, id) {
  return transaction(db, () => {
    const current = getTask(db, id);
    if (!current) return { outcome: 'not-found' };
    if (!current.deletedAt) return { outcome: 'not-in-trash', task: current };
    db.prepare('DELETE FROM tasks WHERE id = ? AND deleted_at IS NOT NULL').run(id);
    return { outcome: 'deleted' };
  });
}

function listComments(db, taskId) {
  return db.prepare('SELECT id, task_id, author, body, created_at FROM comments WHERE task_id = ? ORDER BY created_at, id')
    .all(taskId)
    .map(row => ({ id: row.id, taskId: row.task_id, author: row.author, body: row.body, createdAt: row.created_at }));
}

function addComment(db, taskId, comment) {
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)')
    .run(taskId, comment.author, comment.body, now);
  return { id: Number(result.lastInsertRowid), taskId, author: comment.author, body: comment.body, createdAt: now };
}

module.exports = {
  listOlderModules, listTasks, getDashboard, getTask, createTask, updateTask,
  moveToTrash, listTrash, restoreTask, deletePermanently,
  listComments, addComment
};
