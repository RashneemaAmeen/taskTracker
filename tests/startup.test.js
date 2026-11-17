// Start-up and shutdown of server.js, run as a real child process.
//
// The first test needs no MySQL server (it points the application at a closed port). The
// others need TEST_DB_ADMIN_USER and are skipped without it (see tests/helpers/mysqlTestDb.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { projectRoot } = require('../src/config');
const { skipReason, createTestDatabase } = require('./helpers/mysqlTestDb');

const mysqlTest = (name, run) => test(name, { skip: skipReason }, run);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts `node server.js` with exactly the given settings. Real environment variables win over
// any .env file, so the developer's own .env cannot change what these tests do.
function runServer(settings) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', ...settings },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  // "close" (not "exit") fires only after all the output has been read.
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  const waitForOutput = async (pattern, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (pattern.test(output)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
  return { child, exited, output: () => output, waitForOutput };
}

const databaseSettings = (database, overrides = {}) => ({
  DB_HOST: database.dbConfig.host,
  DB_PORT: String(database.dbConfig.port),
  DB_NAME: database.database,
  DB_USER: database.dbConfig.user,
  DB_PASSWORD: database.dbConfig.password,
  ...overrides
});

const portIsClosed = port => new Promise(resolve => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});

test('start-up stops with a clear message, and no web server, when MySQL cannot be reached', async () => {
  const secret = 'S3cret-Passw0rd!';
  const closedDatabasePort = await freePort();
  const webPort = await freePort();
  const server = runServer({
    PORT: String(webPort), DB_HOST: '127.0.0.1', DB_PORT: String(closedDatabasePort),
    DB_NAME: 'erp_task_tracker', DB_USER: 'erp_tracker_app', DB_PASSWORD: secret
  });
  const { code } = await server.exited;
  const text = server.output();
  assert.equal(code, 1);
  assert.match(text, /Could not start: Could not connect to MySQL at 127\.0\.0\.1:\d+\. Check that the MySQL service is running/);
  assert.ok(!text.includes(secret), 'the password never appears in the output');
  assert.doesNotMatch(text, /is running at/);
  assert.equal(await portIsClosed(webPort), true, 'the web server never started listening');
});

mysqlTest('start-up stops, without printing the password, when the login is refused', async () => {
  const database = await createTestDatabase();
  try {
    const wrong = 'definitely-the-wrong-Passw0rd';
    const server = runServer({ PORT: String(await freePort()), ...databaseSettings(database, { DB_PASSWORD: wrong }) });
    const { code } = await server.exited;
    assert.equal(code, 1);
    assert.match(server.output(), new RegExp(`MySQL refused the login for user "${database.dbConfig.user}"`));
    assert.ok(!server.output().includes(wrong));
    assert.ok(!server.output().includes(database.dbConfig.password));
    assert.doesNotMatch(server.output(), /is running at/);
  } finally {
    await database.drop();
  }
});

mysqlTest('start-up stops with the instruction to apply the schema when the tables are missing', async () => {
  const database = await createTestDatabase({ schema: false });
  try {
    const server = runServer({ PORT: String(await freePort()), ...databaseSettings(database) });
    const { code } = await server.exited;
    assert.equal(code, 1);
    assert.match(server.output(), /A required table is missing/);
    assert.match(server.output(), /scripts\/schema\.mysql\.sql/);
    assert.doesNotMatch(server.output(), /is running at/);
    // The application account cannot create tables, and it did not try: the database is still empty.
    const [tables] = await database.admin.query(`SHOW TABLES FROM \`${database.database}\``);
    assert.equal(tables.length, 0);
  } finally {
    await database.drop();
  }
});

mysqlTest('start-up serves requests, imports nothing by itself, and shuts down cleanly closing the MySQL pool', async () => {
  const database = await createTestDatabase();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-startup-data-'));
  // An old tasks.json is sitting in the data folder. Starting the application must NOT import it.
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify([{ id: 'x1', title: 'old task', completed: false }]));
  const port = await freePort();
  const server = runServer({ PORT: String(port), DATA_DIR: dataDir, ...databaseSettings(database) });
  try {
    assert.ok(await server.waitForOutput(/is running at http:\/\/127\.0\.0\.1:\d+/), `server did not start:\n${server.output()}`);
    assert.match(server.output(), /MySQL connection OK\./);

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'ok');

    const list = await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json();
    assert.equal(list.count, 0, 'tasks.json was not imported at start-up');
    const [[meta]] = await database.admin.query(`SELECT COUNT(*) AS total FROM \`${database.database}\`.app_meta`);
    assert.equal(meta.total, 0, 'start-up wrote nothing to the database');

    // The browser page itself is served too.
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ERP Rebuild Task Tracker/);

    server.child.send('shutdown');                    // what PM2 sends on Windows
    const { code } = await server.exited;
    assert.equal(code, 0);
    assert.match(server.output(), /Stopping ERP Rebuild Task Tracker \(shutdown message\)/);
    assert.match(server.output(), /MySQL connection pool closed\./);
    assert.equal(await portIsClosed(port), true);
  } finally {
    if (server.child.exitCode === null) server.child.kill();
    await database.drop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

mysqlTest('start-up reports a busy web port clearly and releases MySQL', async () => {
  const database = await createTestDatabase();
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  try {
    const server = runServer({ PORT: String(port), ...databaseSettings(database) });
    const { code } = await server.exited;
    assert.equal(code, 1);
    assert.match(server.output(), new RegExp(`Could not start: port ${port} is already in use`));
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    await database.drop();
  }
});
