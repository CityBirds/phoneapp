const path = require('path');
const fs = require('fs');

let Database;
let isNodeSqlite = false;

try {
  const sqlite = require('node:sqlite');
  if (sqlite && sqlite.DatabaseSync) {
    Database = sqlite.DatabaseSync;
    isNodeSqlite = true;
  }
} catch (e) {}

if (!Database) {
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error('No SQLite driver available (neither node:sqlite nor better-sqlite3)');
  }
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/phoneapp.db');
const targetDir = path.dirname(dbPath);
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const db = new Database(dbPath);

if (!db.pragma) {
  db.pragma = (str) => db.exec('PRAGMA ' + str);
}

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Initialize database schema
const schema = [
  'CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen TEXT, created_at TEXT);',
  'CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, ip TEXT, status TEXT DEFAULT \'OFFLINE\', working_dir TEXT, printers TEXT DEFAULT \'[]\', last_heartbeat TEXT);',
  'CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, model TEXT NOT NULL, type TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL, file_hash TEXT NOT NULL, version TEXT NOT NULL, field_mappings TEXT DEFAULT \'{}\', published_at TEXT);',
  'CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL, worker_id TEXT, model TEXT NOT NULL, device_sn TEXT NOT NULL, status TEXT NOT NULL, accepted_at TEXT NOT NULL, completed_at TEXT, form_data TEXT DEFAULT \'{}\', error_msg TEXT, retry_count INTEGER DEFAULT 0, cancelled_by TEXT);',
  'CREATE TABLE IF NOT EXISTS task_files (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, file_type TEXT NOT NULL, official_filename TEXT NOT NULL, worker_filepath TEXT, server_filepath TEXT, sha256 TEXT, preview_images TEXT DEFAULT \'[]\', status TEXT NOT NULL, error_msg TEXT, FOREIGN KEY(task_id) REFERENCES tasks(id));',
  'CREATE TABLE IF NOT EXISTS print_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, worker_id TEXT NOT NULL, printer_name TEXT NOT NULL, batch_items TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT, client_id TEXT, client_name TEXT, action TEXT NOT NULL, details TEXT, timestamp TEXT NOT NULL);'
].join('\n');

db.exec(schema);

module.exports = db;
