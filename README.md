# ERP Rebuild Task Tracker

An internal task tracker for the four-person ERP rebuild team (Thameem, Parimitha,
Mausooq and Rashneema).

**Technology:** Node.js + Express backend, SQLite database, plain HTML/CSS/JavaScript frontend.
No React, TypeScript, Docker, paid services or API keys.

> **Important:** this version has **no login and no permissions**. Anyone who can open the
> page can see and change every task, and names are picked from a list without being
> verified. Add login and permissions before using it for real company work
> (see [section 11](#11-known-limitations)).

---

## 1. What the application does

- **Tasks** with an automatic reference (`ERP-001`, `ERP-002`, …), title, description,
  ERP module or cross-module category, assignee, priority (Low / Medium / High), status (To Do / In Progress /
  Blocked / Completed), optional due date, and automatic created / last-updated times.
- **Summary strip** above the task list: total tasks, In Progress, Completed and Overdue.
- **Overview page:** the same totals for all tasks, a team workload row for each member
  (pending, completed and a completion bar) and a collapsible **Work by module** summary.
- **Sidebar:** Overview, Tasks and Trash navigation, one-click team filters, and a
  collapsible module list with task counts. On phones and narrow windows the sidebar
  becomes a slide-in menu opened with the **Menu** button.
- **Search and filters** that combine: assignee, module, priority, status, overdue-only,
  and text search over reference, title and description.
- **Two views** of the same data: a table, and a board with one column per status. In the
  table, each task's module is shown under its title.
- **Comments** on each task, with author and time.
- **Trash:** deleting moves a task to Trash; it can be restored with its comments, or
  permanently deleted from Trash after a confirmation.
- **Conflict protection:** if two people edit the same task, the second save is not
  allowed to silently overwrite the first.
- **Refresh:** a Refresh button, plus an automatic refresh every 30 seconds that never
  interrupts an open form.

The tracker manages the **work of rebuilding** the ERP modules. It does not contain or
implement the modules themselves.

### Modules and categories

Tasks are filed under one of the module names shown in the ERP menu:

| ERP modules | | | |
| --- | --- | --- | --- |
| CRM | Forwarding | Transport (By Land) | Customs |
| NVOCC (Liner) | Trading & Service | Warehouse (Advance) | Warehouse (Basic) |
| Pricing | Financials | MIS | Business Intelligence |
| Credit Control | Purchase | Tracking | AWB Stock |

or, for work that spans several modules, one of four categories:
**General / Cross-module**, **Documents & OCR**, **Integrations & APIs**,
**Deployment & Infrastructure**.

- MIS and Business Intelligence are separate, and so are the two Warehouse modules.
- The same list is used when creating and editing tasks, in the module filter, and in
  the *Work by module* summary.
- **No module belongs to a person.** Choosing a module never sets the assignee; every
  task is assigned by hand, and a new task starts unassigned.
- The list lives in `src/constants.js`.

Definitions used in the summary strip and on the Overview page:

| Term | Meaning |
| --- | --- |
| Total tasks | Every task that is not in Trash (any status) |
| Pending (workload) | Not in Trash and status is not Completed |
| Overdue | Has a due date **before today**, and is not Completed. A task due today is not overdue |
| "Today" | The current date in the **Asia/Dubai** timezone, wherever the server is located |

The summary strip on the Tasks page follows the current filters and is labelled either
"Counts cover all tasks" or "Counts cover filtered results only". Everything on the
Overview page (totals, team workload, *Work by module*) always covers all tasks.

In the sidebar, the number beside a team member is their **pending** tasks, and the
number beside a module is **all** its tasks (pending and completed); hover for the
breakdown. Clicking a person or module there filters the task list, and clicking it again
removes the filter. These are the same filters as the dropdowns above the task list.

---

## 2. Set up on Windows with VS Code

1. **Install Node.js** from <https://nodejs.org/>. Choose an **LTS** version.
   - Supported: Node.js **22.13 or newer**. Recommended: the current LTS (24 or 26).
   - Developed and tested on Node.js 26.13.1.
   - Check it in a terminal:

     ```text
     node --version
     npm --version
     ```

2. **Open the project:** in VS Code choose **File > Open Folder** and select the folder
   containing `package.json` and `server.js`.
3. **Open a terminal:** **Terminal > New Terminal**.
4. **Install the dependency** (Express). This is needed once, and again whenever
   `package.json` changes:

   ```text
   npm install
   ```

5. **Start the app:**

   ```text
   npm start
   ```

6. Open <http://localhost:3000> in your browser.

If PowerShell says `npm.ps1 cannot be loaded`, choose **Command Prompt** from the terminal
dropdown in VS Code, or type `npm.cmd` instead of `npm`.

### Why there is no separate SQLite package

SQLite is used through **`node:sqlite`, the SQLite module built into Node.js**. Popular
add-on packages such as `better-sqlite3` download a compiled `.node` file, and the
Windows Application Control policy on the development laptop blocks those files from
loading. The built-in module needs no download and no compiler, so `npm install` only
installs Express. On Node.js 22 and 24 you may see a one-line "SQLite is an experimental
feature" warning at startup; it is harmless.

### Settings (optional)

The defaults work on a laptop. To change them, copy `.env.example` to `.env` and edit it.
`npm start` loads `.env` automatically when it exists.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the app listens on |
| `HOST` | `127.0.0.1` | `127.0.0.1` = this computer only; `0.0.0.0` = reachable from the network |
| `DATA_DIR` | `./data` | Folder that holds the database |
| `DB_FILE` | `<DATA_DIR>/erp-tracker.db` | Full path of the database file (optional) |
| `BACKUP_DIR` | `./backups` | Where `npm run backup` saves copies |
| `ALLOWED_ORIGINS` | empty | Public site address(es) when behind a proxy (see section 10) |

---

## 3. Run and stop the app

| Command | What it does |
| --- | --- |
| `npm start` | Start the app. Leave the terminal open while you use it |
| **Ctrl+C** in that terminal | Stop the app |
| `npm run dev` | Start, and restart automatically when a backend file is saved |
| `npm test` | Run the automated API tests (uses a temporary database, not your data) |
| `npm run seed` | Add example tasks for a demo (optional, see section 8) |
| `npm run backup` | Save a copy of the database (see section 9) |
| `npm run import-legacy` | Run or check the old-task import by hand (see section 8) |
| `npm run map-module` | List or map older module names (see section 8) |

After `npm start` you should see:

```text
ERP Rebuild Task Tracker is running at http://127.0.0.1:3000
Database file: D:\task-tracker\data\erp-tracker.db
Press Ctrl+C to stop.
```

**"Port 3000 is already in use"** means another copy of the app (or the old Task Tracker)
is still running. Stop it with Ctrl+C in its terminal, or start this one on another port:

```powershell
$env:PORT = 3001; npm start
```

After changing frontend files in `public/`, just refresh the browser.

---

## 4. What each file does

```text
task-tracker/
├── server.js               Entry point: reads settings, opens the database, starts the server
├── package.json            Project name, npm scripts, dependency list
├── package-lock.json       Exact dependency versions (commit this file)
├── .env.example            Example settings file
├── ecosystem.config.cjs    Optional PM2 (process manager) settings
├── src/
│   ├── constants.js        Team members, modules, priorities, statuses, length limits
│   ├── config.js           Reads PORT, HOST, DATA_DIR… from the environment
│   ├── dates.js            "Today" in Asia/Dubai and date checking
│   ├── database.js         Opens SQLite and creates the tables
│   ├── legacyImport.js     One-time import of the old data/tasks.json
│   ├── validation.js       Checks everything the browser sends
│   ├── taskStore.js        All SQL queries for tasks, comments, Trash and the dashboard
│   ├── routes.js           The REST API endpoints
│   └── app.js              Express setup: security headers, JSON, static files, errors
├── public/                 The frontend, sent to the browser as-is
│   ├── index.html          Page structure
│   ├── style.css           Colours, layout, responsive rules
│   ├── app.js              Browser logic: calls the API and draws the page
│   └── favicon.svg         Browser-tab icon
├── scripts/
│   ├── seed.js             Optional example tasks
│   ├── backup.js           Safe database backup
│   ├── import-legacy.js    Manual run of the old-task import
│   └── map-module.js       Move tasks from an older module name to a current one
├── tests/api.test.js       Automated API tests
└── data/
    ├── erp-tracker.db      The SQLite database (created on first start)
    └── tasks.json          Tasks from the original app (read once, never changed)
```

A request travels through the backend in this order:
`app.js` (checks and JSON parsing) → `routes.js` (which endpoint?) → `validation.js`
(is the input valid?) → `taskStore.js` (SQL) → SQLite file.

To add a team member or module, edit `src/constants.js` and restart the app. Removing or
renaming a module there does not change existing tasks (see "Older module names" in
section 8).

---

## 5. How the browser talks to the backend

1. The browser requests `http://localhost:3000/`. Express sends `index.html`, which in
   turn loads `style.css` and `app.js`.
2. `public/app.js` calls `fetch('/api/meta')` to get the team and module lists, then
   `fetch('/api/tasks')`, `fetch('/api/dashboard')` and `fetch('/api/trash')`.
3. The backend answers with **JSON** (text describing data). The browser code builds the
   table, board, summary strip and sidebar from that JSON.
4. When you save a task, the browser sends JSON to the backend (`POST` to create,
   `PATCH` to change). The backend validates it, stores it in SQLite, and returns the
   saved task. The browser then reloads the lists.

All data lives on the server in SQLite, so everyone using the same server sees the same
tasks, and clearing browser history deletes nothing. The browser stores only two small
conveniences locally: your last view (table/board) and your last comment name.

**Safe display of text:** user-entered text is put on the page as plain text
(`textContent`), never as HTML, so a title like `<script>…</script>` is shown as typed
and cannot run. The server also sends a Content-Security-Policy header that blocks
inline scripts.

**Editing conflicts:** every task has a `version` number that increases on each change.
The browser sends the version it loaded when saving. If someone else saved in between,
the server answers `409 Conflict` instead of overwriting, and the form explains what
changed and offers two choices: load their version, or keep your edits (only the fields
you changed are saved on top of their version).

---

## 6. API endpoints

Base address: `http://localhost:3000`. Bodies and answers are JSON.
A task can be addressed by number (`/api/tasks/4`) or reference (`/api/tasks/ERP-004`).

| Method | Address | Purpose |
| --- | --- | --- |
| GET | `/health` | Is the process running and the database readable? |
| GET | `/api/meta` | Team members, modules (`modules`, grouped in `moduleGroups`, plus `olderModules` still in use), priorities, statuses, limits, today's date |
| GET | `/api/dashboard` | Summary numbers, workload and per-module counts (accepts the same filters as the list) |
| GET | `/api/tasks` | List, search and filter tasks (Trash excluded) |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/:id` | One task's details |
| PATCH | `/api/tasks/:id` | Edit, reassign or change status (needs `version`) |
| POST | `/api/tasks/:id/trash` | Move to Trash |
| GET | `/api/tasks/:id/comments` | Read comments, oldest first |
| POST | `/api/tasks/:id/comments` | Add a comment |
| GET | `/api/trash` | List tasks in Trash |
| POST | `/api/trash/:id/restore` | Restore from Trash |
| DELETE | `/api/trash/:id` | Delete permanently (only works for tasks in Trash) |

Filters for `/api/tasks` and `/api/dashboard` (all optional, combined with AND):
`q`, `assignee` (a name or `Unassigned`), `module`, `priority`, `status`, `overdue=true`.

### Examples

The simplest test is the browser: open <http://localhost:3000/api/tasks>.
The examples below use PowerShell.

**Health**

```powershell
Invoke-RestMethod http://localhost:3000/health
```

```json
{ "status": "ok", "app": "ERP Rebuild Task Tracker", "database": "ok", "uptimeSeconds": 42, "time": "2026-11-16T12:31:54.718Z" }
```

**Create a task**

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/tasks -ContentType 'application/json' `
  -Body '{"title":"Design invoice screen","module":"Financials","assignee":"Parimitha","priority":"High","dueDate":"2026-11-30"}'
```

Answer: `201 Created`

```json
{
  "id": 4,
  "reference": "ERP-004",
  "title": "Design invoice screen",
  "description": "",
  "module": "Financials",
  "moduleIsOlderName": false,
  "assignee": "Parimitha",
  "priority": "High",
  "status": "To Do",
  "dueDate": "2026-11-30",
  "isOverdue": false,
  "commentCount": 0,
  "createdAt": "2026-11-16T12:40:11.502Z",
  "updatedAt": "2026-11-16T12:40:11.502Z",
  "version": 1,
  "deletedAt": null
}
```

Only `title` is required. Defaults: module `General / Cross-module`, priority `Medium`, status `To Do`,
no assignee, no due date.

**Search and filter together**

```powershell
Invoke-RestMethod 'http://localhost:3000/api/tasks?q=invoice&assignee=Parimitha&status=To%20Do'
```

```json
{ "count": 1, "tasks": [ { "id": 4, "reference": "ERP-004", "title": "Design invoice screen", "...": "..." } ] }
```

**Change status or reassign** (send the `version` you last received)

```powershell
Invoke-RestMethod -Method Patch -Uri http://localhost:3000/api/tasks/ERP-004 -ContentType 'application/json' `
  -Body '{"version":1,"status":"In Progress","assignee":"Mausooq"}'
```

The answer is the updated task with `"version": 2`. Sending `"version": 1` again gives
`409 Conflict`:

```json
{
  "error": "ERP-004 was changed by someone else after you opened it. Your changes were not saved.",
  "code": "VERSION_CONFLICT",
  "current": { "id": 4, "version": 2, "status": "In Progress", "...": "..." }
}
```

**Add and read comments**

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/tasks/4/comments -ContentType 'application/json' `
  -Body '{"author":"Mausooq","body":"Blocked: carrier API sandbox credentials have not arrived."}'
Invoke-RestMethod http://localhost:3000/api/tasks/4/comments
```

```json
{ "count": 1, "comments": [ { "id": 1, "taskId": 4, "author": "Mausooq", "body": "Blocked: carrier API sandbox credentials have not arrived.", "createdAt": "2026-11-16T12:35:20.945Z" } ] }
```

**Dashboard**

```powershell
Invoke-RestMethod http://localhost:3000/api/dashboard
```

```json
{
  "scope": "all",
  "today": "2026-11-16",
  "summary": { "active": 16, "inProgress": 3, "completed": 3, "overdue": 2 },
  "workloadScope": "all",
  "workload": [
    { "name": "Thameem", "pending": 1, "completed": 2 },
    { "name": "Parimitha", "pending": 3, "completed": 0 },
    { "name": "Mausooq", "pending": 2, "completed": 1 },
    { "name": "Rashneema", "pending": 3, "completed": 0 }
  ],
  "unassigned": { "pending": 4, "completed": 0 },
  "moduleScope": "all",
  "modules": [
    { "name": "CRM", "pending": 1, "completed": 1, "olderName": false },
    { "name": "Forwarding", "pending": 1, "completed": 0, "olderName": false },
    { "name": "...", "pending": 0, "completed": 0, "olderName": false }
  ]
}
```

**Trash, restore, delete permanently**

```powershell
Invoke-RestMethod -Method Post   http://localhost:3000/api/tasks/4/trash     # move to Trash
Invoke-RestMethod                http://localhost:3000/api/trash             # list Trash
Invoke-RestMethod -Method Post   http://localhost:3000/api/trash/4/restore   # restore
Invoke-RestMethod -Method Delete http://localhost:3000/api/trash/4           # permanent; 409 unless in Trash
```

### Errors

Errors always look like `{ "error": "message" }`, sometimes with more detail:

```json
{ "error": "Please correct the highlighted fields.", "fields": { "title": "Enter a title.", "priority": "Choose one of: Low, Medium, High." } }
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid input (missing title, unknown or older module name, unknown person, impossible date, bad JSON, bad filter) |
| 403 | The request came from a different website |
| 404 | Task or address not found |
| 409 | Conflict: stale `version`, or the task is / is not in Trash for this action |
| 413 | Request too large |
| 415 | Data was not sent as JSON |
| 500 | Unexpected server or database error (details are in the server log, not shown to users) |
| 503 | `/health` only: the database could not be read |

Server-side limits: title 150 characters, description 4,000, comment 2,000, search 100.
Input is trimmed. Dates must be real dates written `YYYY-MM-DD`. All SQL uses `?`
parameters, so user text is never mixed into SQL commands.

---

## 7. Where the data is stored

Everything is in one SQLite database: **`data/erp-tracker.db`** (or wherever `DATA_DIR` /
`DB_FILE` point). While the app runs you will also see `erp-tracker.db-wal` and
`erp-tracker.db-shm`. They belong to the database and hold the most recent changes, so
never delete or separate them while the app is running.

| Table | Contents |
| --- | --- |
| `tasks` | One row per task. `deleted_at` is filled in while a task is in Trash |
| `comments` | One row per comment, linked to its task. Deleted together with the task on permanent deletion |
| `app_meta` | Notes for one-time jobs: old-task import done, sample tasks added |

The reference `ERP-007` is simply the task's numeric id, padded to three digits.
Numbers are never reused, even after permanent deletion. After `ERP-999` comes `ERP-1000`.

Timestamps are stored in UTC and shown in Dubai time.

The database and backups are listed in `.gitignore`, so real task data is not committed.

---

## 8. Importing old tasks and loading sample tasks

### Old tasks from `data/tasks.json`

The original app stored tasks in `data/tasks.json`. On its **first start**, this version
imports them automatically and prints, for example:

```text
Imported 3 task(s) from D:\task-tracker\data\tasks.json (one-time import; the file was not changed).
```

| Old field | New value |
| --- | --- |
| `title` | Title (unchanged) |
| `completed: true` | Status **Completed** |
| `completed: false` | Status **To Do** |
| `createdAt` | Created and last-updated time |
| new fields | Category **General / Cross-module**, priority **Medium**, **unassigned**, no due date, empty description |

- `tasks.json` is only read. It is never edited or deleted, so it remains as a backup.
- The import runs **once**. It is recorded in the database, and each old task's id is
  stored with a uniqueness rule, so restarting never creates duplicates.
- A task you later delete permanently does not come back.
- After the import, changes to `tasks.json` are ignored. The old app's file is no longer used.
- `npm run import-legacy` shows whether and when the import happened.

### Older module names

The first version of this tracker used a different, generic module list (for example
*Finance & Accounts* and *Sales & CRM*). When the list was replaced with the real ERP
module names, **no task was changed or deleted**. A task saved under an older name:

- keeps that name, marked **old name** in the table, board and details;
- is still counted in the totals, and appears under *Older names* in the sidebar module
  list and in *Work by module* on the Overview page;
- can still be found with the module filter;
- can be edited freely (status, assignee, comments…) without losing its module.

Older names cannot be chosen for new tasks. Nothing is mapped automatically, because only
the team knows where each task belongs. There are two ways to move tasks to a current name:

1. **One task at a time:** click **Edit**, choose the right module, **Save changes**.
2. **All tasks under one older name together:**

   ```text
   npm run backup
   npm run map-module
   npm run map-module -- "Finance & Accounts" "Financials"
   ```

   The second command only lists the older names in use and how many tasks each has. The
   third moves every task (including tasks in Trash) from the first name to the second.
   Use option 1 instead when the tasks under one older name belong to different modules.

Once no task uses an older name, it disappears from the filter and the summary.

Three names are the same in both lists (*Documents & OCR*, *Integrations & APIs*,
*Deployment & Infrastructure*), so tasks under them need nothing. The older *General* is
kept as an older name rather than being renamed to *General / Cross-module*; map it with
the command above if that is where those tasks belong.

### Sample tasks (optional)

```text
npm run seed
```

adds 17 example tasks, spread over the four people and several modules, with a few
comments and some overdue dates. The people on the samples are mixed deliberately and do
not mean anyone owns a module. Every title starts with **`[Sample]`**. The command
never runs automatically and refuses to run twice on the same database. Remove the
samples by moving them to Trash and deleting them permanently.

For a demo without touching real data, use a separate folder:

```powershell
$env:DATA_DIR = "demo-data"; npm run seed; npm start
```

(Close that terminal afterwards so `DATA_DIR` goes back to the default.)

---

## 9. Backing up and restoring

### Back up (safe while the app is running)

```text
npm run backup
```

creates a complete copy such as `backups/erp-tracker-20261116-123536.db` (date and time
in UTC) and verifies it. Copy that file to another disk or a network share as well. A
backup on the same disk does not protect against disk failure.

Do **not** back up by copying only `erp-tracker.db` while the app runs: recent changes
may still be in the `-wal` file, and the copy can be incomplete.

### Restore

1. **Stop the app** (Ctrl+C, or `pm2 stop erp-task-tracker`).
2. Keep the current state in case you need it: rename the `data` folder's
   `erp-tracker.db`, `erp-tracker.db-wal` and `erp-tracker.db-shm` (for example add
   `.old`), or move them elsewhere.
3. Copy the chosen backup into `data` and rename it to `erp-tracker.db`.
   There must be no leftover `-wal` or `-shm` file from the old database next to it.
4. Start the app and check the tasks.

Everything saved after that backup was taken is not in the restored database.

---

## 10. How PM2, IIS and DNS fit into deployment

Nothing in this project deploys anything or changes Windows, IIS or network settings.
This section explains the pieces your team lead will set up.

```text
Colleague's browser
      │  1. "Where is erp-tasks.company.local?"
      ▼
     DNS  ──────────►  answers with the server's IP address
      │
      │  2. HTTP(S) request to that IP, port 80/443
      ▼
     IIS (web server on the Windows server)
      │  3. forwards the request to http://127.0.0.1:3000   (reverse proxy)
      ▼
   Node.js app (server.js), kept running by PM2
      │
      ▼
   data\erp-tracker.db
```

**Node.js app.** Listens on `127.0.0.1:3000`, which only programs on the same server can
reach. It is never exposed to the network directly.

**PM2 (process manager).** With plain `npm start` the app stops when the terminal closes
or the app crashes. PM2 runs it in the background, restarts it after a crash and keeps
its logs:

```text
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs erp-task-tracker
```

Under PM2, settings come from the `env` block in `ecosystem.config.cjs` (PM2 does not
read `.env`). Keep `instances: 1`: SQLite is one file with one writer.

**PM2 does not, by itself, start again after Windows reboots.** `pm2 startup` supports
Linux and macOS, not Windows. Making PM2 (and so the app) start at boot is a separate
step, typically a Windows service or a scheduled task that runs PM2 at startup. Agree the
method with your team lead; until that is done, someone must start the app after every
reboot.

**IIS (reverse proxy).** IIS owns ports 80/443, handles HTTPS certificates and Windows
integration, and forwards requests to Node.js. This needs two IIS add-ons, **URL Rewrite**
and **Application Request Routing (ARR)**, with proxying enabled, plus a rewrite rule.
An *example* of such a rule, for discussion only (it is not part of this project):

```xml
<!-- web.config in the IIS site folder (example) -->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ERP Task Tracker" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

One thing to know behind a proxy: for safety the app only accepts changes (POST, PATCH,
DELETE) from its own pages. It compares the browser's `Origin` header with the `Host`
header. If IIS replaces the host name with `127.0.0.1:3000`, saving fails with
**"Origin does not match this site"**. Fix it either way:

- tell IIS/ARR to keep the original host header (`preserveHostHeader`), or
- set `ALLOWED_ORIGINS` to the public address, for example
  `ALLOWED_ORIGINS=http://erp-tasks.company.local`.

**DNS.** Turns a name such as `erp-tasks.company.local` into the server's IP address so
colleagues do not type numbers. For an internal tool this is usually a record on the
company's internal DNS server, created by IT.

**Health check.** `GET /health` returns `200` with `"status": "ok"` when the process is
up and the database is readable. Use it to test each layer: directly
(`http://127.0.0.1:3000/health` on the server), then through IIS, then through the DNS name.

**Before real use on a server:** put the database folder (`DATA_DIR`) outside the code
folder so deployments cannot overwrite it, schedule `npm run backup`, make sure the
account running Node.js can write to that folder, serve the site over HTTPS, and add
login (section 11).

---

## 11. Known limitations

- **No authentication or permissions.** There is no login. Anyone who can reach the site
  can read, change, trash and permanently delete any task. The assignee and comment
  author dropdowns only *record* a chosen name; they do not prove who is at the keyboard.
  **Login and permissions must be added before using this for real company work.**
- **No audit history.** Only the latest version of a task is stored. There is no record
  of who changed what.
- **Team and modules are fixed lists** in `src/constants.js`. Changing them needs a
  restart. Removing or renaming a module does not update existing tasks: they keep the
  older name until mapped (section 8). Removing a team member is not handled the same
  way: their existing tasks stay assigned to them but can no longer be filtered by name.
- **A task has exactly one module or category.** Work touching several modules goes under
  *General / Cross-module* or is split into one task per module.
- **Comments cannot be edited or deleted**, except by permanently deleting their task.
- **No real-time updates.** Other people's changes appear after Refresh or within about
  30 seconds. Conflicts are detected when saving, not while typing.
- **Conflict checking is per task**, not per field: two people changing different fields
  of one task at the same moment still get a conflict message (nothing is lost).
- **Trash is never emptied automatically**, and there is no "empty Trash" button.
- **No drag-and-drop** on the board. Use the status dropdown on each card.
- **No file attachments, notifications, or email.**
- **One server process, one SQLite file.** Suitable for a small team; not designed for
  several app servers or heavy load.
- **No HTTPS in the app itself.** HTTPS should be provided by IIS.
- **No pagination.** All matching tasks are loaded at once, which is fine for hundreds of
  tasks, not for tens of thousands.

See `DEMO_GUIDE.md` for a short script to demonstrate the app.
