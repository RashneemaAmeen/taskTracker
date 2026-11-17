// `npm run import-legacy` runs the one-time import of the ORIGINAL app's data/tasks.json
// into MySQL and reports the result. It is never run automatically.
// tasks.json is only read; it is not changed or deleted. Running it again is safe: the
// import is recorded in the database, so nothing is imported twice.

const { runCli } = require('../src/cli');
const { importLegacyTasks } = require('../src/legacyImport');

runCli(async ({ config, pool }) => {
  const result = await importLegacyTasks(pool, config.legacyFile);
  const messages = {
    'imported': `Imported ${result.imported} task(s), skipped ${result.skipped}. ${config.legacyFile} was not changed.`,
    'already-imported': `Already imported on ${result.importedAt} (${result.imported} task(s)). Nothing was changed, so there are no duplicates.`,
    'no-file': `No old task file found at ${config.legacyFile}. Nothing to import.`,
    'unreadable': `Could not read ${config.legacyFile}: ${result.message}`
  };
  console.log(messages[result.status]);
  return result.status === 'unreadable' ? 1 : 0;
});
