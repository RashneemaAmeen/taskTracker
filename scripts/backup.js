// `npm run backup` saves a complete copy of the MySQL database as a .sql file in the
// backups folder, using MySQL's own mysqldump tool. It is safe to run while the application
// is running (the copy is a consistent snapshot taken in one transaction).
//
// It uses the application's own account (SELECT is enough), so no administrator password is
// needed. The password is handed to mysqldump through a temporary file that is deleted
// straight afterwards, never on the command line, where other programs could see it.
//
// mysqldump must be installed (it comes with MySQL Server). If Windows cannot find it, put its
// folder on PATH, or set MYSQLDUMP_PATH in .env (see the README).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCli, CliError } = require('../src/cli');

// Values inside double quotes in a MySQL option file need \ and " escaped.
const quoteOption = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function runDump(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, errors: errors.trim() }));
  });
}

runCli(async ({ config }) => {
  const { db } = config;
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(config.backupDir, `${db.database}-${stamp}.sql`);

  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-backup-'));
  try {
    const optionFile = path.join(secretsDir, 'client.cnf');
    fs.writeFileSync(optionFile, [
      '[client]',
      `host=${quoteOption(db.host)}`,
      `port=${db.port}`,
      `user=${quoteOption(db.user)}`,
      `password=${quoteOption(db.password)}`
    ].join('\n') + '\n', { mode: 0o600 });

    let result;
    try {
      result = await runDump(config.mysqldumpPath, [
        `--defaults-extra-file=${optionFile}`,     // must be the first option
        '--single-transaction',                    // consistent snapshot without locking tables
        '--no-tablespaces',                        // does not need the PROCESS privilege
        '--skip-triggers',                         // does not need the TRIGGER privilege (there are none)
        '--set-gtid-purged=OFF',                   // the file restores on any server, with or without GTID
        '--default-character-set=utf8mb4',
        `--result-file=${target}`,
        db.database
      ]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new CliError(`mysqldump was not found ("${config.mysqldumpPath}"). Add the "bin" folder of your MySQL installation to PATH, or set MYSQLDUMP_PATH in .env (see the README).`);
      }
      throw error;
    }
    if (result.code !== 0) {
      fs.rmSync(target, { force: true });         // never leave a half-written backup behind
      throw new CliError(`mysqldump failed (exit code ${result.code}):\n${result.errors || '(no message)'}`);
    }
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }

  // A complete dump ends with a "Dump completed" comment. Check it before reporting success.
  const size = fs.statSync(target).size;
  const tail = fs.readFileSync(target).subarray(-300).toString('utf8');
  if (!tail.includes('-- Dump completed')) {
    throw new CliError(`The backup file ${target} looks incomplete. Do not rely on it.`);
  }
  console.log(`Backup saved: ${target}`);
  console.log(`Size: ${(size / 1024).toFixed(1)} KB. The file ends with MySQL's "Dump completed" marker.`);
  console.log('Copy it to another disk or a network share as well. See the README for how to restore it.');
  return 0;
});
