// `npm run import-sqlite` copies the data from an OLD SQLite database (the file the
// application used before it moved to MySQL) into MySQL, ONE TIME, and only when you ask.
//
//   npm run import-sqlite -- --dry-run                    check the default file, write nothing
//   npm run import-sqlite                                 import data\erp-tracker.db
//   npm run import-sqlite -- "D:\old\erp-tracker.db"      import a file from another place
//
// What it keeps: task ids (so ERP-007 stays ERP-007), titles, descriptions, modules,
// assignees, priorities, statuses, due dates, versions, timestamps, Trash state and comments.
// What it never does: change or delete the SQLite file, or run when the application starts.
// Stop the application first. See the README ("Importing old data").

const { runCli, CliError } = require('../src/cli');
const { importSqliteFile, ImportProblem } = require('../src/sqliteImport');

runCli(async ({ config, pool }) => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const unknown = args.filter(arg => arg.startsWith('--') && arg !== '--dry-run');
  if (unknown.length) throw new CliError(`Unknown option ${unknown[0]}. The only option is --dry-run.`);
  const file = args.find(arg => !arg.startsWith('--')) || config.sqliteFile;

  let result;
  try {
    result = await importSqliteFile(pool, file, { dryRun });
  } catch (error) {
    if (error instanceof ImportProblem) throw new CliError(error.message);
    throw error;
  }

  const describe = r => `${r.tasks} task(s) (${r.inTrash} in Trash) and ${r.comments} comment(s)`;
  switch (result.status) {
    case 'dry-run':
      console.log(`Dry run: ${file} holds ${describe(result)}. Highest task number: ERP-${String(result.highestTaskId).padStart(3, '0')}.`);
      console.log('Nothing was written. Run the command without --dry-run to import.');
      return 0;
    case 'already-imported':
      console.log(`An SQLite import was already done on ${result.importedAt} (${describe(result)}). Nothing was changed, so there are no duplicates.`);
      return 0;
    case 'target-not-empty':
      console.error(`The MySQL database already contains ${result.tasks} task(s) and ${result.comments} comment(s), so nothing was imported.`);
      console.error('To avoid mixing or duplicating data, this command only imports into empty tables. Use a fresh database, or remove the test tasks first (see the README).');
      return 1;
    default: {
      console.log(`Imported ${describe(result)} from ${file}.`);
      console.log('The SQLite file was not changed or deleted. Task numbers (ERP-001 ...) are unchanged.');
      const [[after]] = await pool.execute('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM comments) AS comments');
      const ok = Number(after.tasks) === result.tasks && Number(after.comments) === result.comments;
      console.log(`Check: MySQL now holds ${after.tasks} task(s) and ${after.comments} comment(s) - ${ok ? 'matches the file' : 'DOES NOT MATCH, please investigate'}.`);
      return ok ? 0 : 1;
    }
  }
});
