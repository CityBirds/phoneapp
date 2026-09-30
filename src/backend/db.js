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
  'CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, aliases TEXT DEFAULT \'[]\', created_at TEXT);',
  'CREATE TABLE IF NOT EXISTS published_bundles (id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL, version TEXT NOT NULL, model_id TEXT NOT NULL, model_display TEXT NOT NULL, option_name TEXT DEFAULT \'通用\', doc_combo TEXT NOT NULL, cert_template_id TEXT, packing_template_id TEXT, status TEXT DEFAULT \'PUBLISHED\', published_at TEXT, config_snapshot TEXT DEFAULT \'{}\');',
  'CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL, worker_id TEXT, model TEXT NOT NULL, model_id TEXT, bundle_id TEXT, device_sn TEXT NOT NULL, status TEXT NOT NULL, accepted_at TEXT NOT NULL, completed_at TEXT, form_data TEXT DEFAULT \'{}\', error_msg TEXT, retry_count INTEGER DEFAULT 0, cancelled_by TEXT);',
  'CREATE TABLE IF NOT EXISTS task_files (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, file_type TEXT NOT NULL, official_filename TEXT NOT NULL, worker_filepath TEXT, server_filepath TEXT, sha256 TEXT, preview_images TEXT DEFAULT \'[]\', status TEXT NOT NULL, error_msg TEXT, target_dir TEXT, root_dir TEXT, subfolder_name TEXT, dir_config_id INTEGER, dir_config_version INTEGER, FOREIGN KEY(task_id) REFERENCES tasks(id));',
  'CREATE TABLE IF NOT EXISTS print_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, worker_id TEXT NOT NULL, printer_name TEXT NOT NULL, batch_items TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT, client_id TEXT, client_name TEXT, action TEXT NOT NULL, details TEXT, timestamp TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS worker_allowed_paths (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, root_path TEXT NOT NULL, allow_read INTEGER NOT NULL DEFAULT 1, allow_write INTEGER NOT NULL DEFAULT 1, allow_create INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, sync_status TEXT NOT NULL DEFAULT \'SYNCED\', check_status TEXT NOT NULL DEFAULT \'PENDING\', check_message TEXT, checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(worker_id, root_path));',
  'CREATE TABLE IF NOT EXISTS worker_save_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, template_id TEXT NOT NULL, doc_type TEXT NOT NULL, root_dir TEXT NOT NULL, save_mode TEXT NOT NULL DEFAULT \'direct\', subfolder_rule TEXT DEFAULT \'deviceSn\', allow_create INTEGER NOT NULL DEFAULT 0, is_enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, check_status TEXT NOT NULL DEFAULT \'PENDING\', check_message TEXT, checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(worker_id, template_id, doc_type));',
  'CREATE TABLE IF NOT EXISTS worker_directory_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, check_type TEXT NOT NULL DEFAULT \'save_config\', target_id INTEGER, config_id INTEGER, worker_id TEXT NOT NULL, version INTEGER NOT NULL, root_dir TEXT NOT NULL, allow_create INTEGER NOT NULL DEFAULT 0, allow_read INTEGER NOT NULL DEFAULT 1, allow_write INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT \'PENDING\', created_at TEXT NOT NULL);'
].join('\n');

db.exec(schema);
try { db.exec('ALTER TABLE templates ADD COLUMN draft_mappings TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE task_files ADD COLUMN target_dir TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE task_files ADD COLUMN root_dir TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE task_files ADD COLUMN subfolder_name TEXT;'); } catch (e) {}
try { db.exec('ALTER TABLE task_files ADD COLUMN dir_config_id INTEGER;'); } catch (e) {}
try { db.exec('ALTER TABLE task_files ADD COLUMN dir_config_version INTEGER;'); } catch (e) {}


try { db.exec('ALTER TABLE worker_allowed_paths ADD COLUMN allow_create INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
try { db.exec('ALTER TABLE worker_save_configs ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
try { db.exec("ALTER TABLE worker_directory_checks ADD COLUMN check_type TEXT NOT NULL DEFAULT 'save_config';"); } catch (e) {}
try { db.exec('ALTER TABLE worker_directory_checks ADD COLUMN target_id INTEGER;'); } catch (e) {}
try { db.exec('ALTER TABLE worker_directory_checks ADD COLUMN allow_read INTEGER NOT NULL DEFAULT 1;'); } catch (e) {}
try { db.exec('ALTER TABLE worker_directory_checks ADD COLUMN allow_write INTEGER NOT NULL DEFAULT 1;'); } catch (e) {}

// Migration for worker_directory_checks: Ensure config_id is NULLABLE (for allowed_path checks)
try {
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_directory_checks'").get();
  if (tableCheck) {
    const tableInfo = db.prepare('PRAGMA table_info(worker_directory_checks)').all();
    const configIdCol = tableInfo.find(c => c.name === 'config_id');
    if (configIdCol && configIdCol.notnull === 1) {
      const colNames = new Set(tableInfo.map(c => c.name));
      const checkTypeExpr = colNames.has('check_type') ? "COALESCE(check_type, 'save_config')" : "'save_config'";
      const targetIdExpr = colNames.has('target_id') ? "COALESCE(target_id, config_id)" : "config_id";
      const allowCreateExpr = colNames.has('allow_create') ? "COALESCE(allow_create, 0)" : "0";
      const allowReadExpr = colNames.has('allow_read') ? "COALESCE(allow_read, 1)" : "1";
      const allowWriteExpr = colNames.has('allow_write') ? "COALESCE(allow_write, 1)" : "1";
      const statusExpr = colNames.has('status') ? "COALESCE(status, 'PENDING')" : "'PENDING'";

      db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE worker_directory_checks_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          check_type TEXT NOT NULL DEFAULT 'save_config',
          target_id INTEGER,
          config_id INTEGER,
          worker_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          root_dir TEXT NOT NULL,
          allow_create INTEGER NOT NULL DEFAULT 0,
          allow_read INTEGER NOT NULL DEFAULT 1,
          allow_write INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'PENDING',
          created_at TEXT NOT NULL
        );
        INSERT INTO worker_directory_checks_migrated (
          id, check_type, target_id, config_id, worker_id, version,
          root_dir, allow_create, allow_read, allow_write, status, created_at
        )
        SELECT
          id,
          ${checkTypeExpr},
          ${targetIdExpr},
          config_id,
          worker_id,
          version,
          root_dir,
          ${allowCreateExpr},
          ${allowReadExpr},
          ${allowWriteExpr},
          ${statusExpr},
          created_at
        FROM worker_directory_checks;
        DROP TABLE worker_directory_checks;
        ALTER TABLE worker_directory_checks_migrated RENAME TO worker_directory_checks;
        COMMIT;
      `);
      console.log('[DB Migration] Migrated worker_directory_checks: config_id is now nullable.');
    }
  }
} catch (migErr) {
  console.error('[DB Migration Error]', migErr.message);
}

// Recover orphan CHECKING records without active tasks (FIX-09)
try {
  const checkingPaths = db.prepare("SELECT * FROM worker_allowed_paths WHERE check_status = 'CHECKING'").all();
  for (const p of checkingPaths) {
    const activeTask = db.prepare("SELECT id FROM worker_directory_checks WHERE check_type = 'allowed_path' AND target_id = ? AND status IN ('PENDING', 'PROCESSING')").get(p.id);
    if (!activeTask) {
      db.prepare("UPDATE worker_allowed_paths SET check_status = 'PENDING', check_message = '服务启动恢复：无有效关联检查任务，已自动重置为待检查' WHERE id = ?").run(p.id);
    }
  }

  const checkingConfigs = db.prepare("SELECT * FROM worker_save_configs WHERE check_status = 'CHECKING'").all();
  for (const c of checkingConfigs) {
    const activeTask = db.prepare("SELECT id FROM worker_directory_checks WHERE (check_type = 'save_config' OR check_type IS NULL) AND (target_id = ? OR config_id = ?) AND status IN ('PENDING', 'PROCESSING')").get(c.id, c.id);
    if (!activeTask) {
      db.prepare("UPDATE worker_save_configs SET check_status = 'PENDING', check_message = '服务启动恢复：无有效关联检查任务，已自动重置为待检查' WHERE id = ?").run(c.id);
    }
  }
} catch (recErr) {
  console.warn('[DB Recovery Warning]', recErr.message);
}

module.exports = db;
