// Server-side checks for everything the browser sends. Never trust the browser alone.

const { TEAM, MODULES, PRIORITIES, STATUSES, DEFAULTS, LIMITS, UNASSIGNED } = require('./constants');
const { isValidDateString } = require('./dates');

// An error that should be shown to the user with a specific HTTP status code.
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function requireBody(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'Send the data as a JSON object.');
  return body;
}

// Accepts "12" or "ERP-012" and returns the number 12.
function parseTaskId(value) {
  const match = /^(?:ERP-)?(\d{1,9})$/i.exec(String(value));
  const id = match ? Number(match[1]) : 0;
  if (id < 1) throw new HttpError(400, 'The task reference is not valid. Use a number or a reference such as ERP-001.');
  return id;
}

// Checks task fields. With partial = true only the fields that were sent are checked (for edits).
function validateTask(body, { partial = false } = {}) {
  requireBody(body);
  const fields = {};
  const task = {};

  if (!partial || has(body, 'title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) fields.title = 'Enter a title.';
    else if (title.length > LIMITS.title) fields.title = `Keep the title within ${LIMITS.title} characters.`;
    else task.title = title;
  }

  if (!partial || has(body, 'description')) {
    const raw = body.description ?? '';
    if (typeof raw !== 'string') fields.description = 'The description must be text.';
    else if (raw.trim().length > LIMITS.description) fields.description = `Keep the description within ${LIMITS.description} characters.`;
    else task.description = raw.trim();
  }

  const choice = (key, allowed, fallback) => {
    if (partial && !has(body, key)) return;
    const value = body[key] ?? fallback;
    if (typeof value === 'string' && allowed.includes(value)) task[key] = value;
    else fields[key] = `Choose one of: ${allowed.join(', ')}.`;
  };
  if (!partial || has(body, 'module')) {
    const value = body.module ?? DEFAULTS.module;
    if (typeof value === 'string' && MODULES.includes(value)) task.module = value;
    else fields.module = 'Choose a module or category from the current list (see GET /api/meta).';
  }
  choice('priority', PRIORITIES, DEFAULTS.priority);
  choice('status', STATUSES, DEFAULTS.status);

  if (!partial || has(body, 'assignee')) {
    const value = body.assignee ?? null;
    if (value === null || value === '') task.assignee = null;
    else if (typeof value === 'string' && TEAM.includes(value)) task.assignee = value;
    else fields.assignee = `Choose a team member (${TEAM.join(', ')}) or leave unassigned.`;
  }

  if (!partial || has(body, 'dueDate')) {
    const value = body.dueDate ?? null;
    if (value === null || value === '') task.dueDate = null;
    else if (isValidDateString(value)) task.dueDate = value;
    else fields.dueDate = 'Enter a real date as YYYY-MM-DD, or leave it empty.';
  }

  if (Object.keys(fields).length) throw new HttpError(400, 'Please correct the highlighted fields.', { fields });
  return task;
}

function validateVersion(body) {
  requireBody(body);
  if (!Number.isInteger(body.version) || body.version < 1) {
    throw new HttpError(400, 'Include the task "version" number you last loaded, so newer changes are not overwritten.');
  }
  return body.version;
}

function validateComment(body) {
  requireBody(body);
  const fields = {};
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (typeof body.author !== 'string' || !TEAM.includes(body.author)) fields.author = `Choose who is commenting (${TEAM.join(', ')}).`;
  if (!text) fields.body = 'Write a comment.';
  else if (text.length > LIMITS.comment) fields.body = `Keep the comment within ${LIMITS.comment} characters.`;
  if (Object.keys(fields).length) throw new HttpError(400, 'Please correct the highlighted fields.', { fields });
  return { author: body.author, body: text };
}

// Checks the ?q=&assignee=&module=&priority=&status=&overdue= query string.
// olderModules = module names still used by existing tasks, so those tasks can be found.
function validateFilters(query, olderModules = []) {
  const filters = {};
  const fields = {};
  const text = key => {
    const value = query[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') { fields[key] = 'Send this filter only once.'; return undefined; }
    return value.trim();
  };
  const choice = (key, allowed) => {
    const value = text(key);
    if (value === undefined) return;
    if (allowed.includes(value)) filters[key] = value;
    else fields[key] = `Choose one of: ${allowed.join(', ')}.`;
  };

  const q = text('q');
  if (q) {
    if (q.length > LIMITS.search) fields.q = `Keep the search within ${LIMITS.search} characters.`;
    else filters.q = q;
  }
  choice('assignee', [...TEAM, UNASSIGNED]);
  const moduleName = text('module');
  if (moduleName !== undefined) {
    if (MODULES.includes(moduleName) || olderModules.includes(moduleName)) filters.module = moduleName;
    else fields.module = 'Choose a module or category from the list (see GET /api/meta).';
  }
  choice('priority', PRIORITIES);
  choice('status', STATUSES);

  const overdue = text('overdue');
  if (overdue !== undefined) {
    if (overdue === 'true') filters.overdue = true;
    else if (overdue !== 'false') fields.overdue = 'Use overdue=true or overdue=false.';
  }

  if (Object.keys(fields).length) throw new HttpError(400, 'One or more filters are not valid.', { fields });
  return filters;
}

module.exports = { HttpError, parseTaskId, validateTask, validateVersion, validateComment, validateFilters };
