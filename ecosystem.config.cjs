// Optional PM2 settings. PM2 is a process manager: it starts the app, restarts it if it
// crashes, and collects its logs.
//
//   pm2 start ecosystem.config.cjs     start the app under PM2
//   pm2 status                         see whether it is running
//   pm2 logs erp-task-tracker          see its output
//   pm2 restart erp-task-tracker       restart after changing code or settings
//   pm2 stop erp-task-tracker          stop it
//
// Note: PM2 by itself does NOT start again after Windows reboots. Starting PM2 at boot
// (a Windows service or scheduled task) is a separate deployment step. See the README.
module.exports = {
  apps: [{
    name: 'erp-task-tracker',
    cwd: __dirname,
    script: 'server.js',
    instances: 1,            // one process only: SQLite is a single file with a single writer
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,        // stop retrying if it crashes 10 times in a row (e.g. port in use)
    min_uptime: '10s',
    time: true,              // timestamps in PM2 logs
    // Settings for the app when run by PM2. (PM2 does not read the .env file used by "npm start".)
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',     // only IIS on the same server can reach the app
      PORT: 3000
      // DATA_DIR: 'D:\\erp-tracker-data',
      // ALLOWED_ORIGINS: 'http://erp-tasks.company.local'
    }
  }]
};
