// `npm run db:check` tests the MySQL settings in .env WITHOUT starting the web application.
// It logs in, checks that the tables exist and shows how many rows they hold.
// It only reads data. The password is never printed.

const { runCli } = require('../src/cli');
const { REQUIRED_TABLES } = require('../src/database');

runCli(async ({ config, pool }) => {
  const { db } = config;
  const [[info]] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS account');
  console.log(`Connected to MySQL ${info.version} at ${db.host}:${db.port}`);
  console.log(`  database: ${info.db}`);
  console.log(`  account : ${info.account}`);
  console.log('Tables:');
  for (const table of REQUIRED_TABLES) {
    const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM \`${table}\``);     // fixed table names
    console.log(`  ${table.padEnd(9)} ${row.total} row(s)`);
  }
  const [[trashed]] = await pool.query('SELECT COUNT(*) AS total FROM tasks WHERE deleted_at IS NOT NULL');
  console.log(`  (${trashed.total} task(s) are in Trash)`);
  console.log('Everything the application needs at start-up is in place.');
  return 0;
});
