-- ERP Rebuild Task Tracker - MySQL 8.0 schema
--
-- Apply this file ONCE, with an ADMINISTRATIVE MySQL account (for example root), to the
-- empty database that was created for the application. The running application never
-- creates or changes tables: its account only needs SELECT, INSERT, UPDATE and DELETE.
--
-- PowerShell or Command Prompt, from the project folder (you are asked for the password):
--
--   mysql -u root -p --default-character-set=utf8mb4 erp_task_tracker -e "source scripts/schema.mysql.sql"
--
-- The database name is given on the command line on purpose, so this file cannot be
-- applied to the wrong database by accident. This script only uses CREATE TABLE IF NOT
-- EXISTS: it never drops, truncates or alters anything, so running it twice is harmless.
--
-- Notes
--   * All timestamps are stored in UTC as DATETIME(3). The application converts them to
--     ISO strings for the browser and shows them in Dubai time.
--   * due_date is a DATE: a calendar day with no time and no timezone.
--   * "Overdue" is calculated by the application against today's date in Asia/Dubai.
--   * Task references such as ERP-001 are the task id padded to three digits. AUTO_INCREMENT
--     counters are never reused in MySQL 8.0, so a permanently deleted number stays unused.
--   * The text file uses plain ASCII characters only, so it is safe with any client charset.

SET NAMES utf8mb4;

-- One row per task. A task in Trash has deleted_at set; it is restored by clearing it.
CREATE TABLE IF NOT EXISTS tasks (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(150) NOT NULL,
  description TEXT NOT NULL DEFAULT (''),
  module      VARCHAR(100) NOT NULL,
  assignee    VARCHAR(50) NULL DEFAULT NULL,
  priority    ENUM('Low', 'Medium', 'High') NOT NULL,
  status      ENUM('To Do', 'In Progress', 'Blocked', 'Completed') NOT NULL,
  due_date    DATE NULL DEFAULT NULL,
  created_at  DATETIME(3) NOT NULL,
  updated_at  DATETIME(3) NOT NULL,
  version     INT UNSIGNED NOT NULL DEFAULT 1,
  deleted_at  DATETIME(3) NULL DEFAULT NULL,
  legacy_id   VARCHAR(100) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tasks_legacy_id (legacy_id),
  KEY idx_tasks_deleted_status (deleted_at, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comments belong to a task and are removed with it (permanent deletion only).
CREATE TABLE IF NOT EXISTS comments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id    INT UNSIGNED NOT NULL,
  author     VARCHAR(50) NOT NULL,
  body       TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_comments_task (task_id, id),
  CONSTRAINT fk_comments_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Small key/value table that records one-time jobs (old-data imports, sample data) so they
-- are never repeated. (The columns are called meta_key / meta_value because KEY is a
-- reserved word in MySQL.)
CREATE TABLE IF NOT EXISTS app_meta (
  meta_key   VARCHAR(100) NOT NULL,
  meta_value TEXT NOT NULL,
  PRIMARY KEY (meta_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
