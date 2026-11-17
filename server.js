// Entry point: `npm start` runs this file.
// It reads the settings, opens the database, imports old tasks once, and starts the web server.

const { loadConfig } = require('./src/config');
const { openDatabase } = require('./src/database');
const { importLegacyTasks } = require('./src/legacyImport');
const { createApp } = require('./src/app');
const { APP_NAME } = require('./src/constants');

const config = loadConfig();
const db = openDatabase(config.dbFile);

const legacy = importLegacyTasks(db, config.legacyFile);
if (legacy.status === 'imported') {
  console.log(`Imported ${legacy.imported} task(s) from ${config.legacyFile} (one-time import; the file was not changed).`);
} else if (legacy.status === 'unreadable') {
  console.warn(`Could not import ${config.legacyFile}: ${legacy.message}. Fix the file and restart to try again.`);
}

const app = createApp(db, { logRequests: true, allowedOrigins: config.allowedOrigins });

const server = app.listen(config.port, config.host, () => {
  console.log(`${APP_NAME} is running at http://${config.host}:${config.port}`);
  console.log(`Database file: ${config.dbFile}`);
  console.log('Press Ctrl+C to stop.');
});

server.on('error', error => {
  console.error('Could not start:', error.code === 'EADDRINUSE'
    ? `port ${config.port} is already in use. Stop the other program or set a different PORT.`
    : error.message);
  process.exit(1);
});

// Stop cleanly: finish open requests, then close the database file.
function stop() {
  console.log(`Stopping ${APP_NAME}...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
