/**
 * 正式测试前清空业务数据（保留模板与字段匹配、终端配置、路径授权）
 *
 * 保留：templates(含 field_mappings/field_mappings 草稿)、published_bundles、models、
 *       worker_save_configs、worker_allowed_paths、worker_auth_state、workers(由心跳重建)、
 *       sales_persons、sensor_configs、access_token.txt(手机口令不变)
 * 清空：tasks、task_files、print_jobs、clients、audit_logs、worker_directory_checks
 * 同时清空业务产物目录：data/previews、data/returned
 *
 * 先备份数据库文件（含 WAL）到 data/backup_<时间戳>/，备份失败则中止，绝不带着风险执行。
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'phoneapp.db');

if (!fs.existsSync(dbFile)) {
  console.error(`[中止] 找不到数据库文件: ${dbFile}`);
  process.exit(1);
}

// ---------- 1. 备份 ----------
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = path.join(dataDir, `backup_${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

let backedUp = 0;
for (const f of ['phoneapp.db', 'phoneapp.db-wal', 'phoneapp.db-shm']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(backupDir, f));
    backedUp++;
  }
}
if (backedUp === 0) {
  console.error('[中止] 备份失败：没有复制到任何数据库文件');
  process.exit(1);
}
console.log(`[备份] 已备份 ${backedUp} 个文件 -> ${backupDir}`);

// 备份访问口令与终端配置文件（便于回滚）
for (const f of ['access_token.txt', 'phone_access.txt', 'tunnel.url']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(backupDir, f)); } catch (e) {} }
}

const db = require('../src/backend/db');

// ---------- 2. 清理前统计 ----------
const businessTables = ['task_files', 'tasks', 'print_jobs', 'clients', 'audit_logs', 'worker_directory_checks'];
const keepTables = ['templates', 'published_bundles', 'models', 'worker_save_configs', 'worker_allowed_paths', 'worker_auth_state', 'sales_persons', 'sensor_configs', 'workers'];

const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { return -1; } };

console.log('\n=== 清理前 ===');
const before = {};
for (const t of businessTables.concat(keepTables)) { before[t] = count(t); }
for (const t of businessTables) console.log(`  [将清空] ${t.padEnd(26)} ${before[t]}`);
for (const t of keepTables) console.log(`  [保留]   ${t.padEnd(26)} ${before[t]}`);

// ---------- 3. 执行清理（事务） ----------
try {
  db.exec('BEGIN IMMEDIATE');
  // 先删子表，避免外键约束（若启用了 foreign_keys）
  db.prepare('DELETE FROM task_files').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM print_jobs').run();
  db.prepare('DELETE FROM audit_logs').run();
  db.prepare('DELETE FROM worker_directory_checks').run();
  db.prepare('DELETE FROM clients').run();
  // 重置自增序列，让正式测试的任务号从 1 开始
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('tasks','task_files','print_jobs','audit_logs','clients','worker_directory_checks')").run(); } catch (e) {}
  db.exec('COMMIT');
  console.log('\n[清理] 业务数据已清空');
} catch (err) {
  try { db.exec('ROLLBACK'); } catch (e) {}
  console.error('[中止] 清理失败，已回滚，数据库未改动: ' + err.message);
  process.exit(1);
}

// ---------- 4. 清理业务产物目录 ----------
function clearDir(label, dir) {
  if (!fs.existsSync(dir)) { console.log(`  ${label}: (不存在，跳过)`); return; }
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
  let removed = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) {}
  }
  console.log(`  ${label}: 删除 ${removed}/${files.length} 个文件`);
}
console.log('\n=== 清理业务产物目录 ===');
clearDir('预览目录 data/previews', path.join(dataDir, 'previews'));
clearDir('回传目录 data/returned', path.join(dataDir, 'returned'));

// ---------- 5. 清理后核对 ----------
console.log('\n=== 清理后 ===');
let ok = true;
for (const t of businessTables) {
  const c = count(t);
  if (c !== 0) ok = false;
  console.log(`  [将清空] ${t.padEnd(26)} ${c} ${c === 0 ? '✅' : '❌ 未清空'}`);
}
for (const t of keepTables) {
  const c = count(t);
  console.log(`  [保留]   ${t.padEnd(26)} ${c} ${c === before[t] ? '✅ 未变动' : '⚠️ 发生变化(' + before[t] + ' -> ' + c + ')'}`);
}

console.log('\n=== 手机访问口令（保持不变）===');
try { console.log('  ' + fs.readFileSync(path.join(dataDir, 'access_token.txt'), 'utf-8').trim()); } catch (e) {}

console.log(`\n完成。备份位置: ${backupDir}`);
console.log(ok ? '结果: 业务数据清空成功，模板与配置完好。' : '结果: 存在未清空的表，请检查。');
process.exit(ok ? 0 : 2);
