/**
 * 给文本文件补齐 UTF-8 BOM。
 * 原因：Windows PowerShell 5.1 读取“无 BOM 的 UTF-8”脚本时会按当前 ANSI 代码页解释，
 * 含中文注释的 .ps1 会被解析错乱（报 "Try statement is missing its Catch block"）。
 * 项目内既有 .ps1 全部带 BOM，这里保持一致。
 *
 * 用法: node tools/add_bom.js <文件...>
 */
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/add_bom.js <文件...>');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) {
    console.error(`✗ 文件不存在: ${abs}`);
    failed++;
    continue;
  }
  const buf = fs.readFileSync(abs);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (hasBom) {
    console.log(`= 已有 BOM: ${path.basename(abs)}`);
    continue;
  }
  fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
  console.log(`✓ 已补 BOM: ${path.basename(abs)}`);
}
process.exit(failed > 0 ? 1 : 0);
