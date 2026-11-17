// Entry point: `npm start` runs this file.
// It reads the settings (.env), checks that MySQL is reachable and the tables exist, and only
// then starts accepting web requests. It never imports, seeds or changes the database:
// those are explicit commands (see the README).

const { loadConfig, loadDotEnv } = require('./src/config');
const { createPool, verifyDatabase, closePool, describeDatabaseError } = require('./src/database');
const { createApp } = require('./src/app');
const { APP_NAME } = require('./src/constants');

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const { db } = config;

  if (process.env.DB_FILE) {
    console.warn('Note: DB_FILE is no longer used. The application now stores its data in MySQL (see DB_* in .env).');
  }

  // 1. Connect to MySQL and check the tables BEFORE listening for web requests.
  console.log(`Connecting to MySQL database "${db.database}" at ${db.host}:${db.port} as "${db.user}"...`);
  const pool = createPool(db);
  try {
    await verifyDatabase(pool);
  } catch (error) {
    console.error(`Could not start: ${describeDatabaseError(error, db)}`);
    await closePool(pool).catch(() => {});
    process.exit(1);
  }
  console.log('MySQL connection OK.');

  // 2. Start the web server.
  const app = createApp(pool, { logRequests: true, allowedOrigins: config.allowedOrigins });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(config.port, config.host);
      listening.once('listening', () => resolve(listening));
      listening.once('error', reject);
    });
  } catch (error) {
    console.error('Could not start:', error.code === 'EADDRINUSE'
      ? `port ${config.port} is already in use. Stop the other program or set a different PORT.`
      : error.message);
    await closePool(pool).catch(() => {});
    process.exit(1);
  }
  server.on('error', error => console.error('Server error:', error.message));
  console.log(`${APP_NAME} is running at http://${config.host}:${config.port}`);
  console.log('Press Ctrl+C to stop.');

  // 3. Stop cleanly: finish open requests, then close the MySQL connections.
  let stopping = false;
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping ${APP_NAME} (${reason})...`);
    setTimeout(() => process.exit(1), 10000).unref();      // do not hang forever
    await new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
    try {
      await closePool(pool);
      console.log('MySQL connection pool closed.');
    } catch (error) {
      console.error('Could not close the MySQL pool cleanly:', error.message);
    }
    process.exit(0);
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGBREAK', () => stop('SIGBREAK'));           // Windows: closing the console window
  process.on('message', message => { if (message === 'shutdown') stop('shutdown message'); });   // PM2 on Windows
}

main().catch(error => {
  console.error('Could not start:', error.message);
  process.exit(1);
});
