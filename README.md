# ERP Rebuild Task Tracker

An internal task tracker for the four-person ERP rebuild team (Thameem, Parimitha,
Mausooq and Rashneema).

**Technology:** Node.js + Express backend, **MySQL 8.0** database (through the `mysql2`
driver), plain HTML/CSS/JavaScript frontend. No React, TypeScript, Docker, paid services or
API keys.

> **Important:** this version has **no login and no permissions**. Anyone who can open the
> page can see and change every task, and names are picked from a list without being
> verified. Add login and permissions before using it for real company work
> (see [section 11](#11-known-limitations)).

**Moving from the earlier SQLite version?** The application no longer uses SQLite. Your old
data is not touched and is not imported automatically; see
[section 8](#8-importing-old-data-and-loading-sample-tasks) for the explicit import command.

---

## 1. What the application does

- **Tasks** with an automatic reference (`ERP-001`, `ERP-002`, ...), title, description,
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

## 2. Set up on Windows (Node.js + MySQL)

These steps assume the Windows machine already has:

- **Node.js 22.13 or newer** (the VM has 24.18.0). Check with `node --version`.
- **MySQL Server 8.0** running as a Windows service.
- An **empty database** `erp_task_tracker` (character set `utf8mb4`, collation
  `utf8mb4_unicode_ci`), created by a MySQL administrator.
- A **runtime account** `erp_tracker_app` that can connect only from `localhost` and has only
  `SELECT, INSERT, UPDATE, DELETE` on that database.

(The administrator's one-time statements for the last two items are in the box at the end of
this section, for reference.)

The application's account never creates or changes tables. An administrator applies the
schema file once (step 4); after that the application needs nothing more than those four
permissions.

### Step by step

Open **PowerShell** in the project folder (in VS Code: **Terminal > New Terminal**). If it
says `npm.ps1 cannot be loaded`, choose **Command Prompt** from the terminal dropdown, or
type `npm.cmd` instead of `npm`.

**1. Go to the project folder**

```powershell
cd D:\task-tracker
```

**2. Install the dependencies** (Express and the MySQL driver; needed once, and again whenever
`package.json` changes)

```powershell
npm install
```

**3. Tell PowerShell where the MySQL command-line client is** (this only lasts for the current
PowerShell window; it does not change any Windows setting). The default location for MySQL 8.0
is shown; adjust it if MySQL is installed elsewhere.

```powershell
$mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
& $mysql --version
```

**4. Apply the schema, once, as the MySQL administrator** (MySQL asks for the administrator's
password; it is not stored anywhere). Run this from the project folder, so the relative file
path works:

```powershell
& $mysql -u root -p --default-character-set=utf8mb4 erp_task_tracker -e "source scripts/schema.mysql.sql"
```

This creates the three tables (`tasks`, `comments`, `app_meta`) and nothing else. It only uses
`CREATE TABLE IF NOT EXISTS`, so running it again is harmless and never deletes data. If your
project folder path contains spaces, use Command Prompt instead of PowerShell:

```text
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p --default-character-set=utf8mb4 erp_task_tracker < scripts\schema.mysql.sql
```

**5. Create the `.env` file with the application's settings.** Copy the example and open the
copy in Notepad:

```powershell
Copy-Item .env.example .env
notepad .env
```

Type the real password of `erp_tracker_app` after `DB_PASSWORD=` (on the server only), then save
as **UTF-8** (the Notepad default on Windows 11). The result looks like this:

```text
PORT=3000
HOST=127.0.0.1
DB_HOST=localhost
DB_PORT=3306
DB_NAME=erp_task_tracker
DB_USER=erp_tracker_app
DB_PASSWORD=the-real-password-goes-here
```

- If the password contains `#`, a space, a quote or a backslash, wrap it in single quotes:
  `DB_PASSWORD='my pass#word'`.
- `.env` is listed in `.gitignore`, so it is never committed to Git. The repository only holds
  `.env.example` with placeholders. Never paste the real password into chat, email or Git.
- Real environment variables win over the file, which is how PM2 or a Windows service can
  override a value.
- The file is read automatically by `npm start`, every `npm run ...` command, and PM2.

**6. Check the settings without starting the website**

```powershell
npm run db:check
```

Expected output (the numbers are 0 on a new database):

```text
Connected to MySQL 8.0.46 at localhost:3306
  database: erp_task_tracker
  account : erp_tracker_app@localhost
Tables:
  tasks     0 row(s)
  comments  0 row(s)
  app_meta  0 row(s)
  (0 task(s) are in Trash)
Everything the application needs at start-up is in place.
```

If it prints something else, see [section 12](#12-troubleshooting). It never prints the password.

**7. Start the application**

```powershell
npm start
```

```text
Connecting to MySQL database "erp_task_tracker" at localhost:3306 as "erp_tracker_app"...
MySQL connection OK.
ERP Rebuild Task Tracker is running at http://127.0.0.1:3000
Press Ctrl+C to stop.
```

The application checks the database connection and the tables **before** it starts accepting
web requests. If MySQL is unreachable, the login is refused or a table is missing, it prints a
plain explanation and stops instead of starting half-working. Open <http://localhost:3000> in
your browser.

**8. Verify the tables and the saved tasks in MySQL.** After creating a task in the browser,
look at the database directly, using the application's own account (it asks for the
`erp_tracker_app` password):

```powershell
& $mysql -u erp_tracker_app -p erp_task_tracker -e "SHOW TABLES;"
& $mysql -u erp_tracker_app -p erp_task_tracker -e "SELECT id, CONCAT('ERP-', LPAD(id, 3, '0')) AS reference, title, module, assignee, priority, status, due_date, deleted_at FROM tasks ORDER BY id;"
& $mysql -u erp_tracker_app -p erp_task_tracker -e "SELECT task_id, author, body, created_at FROM comments ORDER BY id;"
& $mysql -u erp_tracker_app -p erp_task_tracker -e "SHOW GRANTS FOR CURRENT_USER;"
```

The last command should list only `SELECT, INSERT, UPDATE, DELETE` on `erp_task_tracker`.*
(plus MySQL's harmless `USAGE` line, which means "may log in").
Restart the application (Ctrl+C, then `npm start`) and the same tasks are still there: they
live in MySQL, not in the application.

> **For reference: what the administrator created once.** Run as `root`, with your own strong
> password in place of the placeholder. These are *not* run by this project.
>
> ```sql
> CREATE DATABASE erp_task_tracker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
> CREATE USER 'erp_tracker_app'@'localhost' IDENTIFIED BY 'CHOOSE-A-STRONG-PASSWORD';
> GRANT SELECT, INSERT, UPDATE, DELETE ON erp_task_tracker.* TO 'erp_tracker_app'@'localhost';
> ```

### Settings

All settings come from environment variables or the `.env` file. The defaults are shown.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port the website listens on |
| `HOST` | `127.0.0.1` | `127.0.0.1` = this computer only (use this behind IIS); `0.0.0.0` = reachable from the network |
| `DB_HOST` | `localhost` | MySQL server address |
| `DB_PORT` | `3306` | MySQL port |
| `DB_NAME` | `erp_task_tracker` | Database name |
| `DB_USER` | `erp_tracker_app` | The application's MySQL account |
| `DB_PASSWORD` | empty | That account's password. Set it in `.env` on the server |
| `DB_CONNECTION_LIMIT` | `10` | Maximum simultaneous MySQL connections |
| `BACKUP_DIR` | `./backups` | Where `npm run backup` saves `.sql` files |
| `MYSQLDUMP_PATH` | `mysqldump` | Full path of `mysqldump.exe`, if Windows cannot find it |
| `DATA_DIR` | `./data` | Folder holding old files used only by the import commands |
| `SQLITE_FILE` | `<DATA_DIR>/erp-tracker.db` | Old SQLite file for `npm run import-sqlite` |
| `ALLOWED_ORIGINS` | empty | Public site address(es) when behind a proxy (see section 10) |

---

## 3. Run, stop and test

| Command | What it does |
| --- | --- |
| `npm start` | Check MySQL, then start the website. Leave the terminal open while you use it |
| **Ctrl+C** in that terminal | Stop cleanly: finishes open requests, then closes the MySQL connections |
| `npm run dev` | Start, and restart automatically when a backend file is saved |
| `npm run db:check` | Test the `.env` settings and show table row counts, without starting the website |
| `npm test` | Run the automated tests (see "Running the tests" below) |
| `npm run backup` | Save a complete copy of the database as a `.sql` file (section 9) |
| `npm run import-sqlite` | One-time import from the old SQLite file (section 8) |
| `npm run import-legacy` | One-time import from the original app's `tasks.json` (section 8) |
| `npm run map-module` | List or map older module names (section 8) |
| `npm run seed` | Add example tasks for a demo. **Do not run it on real data** (section 8) |

When you press Ctrl+C you should see:

```text
Stopping ERP Rebuild Task Tracker (SIGINT)...
MySQL connection pool closed.
```

**"Port 3000 is already in use"** means another copy of the app is still running. Stop it with
Ctrl+C in its terminal, or start this one on another port:

```powershell
$env:PORT = 3001; npm start
```

After changing frontend files in `public/`, just refresh the browser.

### Running the tests

```powershell
npm test
```

Without any extra setup this runs the tests that need no database (settings, value conversion,
error messages, input validation, the schema file, the SQLite-import logic and the start-up
behaviour when MySQL is unreachable). The tests that need a real MySQL server are **skipped**,
and the output says so.

To run **all** tests, give the tests an administrative MySQL account. They use it only to create
a throw-away database named `erp_task_tracker_test_xxxxxxxx` and a temporary account with
just `SELECT, INSERT, UPDATE, DELETE` on it (exactly like the real application's account), and
they drop both afterwards. They never touch `erp_task_tracker` or any other database. The
account needs permission to create and drop databases and users (for example `root`):

```powershell
$env:TEST_DB_ADMIN_USER = "root"
$env:TEST_DB_ADMIN_PASSWORD = Read-Host "MySQL admin password"
npm test
```

(Type the password when asked. Optional: `TEST_DB_HOST` and `TEST_DB_PORT`; defaults are
`localhost` and `3306`. These can also be put in a `.env.test` file, which Git ignores.) The
backup test also needs `mysqldump`; if it is not on PATH, set `MYSQLDUMP_PATH`.

---

## 4. What each file does

```text
task-tracker/
├── server.js               Entry point: reads settings, checks MySQL, starts the server, stops cleanly
├── package.json            Project name, npm scripts, dependency list
├── package-lock.json       Exact dependency versions (commit this file)
├── .env.example            Example settings (placeholders only). Copy to .env on the server
├── ecosystem.config.cjs    Optional PM2 (process manager) settings
├── src/
│   ├── constants.js        Team members, modules, priorities, statuses, length limits
│   ├── config.js           Reads .env and the environment (PORT, HOST, DB_*, ...)
│   ├── dates.js            "Today" in Asia/Dubai and date checking
│   ├── database.js         The MySQL connection pool, transactions, value conversion, error messages
│   ├── cli.js              Shared start-up and error handling for the scripts
│   ├── legacyImport.js     Explicit one-time import of the old tasks.json
│   ├── sqliteImport.js     Explicit one-time import of the old SQLite database
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
│   ├── schema.mysql.sql    The tables, indexes and foreign keys. Applied once by a MySQL administrator
│   ├── db-check.js         npm run db:check
│   ├── backup.js           npm run backup (uses mysqldump)
│   ├── import-sqlite.js    npm run import-sqlite
│   ├── import-legacy.js    npm run import-legacy
│   ├── map-module.js       npm run map-module
│   └── seed.js             npm run seed
├── tests/                  Automated tests (the MySQL ones are skipped without an admin account)
└── data/                   Optional: old tasks.json / erp-tracker.db, only read by the import commands
```

A request travels through the backend in this order:
`app.js` (checks and JSON parsing) -> `routes.js` (which endpoint?) -> `validation.js`
(is the input valid?) -> `taskStore.js` (SQL) -> `database.js` (connection pool) -> MySQL.
Every step is asynchronous: while one request waits for MySQL, the server keeps answering
others.

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
   `PATCH` to change). The backend validates it, stores it in MySQL, and returns the
   saved task. The browser then reloads the lists.

All data lives in MySQL, so everyone using the same server sees the same tasks, and
clearing browser history deletes nothing. The browser stores only two small conveniences
locally: your last view (table/board) and your last comment name.

**Safe display of text:** user-entered text is put on the page as plain text
(`textContent`), never as HTML, so a title like `<script>...</script>` is shown as typed
and cannot run. The server also sends a Content-Security-Policy header that blocks
inline scripts.

**Editing conflicts:** every task has a `version` number that increases on each change.
The browser sends the version it loaded when saving. The database applies the change only
if the version still matches, in one atomic statement
(`UPDATE ... WHERE id = ? AND version = ? AND deleted_at IS NULL`) and the server checks how
many rows it changed. If someone else saved in between (even a split second earlier), no row
matches and the server answers `409 Conflict` instead of overwriting. The form then explains
what changed and offers two choices: load their version, or keep your edits (only the fields
you changed are saved on top of their version).

---

## 6. API endpoints

Base address: `http://localhost:3000`. Bodies and answers are JSON.
A task can be addressed by number (`/api/tasks/4`) or reference (`/api/tasks/ERP-004`).

| Method | Address | Purpose |
| --- | --- | --- |
| GET | `/health` | Is the process running and is MySQL answering? |
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

If MySQL cannot be reached, this answers `503` with
`{ "status": "error", "app": "ERP Rebuild Task Tracker", "database": "unavailable" }`.

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
no assignee, no due date. `dueDate` is a plain calendar day (`YYYY-MM-DD`) with no time and no
timezone; `createdAt`, `updatedAt` and `deletedAt` are UTC timestamps.

**Search and filter together**

```powershell
Invoke-RestMethod 'http://localhost:3000/api/tasks?q=invoice&assignee=Parimitha&status=To%20Do'
```

```json
{ "count": 1, "tasks": [ { "id": 4, "reference": "ERP-004", "title": "Design invoice screen", "...": "..." } ] }
```

Text search ignores upper/lower case and accents (the database collation is
`utf8mb4_unicode_ci`), and `%`, `_` and `!` typed in the search box are matched literally.

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
| 500 | Unexpected server error (details are in the server log, not shown to users) |
| 503 | MySQL is unreachable or busy: `{ "error": "The database is not reachable right now. Please try again in a moment.", "code": "DATABASE_UNAVAILABLE" }`. The application keeps running and recovers by itself when MySQL is back |

Server-side limits: title 150 characters, description 4,000, comment 2,000, search 100.
Input is trimmed. Dates must be real dates written `YYYY-MM-DD`. All SQL uses `?`
parameters (server-side prepared statements), so user text is never mixed into SQL commands.
MySQL runs in strict mode for the application's connections, so an oversized or invalid value
is rejected instead of being silently cut.

---

## 7. Where the data is stored

Everything is in the MySQL database **`erp_task_tracker`** (or whatever `DB_NAME` says),
inside MySQL's own data folder, managed by the MySQL service. The application has no data files
of its own. The table definitions are in `scripts/schema.mysql.sql`.

| Table | Contents |
| --- | --- |
| `tasks` | One row per task. `deleted_at` is filled in while a task is in Trash |
| `comments` | One row per comment, linked to its task by a foreign key. Deleted together with the task on permanent deletion (`ON DELETE CASCADE`) |
| `app_meta` | Notes for one-time jobs: old data imported, sample tasks added |

Columns of `tasks`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT UNSIGNED`, auto-increment | The number in `ERP-007`, padded to three digits. MySQL 8.0 never reuses a number, even after permanent deletion. After `ERP-999` comes `ERP-1000` |
| `title` | `VARCHAR(150)` | |
| `description` | `TEXT` | |
| `module` | `VARCHAR(100)` | Current or older module name |
| `assignee` | `VARCHAR(50)`, nullable | `NULL` = unassigned |
| `priority` | `ENUM('Low','Medium','High')` | |
| `status` | `ENUM('To Do','In Progress','Blocked','Completed')` | |
| `due_date` | `DATE`, nullable | A calendar day, no timezone |
| `created_at`, `updated_at` | `DATETIME(3)` | UTC, to the millisecond |
| `version` | `INT UNSIGNED` | Increases on every change; used for conflict protection |
| `deleted_at` | `DATETIME(3)`, nullable | Set while in Trash (UTC) |
| `legacy_id` | `VARCHAR(100)`, unique, nullable | The id from the old `tasks.json`, if imported |

How the application handles dates and values:

- **Times** are stored in UTC and shown in Dubai time. The database's own clock
  (`UTC_TIMESTAMP(3)`) stamps every created, updated and deleted time.
- **Due dates** are read from MySQL as plain `YYYY-MM-DD` text, never as JavaScript dates, so
  they cannot shift by a day with the server's timezone. "Overdue" compares the due date with
  today's date in **Asia/Dubai**.
- **Empty values** are real SQL `NULL`s (no assignee, no due date, not deleted), and are sent to
  the browser as JSON `null`.
- **Text** is `utf8mb4`: Arabic, emoji and any other language are stored correctly.
- **Search and equality** use `utf8mb4_unicode_ci`: case-insensitive and accent-insensitive.

The application account has no permission to create, alter or drop anything, and the
application never tries to.

---

## 8. Importing old data and loading sample tasks

**Nothing is imported or seeded automatically**, not at start-up and not by any other
command. The old SQLite file and `tasks.json` are never changed or deleted. Each import is an
explicit command you run once, and each one records itself in the database so it cannot run
twice.

### Old SQLite database (`npm run import-sqlite`)

Use this if the earlier SQLite version of the application holds tasks you want to keep.

1. **Stop the old application** (Ctrl+C) so its file is not being written. The old data is the
   file `erp-tracker.db` in the old `data` folder (you may also see `erp-tracker.db-wal` and
   `erp-tracker.db-shm` next to it; leave them there, they are read too).
2. **Copy `erp-tracker.db`** (and those two files if present) to the machine where the new
   application runs, for example into `D:\task-tracker\data\`. Copy; do not move.
3. **Check what would be imported** (writes nothing):

   ```powershell
   npm run import-sqlite -- --dry-run
   ```

   To use a file from another folder, give its path:
   `npm run import-sqlite -- "D:\old-app\data\erp-tracker.db" --dry-run`.

   ```text
   Dry run: D:\task-tracker\data\erp-tracker.db holds 5 task(s) (0 in Trash) and 2 comment(s). Highest task number: ERP-005.
   Nothing was written. Run the command without --dry-run to import.
   ```

4. **Import:**

   ```powershell
   npm run import-sqlite
   ```

   ```text
   Imported 5 task(s) (0 in Trash) and 2 comment(s) from D:\task-tracker\data\erp-tracker.db.
   The SQLite file was not changed or deleted. Task numbers (ERP-001 ...) are unchanged.
   Check: MySQL now holds 5 task(s) and 2 comment(s) - matches the file.
   ```

What it keeps: task numbers (`ERP-007` stays `ERP-007`), titles, descriptions, modules
(including older module names), assignees, priorities, statuses, due dates, versions, created and
updated times, **Trash state** (tasks in Trash stay in Trash) and all comments with their
times. A task number that was used and then permanently deleted in the old database is not given
to a new task. The markers that record "tasks.json imported" and "sample tasks added" are carried
over so those jobs are not repeated.

How it protects you:

- **One transaction.** If anything fails, nothing at all is saved, and you can simply run it again.
- **Checked first.** Every row is checked against the MySQL columns before anything is written; a
  problem is listed and nothing is imported.
- **No duplicates.** It refuses to run a second time ("already done"), and it refuses to run when
  the MySQL tables already contain tasks or comments, because task numbers are kept.
- **The SQLite file is only copied** to a temporary folder and read from there.

If it says the tables already contain tasks (for example after you tried the application with a few
test tasks), use a fresh empty database, or ask the MySQL administrator to empty the tables first.
*This deletes the data in them:*

```sql
-- ADMINISTRATOR ONLY, as root, in the erp_task_tracker database. Destroys all tasks and comments.
DELETE FROM comments;
DELETE FROM tasks;
DELETE FROM app_meta;
```

(Task numbers then continue after the highest number ever used, so an import after tests may leave
a gap before the next new task.)

### Old tasks from `tasks.json` (`npm run import-legacy`)

The original, simplest version of the application stored tasks in `data/tasks.json`.
This is **no longer imported when the application starts**; run it yourself if you want those tasks:

```powershell
npm run import-legacy
```

| Old field | New value |
| --- | --- |
| `title` | Title (unchanged) |
| `completed: true` | Status **Completed** |
| `completed: false` | Status **To Do** |
| `createdAt` | Created and last-updated time |
| new fields | Category **General / Cross-module**, priority **Medium**, **unassigned**, no due date, empty description |

`tasks.json` is only read. Running the command again does nothing (it says "Already imported"),
and each old task's id is stored with a uniqueness rule, so duplicates cannot happen. If you
already imported your SQLite database, those tasks are already there: do not also run this.

### Older module names

The first version of this tracker used a different, generic module list (for example
*Finance & Accounts* and *Sales & CRM*). When the list was replaced with the real ERP
module names, **no task was changed or deleted**. A task saved under an older name:

- keeps that name, marked **old name** in the table, board and details;
- is still counted in the totals, and appears under *Older names* in the sidebar module
  list and in *Work by module* on the Overview page;
- can still be found with the module filter;
- can be edited freely (status, assignee, comments...) without losing its module.

Older names cannot be chosen for new tasks. Nothing is mapped automatically, because only
the team knows where each task belongs. There are two ways to move tasks to a current name:

1. **One task at a time:** click **Edit**, choose the right module, **Save changes**.
2. **All tasks under one older name together:**

   ```powershell
   npm run backup
   npm run map-module
   npm run map-module -- "Finance & Accounts" "Financials"
   ```

   The second command only lists the older names in use and how many tasks each has. The
   third moves every task (including tasks in Trash) from the first name to the second.
   Use option 1 instead when the tasks under one older name belong to different modules.

Once no task uses an older name, it disappears from the filter and the summary. The older
*General* is kept as an older name rather than being renamed to *General / Cross-module*; map it
with the command above if that is where those tasks belong.

### Sample tasks (optional, for demonstrations only)

```powershell
npm run seed
```

adds 17 example tasks, spread over the four people and several modules, with a few comments and
some overdue dates. The people on the samples are mixed deliberately and do not mean anyone owns a
module. Every title starts with **`[Sample]`**. It never runs automatically and refuses to run
twice on the same database. **It writes into the database named in `.env`, so do not run it on
the database that holds your real tasks.** Remove the samples by moving them to Trash and deleting
them permanently.

For a demo that keeps real data clean, ask the MySQL administrator for a second empty database,
for example `erp_task_tracker_demo`:

```sql
-- ADMINISTRATOR, as root:
CREATE DATABASE erp_task_tracker_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT SELECT, INSERT, UPDATE, DELETE ON erp_task_tracker_demo.* TO 'erp_tracker_app'@'localhost';
```

then apply the schema to it (step 4 of section 2, with `erp_task_tracker_demo` as the database name),
and run, in a PowerShell window you close afterwards:

```powershell
$env:DB_NAME = "erp_task_tracker_demo"
npm run seed
npm start
```

---

## 9. Backing up and restoring

Backups are plain-text `.sql` files made by MySQL's own `mysqldump` tool. They contain the table
definitions and all the data (tasks, comments, Trash, version numbers, the one-time-job markers).

### Back up (safe while the application is running)

```powershell
npm run backup
```

```text
Backup saved: D:\task-tracker\backups\erp_task_tracker-20261117-101500.sql
Size: 14.2 KB. The file ends with MySQL's "Dump completed" marker.
```

- The file name contains the date and time (UTC). The `backups` folder is ignored by Git, because
  backups contain real task data.
- The copy is a consistent snapshot taken in one transaction, so the application can keep running.
- It uses the application's own account (it only needs `SELECT`), so no administrator password is
  needed. The password is handed to `mysqldump` through a temporary file that is deleted straight
  away, never on the command line.
- `mysqldump.exe` comes with MySQL Server. If Windows cannot find it, either add MySQL's `bin`
  folder to PATH for the current window
  (`$env:Path += ";C:\Program Files\MySQL\MySQL Server 8.0\bin"`) or set
  `MYSQLDUMP_PATH='C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe'` in `.env`.
- It checks that the file ends with MySQL's "Dump completed" line before saying it worked.
- **Copy the file to another disk or a network share as well.** A backup on the same disk does not
  protect against disk failure. Schedule it (for example with Windows Task Scheduler) once real
  data is in use.

The same backup by hand, if you prefer (asks for the password). Use `--result-file`, **not** `>`:
PowerShell 5.1's `>` writes the file in the wrong encoding and corrupts non-English text.

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -u erp_tracker_app -p `
  --single-transaction --no-tablespaces --skip-triggers --set-gtid-purged=OFF `
  --default-character-set=utf8mb4 --result-file="D:\task-tracker\backups\manual.sql" erp_task_tracker
```

### Restore (administrator, application stopped)

A backup file starts each table with `DROP TABLE IF EXISTS` and then recreates it, so restoring
**replaces** the current tables. That needs administrator rights; the application's account cannot
do it. Everything saved after the backup was taken is not in it.

1. **Stop the application** (Ctrl+C, or `pm2 stop erp-task-tracker`).
2. **Take a safety backup of the current state first**, in case you need it: `npm run backup`.
3. **Restore**, as the MySQL administrator, from the project folder (asks for the password):

   ```powershell
   $mysql = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
   & $mysql -u root -p --default-character-set=utf8mb4 erp_task_tracker -e "source backups/erp_task_tracker-20261117-101500.sql"
   ```

   (With a path containing spaces, use Command Prompt:
   `"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p --default-character-set=utf8mb4 erp_task_tracker < backups\erp_task_tracker-20261117-101500.sql`.
   Do not use `<` in PowerShell; it is not supported there.)
4. **Check the result:** `npm run db:check`, then start the application with `npm start` and open
   a few tasks.

To practise safely, restore into a scratch database instead (ask the administrator to create an empty
one, and use its name in the command above). A backup you have never restored is not yet a backup.

---

## 10. How PM2, IIS and DNS fit into deployment

Nothing in this project deploys anything or changes Windows, IIS, firewall or network settings.
This section explains the pieces your team lead will set up.

```text
Colleague's browser
      |  1. "Where is erp-tasks.company.local?"
      v
     DNS  ---------->  answers with the server's IP address
      |
      |  2. HTTP(S) request to that IP, port 80/443
      v
     IIS (web server on the Windows VM)
      |  3. forwards the request to http://127.0.0.1:3000   (reverse proxy)
      v
   Node.js app (server.js), kept running by PM2
      |  4. asks MySQL (localhost:3306) for the data
      v
   MySQL service  ->  database erp_task_tracker
```

**Node.js app.** Listens on `127.0.0.1:3000`, which only programs on the same server can
reach. It is never exposed to the network directly. MySQL is used only on the same machine
(`localhost`); the application account is restricted to `localhost`.

**PM2 (process manager).** With plain `npm start` the app stops when the terminal closes
or the app crashes. PM2 runs it in the background, restarts it after a crash and keeps
its logs:

```text
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs erp-task-tracker
```

- **The database password is not in the PM2 file.** The application reads `.env` itself, so the
  secret stays in one place that Git ignores. Do not copy it into `ecosystem.config.cjs`.
- The PM2 file only sets `HOST` and `PORT`; those override `.env`.
- Keep `instances: 1`.
- **If MySQL is not up yet** (for example just after a reboot), the application prints why and
  exits; PM2 waits 5 seconds and tries again, up to 10 times in a row. Make sure the MySQL
  Windows service is set to start automatically.
- On Windows PM2 asks the application to stop with a message (`shutdown_with_message`), so it can
  finish requests and close the MySQL connections cleanly.

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
up and MySQL answers, and `503` when MySQL does not. Use it to test each layer: directly
(`http://127.0.0.1:3000/health` on the server), then through IIS, then through the DNS name.

**Before real use on the server:** schedule `npm run backup` and copy the files off the machine;
restrict who can read the `.env` file to the account that runs Node.js (it contains the
database password); keep the MySQL account at its four permissions; serve the site over HTTPS;
and add login (section 11).

---

## 11. Known limitations

- **No authentication or permissions.** There is no login. Anyone who can reach the site
  can read, change, trash and permanently delete any task. The assignee and comment
  author dropdowns only *record* a chosen name; they do not prove who is at the keyboard.
  **Login and permissions must be added before using this for real company work.**
- **No audit history.** Only the latest version of a task is stored. There is no record
  of who changed what.
- **Schema changes are manual.** There is no migration tool and the application account cannot
  alter tables. A future change to the tables will arrive as an SQL file that an administrator
  applies, like `scripts/schema.mysql.sql` was.
- **MySQL must be running.** If it stops, the website answers "database not reachable" (503)
  until it is back, and the application recovers on its own. If MySQL is down when the application
  *starts*, the application does not start.
- **Team and modules are fixed lists** in `src/constants.js`. Changing them needs a
  restart. Removing or renaming a module does not update existing tasks: they keep the
  older name until mapped (section 8). Removing a team member is not handled the same
  way: their existing tasks stay assigned to them but can no longer be filtered by name.
- **A task has exactly one module or category.** Work touching several modules goes under
  *General / Cross-module* or is split into one task per module.
- **Search ignores case and accents** (it treats `cafe` and `café` alike), because of the
  database collation.
- **Comments cannot be edited or deleted**, except by permanently deleting their task.
- **No real-time updates.** Other people's changes appear after Refresh or within about
  30 seconds. Conflicts are detected when saving, not while typing.
- **Conflict checking is per task**, not per field: two people changing different fields
  of one task at the same moment still get a conflict message (nothing is lost).
- **Trash is never emptied automatically**, and there is no "empty Trash" button.
- **No drag-and-drop** on the board. Use the status dropdown on each card.
- **No file attachments, notifications, or email.**
- **One application process.** Suitable for a small team; not designed for several
  application servers or heavy load.
- **No HTTPS in the app itself.** HTTPS should be provided by IIS.
- **No pagination.** All matching tasks are loaded at once, which is fine for hundreds of
  tasks, not for tens of thousands.

See `DEMO_GUIDE.md` for a short script to demonstrate the app.

---

## 12. Troubleshooting

The application and every script explain database problems in plain words and never print the
password. Typical messages, and what to do:

| Message | Meaning and fix |
| --- | --- |
| `Could not connect to MySQL at localhost:3306 ...` | MySQL is not running or not listening there. Check the service (`Get-Service MySQL80`; starting it needs an administrator: `Start-Service MySQL80`) and `DB_HOST` / `DB_PORT` in `.env`. If only `localhost` fails, try `DB_HOST=127.0.0.1` |
| `MySQL refused the login for user "erp_tracker_app"` | Wrong `DB_USER` or `DB_PASSWORD`. Retype the password in `.env`. If it contains `#`, a space or a quote, wrap it in single quotes. The account only works from `localhost`, so it cannot be used from another computer. If `127.0.0.1` fails but `localhost` works, the administrator must create the account for that host too |
| `The database "..." does not exist` | `DB_NAME` is wrong, or the administrator has not created the database |
| `A required table is missing ... schema.mysql.sql` | The schema was not applied. Run step 4 of section 2 as the administrator |
| `User ... is not allowed to use database` / `lacks a permission it needs on a table` | The account is missing one of `SELECT, INSERT, UPDATE, DELETE` on the database. Check with `SHOW GRANTS FOR 'erp_tracker_app'@'localhost';` as the administrator |
| `.env is saved as UTF-16` | Re-save `.env` as UTF-8 (Notepad: File > Save As > Encoding: UTF-8). Do not create it with `>` in PowerShell 5.1; use `Copy-Item .env.example .env` |
| `Note: DB_FILE is no longer used` | An old `.env` still has the SQLite `DB_FILE` line. Delete that line |
| `Could not start: port 3000 is already in use` | Another copy is running, or another program uses the port. Stop it, or set a different `PORT` |
| `mysqldump was not found` | See section 9: add MySQL's `bin` folder to PATH for the window, or set `MYSQLDUMP_PATH` |
| `The database is not reachable right now` (in the browser) | MySQL stopped or is overloaded while the app was running. Start MySQL; the app reconnects by itself |
| `Origin does not match this site` | The app is behind a proxy that rewrites the host name. See section 10 |
| `The MySQL database already contains N task(s) ...` | `npm run import-sqlite` only imports into empty tables. See section 8 |
