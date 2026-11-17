// Helper for the tests that need a real MySQL server.
//
// Those tests run only when an ADMINISTRATIVE MySQL account is provided through environment
// variables (never stored in the project):
//
//   TEST_DB_ADMIN_USER       e.g. root
//   TEST_DB_ADMIN_PASSWORD   its password
//   TEST_DB_HOST             default: localhost
//   TEST_DB_PORT             default: 3306
//
// They can also be placed in a ".env.test" file in the project folder (ignored by Git).
// Without TEST_DB_ADMIN_USER the MySQL tests are SKIPPED and the other tests still run.
//
// For every test this creates a brand-new database named erp_task_tracker_test_<random>,
// applies scripts/schema.mysql.sql, and creates a temporary account that has ONLY
// SELECT, INSERT, UPDATE and DELETE on that database, exactly like the real application's
// account. Both are dropped afterwards. It never touches erp_task_tracker or any other database.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { loadDotEnv, projectRoot } = require('../../src/config');

loadDotEnv(path.join(projectRoot, '.env.test'));

const settings = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: Number(process.env.TEST_DB_PORT || 3306),
  adminUser: process.env.TEST_DB_ADMIN_USER,
  adminPassword: process.env.TEST_DB_ADMIN_PASSWORD ?? ''
};

const skipReason = settings.adminUser
  ? false
  : 'MySQL integration tests skipped: set TEST_DB_ADMIN_USER and TEST_DB_ADMIN_PASSWORD to run them (see README, "Running the tests").';

const schemaFile = path.join(projectRoot, 'scripts', 'schema.mysql.sql');
const TEST_DATABASE = /^erp_task_tracker_test_[0-9a-f]{8}$/;
const TEST_USER = /^erp_test_[0-9a-f]{8}$/;

async function connectAsAdmin() {
  return mysql.createConnection({
    host: settings.host,
    port: settings.port,
    user: settings.adminUser,
    password: settings.adminPassword,
    multipleStatements: true,      // only here, to apply the schema file; the application never enables this
    charset: 'UTF8MB4_UNICODE_CI'
  });
}

// Creates a fresh, empty test database. With { schema: false } the tables are not created
// (to test the "tables are missing" message).
async function createTestDatabase({ schema = true } = {}) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const database = `erp_task_tracker_test_${suffix}`;
  const user = `erp_test_${suffix}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const admin = await connectAsAdmin();
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (schema) {
      await admin.query(`USE \`${database}\``);
      await admin.query(fs.readFileSync(schemaFile, 'utf8'));
    }
    await admin.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [user, password]);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO ?@'localhost'`, [user]);
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  }

  return {
    database,
    // Settings in the same shape as config.db, for createPool(). The account is DML-only.
    dbConfig: { host: settings.host, port: settings.port, database, user, password, connectionLimit: 5, connectTimeoutMs: 10000 },
    // Runs SQL as the administrator (for setting up or checking test data).
    admin,
    async drop() {
      try {
        if (!TEST_DATABASE.test(database) || !TEST_USER.test(user)) throw new Error('Refusing to drop a database that is not a test database.');
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.query("DROP USER IF EXISTS ?@'localhost'", [user]);
      } finally {
        await admin.end().catch(() => {});
      }
    }
  };
}

module.exports = { settings, skipReason, createTestDatabase };
