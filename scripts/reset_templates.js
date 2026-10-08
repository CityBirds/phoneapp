/**
 * 清空模板与字段匹配数据，准备重新上传模板 / 重做字段匹配
 *
 * 清空（数据库）：
 *   templates          —— 12 条模板记录，含 field_mappings 字段匹配成果（约 38 KB 配置）
 *   published_bundles  —— 18 条发布组合（由模板派生）
 *   worker_save_configs—— 8 条终端保存目录配置（引用模板 ID，模板没了会变残留）
 *   worker_directory_checks —— 目录检查任务（引用上面的配置）
 *
 * 移动（文件）：uploads/templates 下的模板文件 -> data/template_recovery/<时间戳>/
 *   —— 不删除，给“全系统唯一副本”的文件留后路
 *
 * 保留不动：
 *   samples/（应用自带样例）、worker_allowed_paths（执行端业务路径授权）、
 *   sales_persons、sensor_configs、models、access_token.txt（手机口令不变）
 *
 * 先停服务再操作，避免 WAL 未合并导致备份不一致。
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '..', 'data');
const uploadsDir = path.resolve(__dirname, '..', 'uploads', 'templates');
const dbFile = path.join(dataDir, 'phoneapp.db');

if (!fs.existsSync(dbFile)) {
  console.error(`[中止] 找不到数据库文件: ${dbFile}`);
  process.exit(1);
}

// ---------- 1. 备份 ----------
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = path.join(dataDir, `backup_templates_${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

let backedUp = 0;
for (const f of ['phoneapp.db', 'phoneapp.db-wal', 'phoneapp.db-shm']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(backupDir, f)); backedUp++; }
}
if (backedUp === 0) { console.error('[中止] 备份失败'); process.exit(1); }
for (const f of ['access_token.txt', 'phone_access.txt', 'tunnel.url']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(backupDir, f)); } catch (e) {} }
}
console.log(`[备份] 数据库已备份 -> ${backupDir}`);

const db = require('../src/backend/db');
const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { return -1; } };

const clearTables = ['templates', 'published_bundles', 'worker_save_configs', 'worker_directory_checks'];
const keepTables = ['worker_allowed_paths', 'worker_auth_state', 'sales_persons', 'sensor_configs', 'models', 'workers', 'tasks', 'task_files', 'clients', 'print_jobs', 'audit_logs'];

console.log('\n=== 清理前 ===');
const before = {};
for (const t of clearTables.concat(keepTables)) before[t] = count(t);
for (const t of clearTables) console.log(`  [将清空] ${t.padEnd(26)} ${before[t]}`);
for (const t of keepTables) console.log(`  [保留]   ${t.padEnd(26)} ${before[t]}`);

// 记录将被移动的文件（在删除数据库记录之前先算好）
let filesToMove = [];
if (fs.existsSync(uploadsDir)) {
  filesToMove = fs.readdirSync(uploadsDir).filter(f => fs.statSync(path.join(uploadsDir, f)).isFile());
}

// ---------- 2. 清库（事务） ----------
try {
  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM worker_directory_checks').run();
  db.prepare('DELETE FROM worker_save_configs').run();
  db.prepare('DELETE FROM published_bundles').run();
  db.prepare('DELETE FROM templates').run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('templates','published_bundles','worker_save_configs','worker_directory_checks')").run(); } catch (e) {}
  db.exec('COMMIT');
  console.log('\n[清理] 模板 / 发布组合 / 终端配置 / 目录检查 已清空');
} catch (err) {
  try { db.exec('ROLLBACK'); } catch (e) {}
  console.error('[中止] 清库失败，已回滚，数据库未改动: ' + err.message);
  process.exit(1);
}

// ---------- 3. 移动模板文件到回收目录 ----------
const recoveryDir = path.join(dataDir, `template_recovery_${stamp}`);
let moved = 0;
if (filesToMove.length > 0) {
  fs.mkdirSync(recoveryDir, { recursive: true });
  for (const f of filesToMove) {
    try {
      fs.renameSync(path.join(uploadsDir, f), path.join(recoveryDir, f));
      moved++;
    } catch (e) {
      // 跨卷等情况退回复制+删除
      try { fs.copyFileSync(path.join(uploadsDir, f), path.join(recoveryDir, f)); fs.unlinkSync(path.join(uploadsDir, f)); moved++; } catch (e2) {}
    }
  }
  console.log(`[文件] 已把 ${moved}/${filesToMove.length} 个模板文件移动到回收目录:`);
  console.log(`        ${recoveryDir}`);
} else {
  console.log('[文件] uploads/templates 下没有文件');
}

// ---------- 4. 清理后核对 ----------
console.log('\n=== 清理后 ===');
let ok = true;
for (const t of clearTables) {
  const c = count(t);
  if (c !== 0) ok = false;
  console.log(`  [将清空] ${t.padEnd(26)} ${c} ${c === 0 ? '✅' : '❌ 未清空'}`);
}
console.log('  --- 以下应保持不变 ---');
for (const t of keepTables) {
  const c = count(t);
  const same = c === before[t];
  if (!same) ok = false;
  console.log(`  [保留]   ${t.padEnd(26)} ${c} ${same ? '✅' : '⚠️ ' + before[t] + ' -> ' + c}`);
}

const remainFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : 0;
console.log(`\n  uploads/templates 剩余文件: ${remainFiles} ${remainFiles === 0 ? '✅' : '❌'}`);
console.log(`  samples/ 保留文件: ${fs.existsSync(path.resolve(__dirname, '../samples')) ? fs.readdirSync(path.resolve(__dirname, '../samples')).length : 0} ✅`);

console.log('\n=== 手机访问口令（保持不变）===');
try { console.log('  ' + fs.readFileSync(path.join(dataDir, 'access_token.txt'), 'utf-8').trim()); } catch (e) {}

console.log(`\n备份:     ${backupDir}`);
console.log(`回收目录: ${recoveryDir}`);
console.log(ok ? '\n结果: 模板数据已清空，其他数据未受影响，可以开始重新上传模板。' : '\n结果: 存在异常，请检查上面的 ⚠️/❌。');
process.exit(ok ? 0 : 2);
