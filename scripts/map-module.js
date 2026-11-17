// Moves tasks from an OLDER module name to a current one, only when you ask for it.
//
//   npm run map-module                                   list older names still in use
//   npm run map-module -- "Finance & Accounts" "Financials"   move those tasks
//
// Nothing is ever mapped automatically. Take a backup first: npm run backup

const { runCli, CliError } = require('../src/cli');
const { MODULES } = require('../src/constants');

runCli(async ({ pool }) => {
  const [from, to] = process.argv.slice(2);

  const [inUse] = await pool.execute(`
    SELECT module, COUNT(*) AS total, COALESCE(SUM(deleted_at IS NOT NULL), 0) AS in_trash
    FROM tasks GROUP BY module ORDER BY module
  `);
  const older = inUse.filter(row => !MODULES.includes(row.module));

  if (!from && !to) {
    if (!older.length) {
      console.log('Every task uses a current module name. Nothing needs mapping.');
      return 0;
    }
    console.log('Older module names still used by tasks:\n');
    for (const row of older) {
      console.log(`  "${row.module}"  -  ${row.total} task(s)${Number(row.in_trash) ? `, ${row.in_trash} of them in Trash` : ''}`);
    }
    console.log('\nTo move them to a current module:');
    console.log('  npm run map-module -- "Older name" "Current name"');
    console.log('\nCurrent names:\n  ' + MODULES.join('\n  '));
    return 0;
  }

  if (!from || !to) throw new CliError('Give two names: npm run map-module -- "Older name" "Current name"');
  if (!MODULES.includes(to)) throw new CliError(`"${to}" is not a current module or category. Current names:\n  ${MODULES.join('\n  ')}`);
  if (MODULES.includes(from)) throw new CliError(`"${from}" is a current module, not an older name. To move single tasks, edit them in the app.`);
  if (!older.some(row => row.module === from)) {
    throw new CliError(`No task uses the name "${from}". Run "npm run map-module" to see the older names in use.`);
  }

  // Counts as an edit: the time and version change, so anyone with the task open is told.
  const [result] = await pool.execute(
    'UPDATE tasks SET module = ?, updated_at = UTC_TIMESTAMP(3), version = version + 1 WHERE module = ?',
    [to, from]);
  console.log(`Moved ${result.affectedRows} task(s) from "${from}" to "${to}" (including any in Trash). Refresh the browser to see the change.`);
  return 0;
});
