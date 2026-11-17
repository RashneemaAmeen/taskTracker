// Moves tasks from an OLDER module name to a current one, only when you ask for it.
//
//   npm run map-module                                   list older names still in use
//   npm run map-module -- "Finance & Accounts" "Financials"   move those tasks
//
// Nothing is ever mapped automatically. Take a backup first: npm run backup

const { loadConfig } = require('../src/config');
const { openDatabase, transaction } = require('../src/database');
const { MODULES } = require('../src/constants');

const [from, to] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config.dbFile);

const inUse = db.prepare(`
  SELECT module, COUNT(*) AS total, SUM(deleted_at IS NOT NULL) AS in_trash
  FROM tasks GROUP BY module ORDER BY module
`).all();
const older = inUse.filter(row => !MODULES.includes(row.module));

function finish(message, code = 0) {
  console.log(message);
  db.close();
  process.exit(code);
}

if (!from && !to) {
  if (!older.length) finish('Every task uses a current module name. Nothing needs mapping.');
  console.log('Older module names still used by tasks:\n');
  for (const row of older) {
    console.log(`  "${row.module}"  -  ${row.total} task(s)${row.in_trash ? `, ${row.in_trash} of them in Trash` : ''}`);
  }
  console.log('\nTo move them to a current module:');
  console.log('  npm run map-module -- "Older name" "Current name"');
  finish('\nCurrent names:\n  ' + MODULES.join('\n  '));
}

if (!from || !to) finish('Give two names: npm run map-module -- "Older name" "Current name"', 1);
if (!MODULES.includes(to)) finish(`"${to}" is not a current module or category. Current names:\n  ${MODULES.join('\n  ')}`, 1);
if (MODULES.includes(from)) finish(`"${from}" is a current module, not an older name. To move single tasks, edit them in the app.`, 1);
if (!older.some(row => row.module === from)) {
  finish(`No task uses the name "${from}". Run "npm run map-module" to see the older names in use.`, 1);
}

// Counts as an edit: the time and version change, so anyone with the task open is told.
const changed = transaction(db, () =>
  db.prepare('UPDATE tasks SET module = ?, updated_at = ?, version = version + 1 WHERE module = ?')
    .run(to, new Date().toISOString(), from).changes);

finish(`Moved ${changed} task(s) from "${from}" to "${to}" (including any in Trash). Refresh the browser to see the change.`);
