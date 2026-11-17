// `npm run import-legacy` runs the one-time tasks.json import by hand and reports the result.
// The app also runs this automatically at startup, so normally you do not need this command.

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/database');
const { importLegacyTasks } = require('../src/legacyImport');

const config = loadConfig();
const db = openDatabase(config.dbFile);
const result = importLegacyTasks(db, config.legacyFile);
db.close();

const messages = {
  'imported': `Imported ${result.imported} task(s), skipped ${result.skipped}. ${config.legacyFile} was not changed.`,
  'already-imported': `Already imported on ${result.importedAt} (${result.imported} task(s)). Nothing was changed, so there are no duplicates.`,
  'no-file': `No old task file found at ${config.legacyFile}. Nothing to import.`,
  'unreadable': `Could not read ${config.legacyFile}: ${result.message}`
};
console.log(messages[result.status]);
if (result.status === 'unreadable') process.exit(1);
