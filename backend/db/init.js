const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.TASKBOARD_DB_PATH || path.join(DATA_DIR, 'taskboard.db');

function getDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === column);
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      due_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
    );
  `);

  // Migration for databases created before default-column tracking existed
  if (!tableHasColumn(db, 'columns', 'is_default')) {
    db.exec('ALTER TABLE columns ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');

    // Backfill: only flag the original three default columns when a board
    // still has all three at their seeded positions with the seeded names.
    db.exec(`
      UPDATE columns SET is_default = 1
      WHERE position IN (0, 1, 2)
        AND name IN ('To Do', 'In Progress', 'Done')
        AND board_id IN (
          SELECT board_id FROM columns
          GROUP BY board_id
          HAVING SUM(CASE WHEN position = 0 AND name = 'To Do' THEN 1 ELSE 0 END) = 1
             AND SUM(CASE WHEN position = 1 AND name = 'In Progress' THEN 1 ELSE 0 END) = 1
             AND SUM(CASE WHEN position = 2 AND name = 'Done' THEN 1 ELSE 0 END) = 1
        )
    `);
  }

  return db;
}

module.exports = { getDb, initDb, DB_PATH };
