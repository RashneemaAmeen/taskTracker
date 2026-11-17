// Shared start-up and error handling for the command-line scripts in /scripts.
// Each script describes only its own job; this loads the .env file, reads the settings,
// connects to MySQL, prints clear errors (never passwords) and always closes the pool.

const { loadConfig, loadDotEnv } = require('./config');
const { createPool, verifyDatabase, closePool, describeDatabaseError } = require('./database');

// A message for the person running the script, printed without a stack trace.
class CliError extends Error {}

// main({ config, pool }) returns an exit code (or nothing for 0).
async function runCli(main) {
  let pool;
  let config;
  try {
    loadDotEnv();
    config = loadConfig();
    pool = createPool(config.db);
    await verifyDatabase(pool);
    process.exitCode = (await main({ config, pool })) || 0;
  } catch (error) {
    if (error instanceof CliError || !error.code) console.error(error.message);
    else console.error(describeDatabaseError(error, config?.db));
    process.exitCode = 1;
  } finally {
    if (pool) await closePool(pool).catch(() => {});
  }
}

module.exports = { runCli, CliError };
