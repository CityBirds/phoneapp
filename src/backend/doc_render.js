/**
 * 文档渲染：把执行端真实生成的 Word 文档转换为 PDF，作为手机端预览载体。
 *
 * 设计要点（对应整改要求 A）：
 *  - 预览必须基于本任务实际生成并返回的 Word 文件，不做任何“按模板重画”；
 *  - 转换失败必须抛出带具体原因的错误，由调用方标记为预览失败，绝不生成看起来成功的替代预览；
 *  - 不修改源 Word 文件，只读取。
 *
 * 可用引擎（按顺序尝试）：
 *  1) Windows: Word/WPS COM（kwps/wps/word）ExportAsFixedFormat(wdExportFormatPDF)
 *  2) 其它平台: LibreOffice/soffice --headless --convert-to pdf
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

/** 运行 PowerShell 脚本，返回 { ok, stdout, stderr, error } */
function runPowershell(scriptPath, args, timeoutMs) {
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, stdout: String(stdout || ''), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || e.message || ''),
      error: e
    };
  }
}

/** 从 PowerShell 输出里取最后一行 JSON（脚本只输出一行结果） */
function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      try { return JSON.parse(lines[i]); } catch (e) { /* 继续往前找 */ }
    }
  }
  return null;
}

/**
 * 把 PDF 逐页渲染为 PNG（手机免 Office 预览的关键一步）。
 *
 * 只用 Windows 运行时自带的 Windows.Data.Pdf，不要求安装第三方组件，
 * 也不要求手机装 Office 或支持内嵌 PDF。
 *
 * @param {string} pdfPath 已通过校验的 PDF
 * @param {string} outDir  页图输出目录（调用方保证是本任务独立目录）
 * @param {object} [options] { scale, timeoutMs }
 * @returns {{ pages: number, files: string[], engine: string }}
 * @throws {Error} 渲染失败/页数不一致时抛出带阶段与原因的错误
 */
function renderPdfToPageImages(pdfPath, outDir, options = {}) {
  pdfPath = path.resolve(pdfPath);
  outDir = path.resolve(outDir);
  if (!fileExists(pdfPath)) {
    throw new Error(`页图渲染失败：PDF 不存在 [${pdfPath}]`);
  }
  const stat = fs.statSync(pdfPath);
  if (stat.size <= 0) {
    throw new Error(`页图渲染失败：PDF 为空文件（0 字节）[${pdfPath}]`);
  }
  if (process.platform !== 'win32') {
    throw new Error('页图渲染失败：当前平台缺少可用的 PDF 页图渲染组件（需要 Windows 运行时 Windows.Data.Pdf）');
  }
  const script = path.join(__dirname, 'pdf_to_png.ps1');
  if (!fileExists(script)) {
    throw new Error(`页图渲染失败：缺少内部渲染脚本 ${script}`);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const scale = Number(options.scale) > 0 ? Number(options.scale) : 2;
  const timeoutMs = options.timeoutMs || 180000;
  const res = runPowershell(script, [
    '-PdfPath', pdfPath,
    '-OutDir', outDir,
    '-Scale', String(scale),
    '-TimeoutSeconds', String(Math.max(5, Math.round(timeoutMs / 1000)))
  ], timeoutMs + 15000);

  const parsed = parseLastJsonLine(res.stdout);
  if (!parsed) {
    const detail = String(res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join(' / ');
    throw new Error(`页图渲染失败：渲染脚本无有效输出${detail ? '（' + detail + '）' : ''}`);
  }
  if (!parsed.ok) {
    throw new Error(`页图渲染失败（阶段: ${parsed.stage || 'unknown'}）：${parsed.error || '未知原因'}`);
  }
  const files = (parsed.files || []).filter(fileExists);
  if (files.length === 0) {
    throw new Error('页图渲染失败：未生成任何页图');
  }
  if (Number(parsed.pages) !== files.length) {
    throw new Error(`页图渲染失败：页图数量 (${files.length}) 与 PDF 页数 (${parsed.pages}) 不一致`);
  }
  return { pages: files.length, files, engine: parsed.engine || 'windows-data-pdf' };
}

/**
 * 转换能力自检（启动时/管理界面用）。
 * 说明：能启动 Word 不代表能导出 PDF，因此这里只报告“检测到的组件”，
 * 真实可用性由实际转换结果决定（不要把它当成"可用"的承诺）。
 */
function getConversionCapabilities() {
  const capabilities = {
    platform: process.platform,
    wordToPdf: { engines: [], detail: '' },
    pdfToImage: { engines: [], detail: '' },
    checkedAt: new Date().toISOString()
  };

  if (process.platform === 'win32') {
    const script = path.join(__dirname, 'word_to_pdf.ps1');
    if (fileExists(script)) {
      capabilities.wordToPdf.engines.push({ id: 'office-com', label: 'Word/WPS COM (ExportAsFixedFormat)', script });
    } else {
      capabilities.wordToPdf.detail = '缺少 word_to_pdf.ps1';
    }
    const pngScript = path.join(__dirname, 'pdf_to_png.ps1');
    if (fileExists(pngScript)) {
      capabilities.pdfToImage.engines.push({ id: 'windows-data-pdf', label: 'Windows.Data.Pdf 逐页渲染', script: pngScript });
    } else {
      capabilities.pdfToImage.detail = '缺少 pdf_to_png.ps1';
    }
  }
  const soffice = findSoffice();
  if (soffice) {
    capabilities.wordToPdf.engines.push({ id: 'libreoffice', label: `LibreOffice (${soffice})` });
  }
  if (capabilities.wordToPdf.engines.length === 0) {
    capabilities.wordToPdf.detail = capabilities.wordToPdf.detail || '未检测到任何 Word→PDF 转换组件';
  }
  if (capabilities.pdfToImage.engines.length === 0) {
    capabilities.pdfToImage.detail = capabilities.pdfToImage.detail || '未检测到任何 PDF 页图渲染组件（需要 Windows 10/11）';
  }
  return capabilities;
}

function findSoffice() {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  ].filter(Boolean);
  return candidates.find(fileExists) || null;
}

/**
 * 把 Word 文档转换为 PDF。
 * @param {string} wordPath 源 Word 文件（只读，不会被修改）
 * @param {string} pdfPath  目标 PDF 路径
 * @param {object} [options] { timeoutMs }
 * @returns {{ pdfPath: string, engine: string, pages?: number }}
 * @throws {Error} 转换失败时抛出带具体原因的错误
 */
function convertWordToPdf(wordPath, pdfPath, options = {}) {
  // Office/COM 会以自身进程目录为基准解析相对路径，这里统一转为绝对路径
  wordPath = path.resolve(wordPath);
  pdfPath = path.resolve(pdfPath);
  if (!fileExists(wordPath)) {
    throw new Error(`预览失败：源 Word 文件不存在 [${wordPath}]`);
  }
  const ext = path.extname(wordPath).toLowerCase();
  if (ext !== '.doc' && ext !== '.docx') {
    throw new Error(`预览失败：仅支持 .doc/.docx 预览，当前文件为 [${ext || '未知'}]`);
  }
  const timeoutMs = options.timeoutMs || 120000;

  const dir = path.dirname(pdfPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(pdfPath)) {
    try { fs.unlinkSync(pdfPath); } catch (e) {}
  }

  const errors = [];

  // 引擎 1：Windows Office COM
  if (process.platform === 'win32') {
    const ps1 = path.join(__dirname, 'word_to_pdf.ps1');
    if (fileExists(ps1)) {
      const res = runPowershell(ps1, ['-WordPath', wordPath, '-PdfPath', pdfPath], timeoutMs);
      if (fileExists(pdfPath) && fs.statSync(pdfPath).size > 0) {
        const pagesMatch = /pages=(\d+)/.exec(res.stdout || '');
        return { pdfPath, engine: 'office-com', pages: pagesMatch ? Number(pagesMatch[1]) : undefined };
      }
      const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(0, 4).join(' / ');
      errors.push(`Office COM 转换失败${detail ? '：' + detail : '（未产生 PDF 输出）'}`);
    } else {
      errors.push('缺少内部转换脚本 word_to_pdf.ps1');
    }
  }

  // 引擎 2：LibreOffice / soffice（headless）
  const soffice = findSoffice();
  if (soffice) {
    try {
      const outDir = path.dirname(pdfPath);
      execFileSync(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, wordPath], {
        encoding: 'utf-8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      const produced = path.join(outDir, path.basename(wordPath).replace(/\.[^.]+$/, '') + '.pdf');
      if (fileExists(produced)) {
        if (path.resolve(produced) !== path.resolve(pdfPath)) {
          try { fs.renameSync(produced, pdfPath); } catch (e) { fs.copyFileSync(produced, pdfPath); }
        }
        return { pdfPath, engine: 'libreoffice' };
      }
      errors.push('LibreOffice 未产生 PDF 输出');
    } catch (e) {
      errors.push(`LibreOffice 转换失败：${String(e.stderr || e.message).slice(0, 200)}`);
    }
  } else {
    errors.push('未检测到 LibreOffice/soffice');
  }

  throw new Error(`预览转换失败（未生成 PDF）：${errors.join('；')}`);
}

module.exports = { convertWordToPdf, renderPdfToPageImages, getConversionCapabilities, findSoffice };
