# Demo guide (about 10 minutes)

A short script for showing the ERP Rebuild Task Tracker to your team lead.

## Before the demo

1. Make sure nothing else is using port 3000 (stop the old Task Tracker with Ctrl+C).
2. Decide which data to show:
   - **Your real tasks:** `npm start`
   - **A separate demo database with examples** (recommended, keeps real data clean):

     ```powershell
     $env:DATA_DIR = "demo-data"
     npm run seed
     npm start
     ```

3. Open <http://localhost:3000>. Keep the VS Code terminal visible: each request is
   logged there, which helps explain what the backend is doing.

## 1. Summary and Overview (1 minute)

- On the **Tasks** page, point out the summary strip (Total, In Progress, Completed,
  Overdue) and the label **"Counts cover all tasks"**.
- Explain *Overdue*: due before today in Dubai time and not completed. A task marked
  **Due today** is not counted as overdue.
- Click **Overview** in the sidebar. Show the **Team workload** rows: pending, completed
  and a completion bar per person.
- Below them, **Work by module**: one row per ERP module and cross-module category. Mention
  that modules are not owned by anyone; every task is assigned by hand.
- Click **Tasks** in the sidebar to go back.

## 2. Assign a task (1 minute)

1. Click **+ New task** (top right).
2. Title: `Design purchase order screen`. Module: *Purchase* (point out the real ERP
   module names, then the four cross-module categories). Assigned to: *Thameem*. Priority: *High*. Due date: yesterday's date.
3. Click **Add task**.
4. Show the new reference (for example `ERP-017`), the **Overdue** label, and that the
   Overdue number in the strip and Thameem's count in the sidebar each went up by one.
5. Optional: click **Add task** with an empty title to show validation.

## 3. Change status and reassign (1 minute)

1. In the table, change the task's **Status** dropdown to *In Progress*. Note the message
   and the In Progress number in the strip.
2. Click **Edit**, change *Assigned to* to *Mausooq*, click **Save changes**. The team
   counts in the sidebar update.
3. Switch to **Board** (the Table / Board switch above the list): same tasks, grouped by
   status. Change a task's status with its dropdown and watch it move column.

## 4. Comments (1 minute)

1. Click a task title to open its details.
2. Under **Comments**, choose a name, type `Waiting for the supplier field list.` and
   click **Add comment**. It appears with name and time, oldest first.
3. Say clearly: the name is chosen from a list and is **not verified**, because there is
   no login yet.

## 5. Search and filters (1 minute)

1. Type `invoice` in **Search**: the list and the strip update, and the label changes to
   **"Counts cover filtered results only"**.
2. Add **Assigned to** and **Status** filters to show they combine.
3. Tick **Overdue only**.
4. Search for `zzz` to show the "no tasks match" message, then click **Clear filters**.
5. Click a person under **Team** in the sidebar, or a module under **Modules**: shortcuts
   for the same filters. Click again to remove the filter.
6. Optional: narrow the browser window to show the sidebar turning into a **Menu** button.

## 6. Trash and restore (1 minute)

1. Click **Move to Trash** on a task and confirm. It leaves the list and the counts.
2. Open **Trash** (sidebar). Show the task and its *Moved to Trash* date.
3. Click **Restore**, go back to **Tasks**, open the task: details and comments are intact.
4. Explain the difference: **Move to Trash** can be undone; **Delete permanently** exists
   only inside Trash, asks again with a red button, and cannot be undone.

## 7. Two people editing the same task (1 minute, optional)

1. Open the app in **two browser tabs**.
2. In both tabs click **Edit** on the same task.
3. Tab 1: change the status, **Save changes**.
4. Tab 2: change the title, **Save changes**. Tab 2 shows *"Someone else changed ERP-…
   while you were editing"*, lists what changed, and offers **Load their version** or
   **Keep my edits and save**. Nothing was overwritten silently.

## 8. An API response (1 minute)

Open these in a new browser tab:

- <http://localhost:3000/health> — the health check a process manager or IIS can use.
- <http://localhost:3000/api/tasks?status=In%20Progress> — the JSON the page is built from.
- <http://localhost:3000/api/dashboard> — the numbers behind the cards.

Or, in a second terminal:

```powershell
Invoke-RestMethod http://localhost:3000/api/tasks/ERP-001
```

Explain: the browser page is only a client of this API. `public/app.js` calls these
addresses with `fetch` and draws the result.

## 9. Persistence after a restart (1 minute)

1. Note a task you just changed (reference and status).
2. In the terminal press **Ctrl+C**. Refresh the browser: the page says it cannot reach
   the server.
3. Run `npm start` again and refresh. Everything is still there, including comments and
   Trash.
4. Explain: data is in the SQLite file `data/erp-tracker.db` on the server, not in the
   browser. Point out in the terminal that the old-task import did **not** run again.
5. Optional: run `npm run backup` and show the file created in `backups/`.

## 10. Lead into the deployment lesson

- Today the app stops when the terminal closes. A **process manager (PM2)** keeps it
  running and restarts it after a crash: `pm2 start ecosystem.config.cjs`.
- The app listens only on `127.0.0.1:3000`. **IIS** would receive requests from
  colleagues and forward them to it.
- **DNS** gives the server a name such as `erp-tasks.company.local`.
- Starting automatically after a Windows reboot is a separate step that PM2 alone does
  not do.
- State the main limitation yourself: **there is no login or permissions yet**, so this
  is not ready for real company data until that is added.

Good questions to ask your team lead: Where should the database folder live on the
server? Which account will run Node.js? How will the app start after a reboot? Who makes
the DNS record? How will backups be scheduled?

## Automated checks you can show

```text
npm test
```

runs 12 API tests (validation, filters, overdue rules, comments, Trash, conflicts,
one-time import, module names) against a temporary database in a few seconds.
