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
//
// The MySQL settings and password are NOT written here. The application reads them from the
// .env file in this folder, whichever way it is started. Do not put the password in this file.
module.exports = {
  apps: [{
    name: 'erp-task-tracker',
    cwd: __dirname,
    script: 'server.js',
    instances: 1,            // one process only
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,        // stop retrying if it crashes 10 times in a row (e.g. MySQL is not running)
    min_uptime: '10s',
    restart_delay: 5000,     // wait 5 seconds between restarts, e.g. while the MySQL service is still starting
    time: true,              // timestamps in PM2 logs
    shutdown_with_message: true,   // on Windows, ask the app to stop cleanly (it closes the MySQL pool)
    kill_timeout: 12000,           // the app gives up waiting after 10 seconds
    // Settings for the app when run by PM2. These override the same names in .env.
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',     // only IIS on the same server can reach the app
      PORT: 3000
      // ALLOWED_ORIGINS: 'http://erp-tasks.company.local'
    }
  }]
};
