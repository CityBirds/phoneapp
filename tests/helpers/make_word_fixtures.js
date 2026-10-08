/**
 * 生成自包含的 Word 测试夹具（不依赖生产库、不依赖任何现存模板文件）
 *
 * 背景：原先 test_poa3500_*.test.js 会从 data/phoneapp.db 读取生产模板做夹具，
 * 生产模板一被清空，测试就失效。这里改为用 Word COM 现场生成结构确定的模板，
 * 让测试完全自包含、可重复。
 *
 * 用法：node tests/helpers/make_word_fixtures.js <输出目录>
 * 输出：
 *   poa3500_cert_fixture.doc   4 列证书（Gas / Value / Actual Reading / mA Output(If fitted)），表头 + 3 行数据 + 认证声明
 *   poa200_pack_fixture.doc    7 列清单（序号/名称/规格型号/数量/单位/标配/备注），表头 + 主设备 + 传感器 + 2 行普通物料
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const outDir = process.argv[2] || path.resolve(__dirname, '../../data/fixtures');
fs.mkdirSync(outDir, { recursive: true });

const ps1 = path.join(__dirname, 'make_word_fixtures.ps1');
const certOut = path.join(outDir, 'poa3500_cert_fixture.doc');
const packOut = path.join(outDir, 'poa200_pack_fixture.doc');

console.log('生成测试夹具到:', outDir);
const out = execFileSync('powershell', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
  '-CertOut', certOut, '-PackOut', packOut
], { encoding: 'utf-8', timeout: 240000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
console.log(out.trim());

for (const f of [certOut, packOut]) {
  if (!fs.existsSync(f)) throw new Error('夹具未生成: ' + f);
  console.log(`  ✅ ${path.basename(f)}  ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);
}
