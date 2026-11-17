// The REST API: each route checks the request, calls taskStore, and sends JSON back.
// Handlers are async; Express 5 passes any error they throw to the error handler in app.js.

const express = require('express');
const store = require('./taskStore');
const { checkDatabase, summarizeError } = require('./database');
const { APP_NAME, TEAM, ERP_MODULES, CROSS_MODULE_CATEGORIES, MODULES, PRIORITIES, STATUSES, DEFAULTS, LIMITS, UNASSIGNED } = require('./constants');
const { TIME_ZONE, todayInDubai } = require('./dates');
const { HttpError, parseTaskId, validateTask, validateVersion, validateComment, validateFilters } = require('./validation');

const notFound = () => new HttpError(404, 'Task not found. It may have been permanently deleted.');

// Checks the search/filter query string. Older module names (still used by existing tasks)
// are looked up in the database only when a module filter is actually being used.
async function filtersFrom(db, query) {
  const wanted = typeof query.module === 'string' ? query.module.trim() : '';
  const older = wanted && !MODULES.includes(wanted) ? await store.listOlderModules(db) : [];
  return validateFilters(query, older);
}

function createRoutes(db) {
  const router = express.Router();

  // Health check for people, process managers and IIS: is the process up and the database answering?
  router.get('/health', async (req, res) => {
    try {
      await checkDatabase(db);
      res.json({ status: 'ok', app: APP_NAME, database: 'ok', uptimeSeconds: Math.floor(process.uptime()), time: new Date().toISOString() });
    } catch (error) {
      console.error(`Health check failed: ${summarizeError(error)}`);
      res.status(503).json({ status: 'error', app: APP_NAME, database: 'unavailable' });
    }
  });

  // Dropdown options: team members, modules, priorities and statuses.
  router.get('/api/meta', async (req, res) => {
    res.json({
      app: APP_NAME, team: TEAM,
      modules: MODULES,
      moduleGroups: [
        { label: 'ERP modules', options: ERP_MODULES },
        { label: 'Cross-module categories', options: CROSS_MODULE_CATEGORIES }
      ],
      // Names still used by existing tasks but no longer offered for new work.
      olderModules: await store.listOlderModules(db),
      priorities: PRIORITIES, statuses: STATUSES,
      defaults: DEFAULTS, limits: LIMITS, unassignedLabel: UNASSIGNED,
      timeZone: TIME_ZONE, today: todayInDubai()
    });
  });

  router.get('/api/dashboard', async (req, res) => {
    res.json(await store.getDashboard(db, await filtersFrom(db, req.query)));
  });

  // List, search and filter tasks (Trash is always excluded).
  router.get('/api/tasks', async (req, res) => {
    const tasks = await store.listTasks(db, await filtersFrom(db, req.query));
    res.json({ count: tasks.length, tasks });
  });

  router.post('/api/tasks', async (req, res) => {
    const task = await store.createTask(db, validateTask(req.body));
    res.status(201).location(`/api/tasks/${task.id}`).json(task);
  });

  router.get('/api/tasks/:id', async (req, res) => {
    const task = await store.getTask(db, parseTaskId(req.params.id));
    if (!task) throw notFound();
    res.json(task);
  });

  // Edit, reassign or change status. Send only the fields that change, plus "version".
  router.patch('/api/tasks/:id', async (req, res) => {
    const id = parseTaskId(req.params.id);
    const version = validateVersion(req.body);
    // A task saved under an older module name may keep it: sending the same value is "no change".
    const existing = await store.getTask(db, id);
    const body = { ...req.body };
    if (existing && body.module === existing.module) delete body.module;
    const changes = validateTask(body, { partial: true });
    if (!existing) throw notFound();
    if (!Object.keys(changes).length) throw new HttpError(400, 'Send at least one field to change.');

    const result = await store.updateTask(db, id, changes, version);
    if (result.outcome === 'not-found') throw notFound();
    if (result.outcome === 'in-trash') {
      throw new HttpError(409, `${result.task.reference} is in Trash. Restore it before editing.`, { code: 'IN_TRASH' });
    }
    if (result.outcome === 'conflict') {
      throw new HttpError(409,
        `${result.task.reference} was changed by someone else after you opened it. Your changes were not saved.`,
        { code: 'VERSION_CONFLICT', current: result.task });
    }
    res.json(result.task);
  });

  // "Move to Trash" (soft delete). The task and its comments can be restored later.
  router.post('/api/tasks/:id/trash', async (req, res) => {
    const result = await store.moveToTrash(db, parseTaskId(req.params.id));
    if (result.outcome === 'not-found') throw notFound();
    if (result.outcome === 'in-trash') throw new HttpError(409, `${result.task.reference} is already in Trash.`, { code: 'IN_TRASH' });
    res.json(result.task);
  });

  router.get('/api/tasks/:id/comments', async (req, res) => {
    const id = parseTaskId(req.params.id);
    if (!(await store.getTask(db, id))) throw notFound();
    const comments = await store.listComments(db, id);
    res.json({ count: comments.length, comments });
  });

  router.post('/api/tasks/:id/comments', async (req, res) => {
    const id = parseTaskId(req.params.id);
    const comment = validateComment(req.body);
    const result = await store.addComment(db, id, comment);
    if (result.outcome === 'not-found') throw notFound();
    if (result.outcome === 'in-trash') {
      throw new HttpError(409, `${result.task.reference} is in Trash. Restore it before commenting.`, { code: 'IN_TRASH' });
    }
    res.status(201).json(result.comment);
  });

  router.get('/api/trash', async (req, res) => {
    const tasks = await store.listTrash(db);
    res.json({ count: tasks.length, tasks });
  });

  router.post('/api/trash/:id/restore', async (req, res) => {
    const result = await store.restoreTask(db, parseTaskId(req.params.id));
    if (result.outcome === 'not-found') throw notFound();
    if (result.outcome === 'not-in-trash') throw new HttpError(409, `${result.task.reference} is not in Trash.`, { code: 'NOT_IN_TRASH' });
    res.json(result.task);
  });

  // "Delete permanently": only works for tasks that are already in Trash. Cannot be undone.
  router.delete('/api/trash/:id', async (req, res) => {
    const result = await store.deletePermanently(db, parseTaskId(req.params.id));
    if (result.outcome === 'not-found') throw notFound();
    if (result.outcome === 'not-in-trash') {
      throw new HttpError(409, `${result.task.reference} is not in Trash. Move it to Trash first.`, { code: 'NOT_IN_TRASH' });
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { createRoutes };
