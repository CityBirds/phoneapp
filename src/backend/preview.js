/**
 * 文档预览模块（整改 3.1 / 3.2：手机免 Office 预览）
 *
 * 预览链路：执行端真实生成 Word → 协调服务转换 PDF → 协调服务把 PDF 逐页渲染为图片
 *          → 手机查看分页图片（不依赖手机装 Office，也不依赖浏览器内嵌 PDF）。
 *
 * 分两个可独立重试的阶段（PV04/PV05）：
 *   stage "pdf"    ：Word → PDF
 *   stage "images" ：PDF → 逐页 PNG
 * “仅重试预览”只重做失败的那一阶段；已有有效 PDF 而页图失败时，只重做页图，
 * 绝不重新生成 Word、也不覆盖原件。
 *
 * 明确不做（对应整改 A.1/A.2/A.6）：
 *  - 不提取文字后重画固定样式的 SVG；
 *  - 不使用固定三列表头；
 *  - 不使用虚构兜底数据；
 *  - 转换失败必须抛出带阶段与原因的错误，绝不产出看起来成功的替代预览。
 */

const path = require('path');
const fs = require('fs');
const { convertWordToPdf, renderPdfToPageImages, getConversionCapabilities } = require('./doc_render');

const SUPPORTED_WORD_EXT = ['.doc', '.docx'];

function fileExists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

function previewAssetUrl(relPath, version) {
  return `/previews/${relPath}?v=${version}`;
}

/** 预览 PDF 的存放路径（每个任务每个文档类型一份，稳定可缓存） */
function getPreviewPdfPath(previewDir, taskId, fileType) {
  return path.join(previewDir, `task_${taskId}_${fileType}.pdf`);
}

/** 页图目录（每任务每文档独立，避免同名不同内容串页 PV06） */
function getPreviewPageDir(previewDir, taskId, fileType) {
  return path.join(previewDir, `task_${taskId}_${fileType}_pages`);
}

function listPageImages(pageDir) {
  if (!fs.existsSync(pageDir)) return [];
  return fs.readdirSync(pageDir)
    .filter(f => /^page_\d+\.png$/i.test(f))
    .sort()
    .map(f => path.join(pageDir, f));
}

function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
  }
}

/** PDF 是否“可解析且非空”（PV06：0 字节/损坏 PDF 不算成功） */
function isValidPdf(pdfPath) {
  try {
    if (!fileExists(pdfPath)) return false;
    const stat = fs.statSync(pdfPath);
    if (stat.size <= 0) return false;
    const fd = fs.openSync(pdfPath, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    return head.toString('latin1') === '%PDF-';
  } catch (e) {
    return false;
  }
}

/**
 * 生成（或复用）某任务文件的预览。
 *
 * @param {object} params
 * @param {string} params.sourcePath  执行端回传的 Word 文件路径
 * @param {string} params.previewDir  预览输出根目录
 * @param {number|string} params.taskId
 * @param {'cert'|'packing'} params.fileType
 * @param {boolean} [params.force]        强制两阶段都重做
 * @param {'pdf'|'images'} [params.forceStage] 只强制重做指定阶段（仅重试失败阶段）
 * @param {number} [params.scale]      页图缩放倍数
 * @returns {{ pdfPath, pdfUrl, pageUrls, pages, engine, imageEngine, version, reused, stages }}
 */
function generateDocumentPreview(params) {
  const { sourcePath, previewDir, taskId, fileType, force = false, forceStage = null, scale = 2 } = params || {};
  if (!sourcePath) throw new Error('预览失败：缺少源 Word 文件路径');
  if (!fileExists(sourcePath)) throw new Error(`预览失败：源 Word 文件不存在 [${sourcePath}]`);
  const ext = path.extname(sourcePath).toLowerCase();
  if (!SUPPORTED_WORD_EXT.includes(ext)) {
    throw new Error(`预览失败：仅支持 ${SUPPORTED_WORD_EXT.join('/')} 预览，当前文件类型为 [${ext || '未知'}] (J12, Q33)`);
  }
  if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

  const pdfPath = getPreviewPdfPath(previewDir, taskId, fileType);
  const pageDir = getPreviewPageDir(previewDir, taskId, fileType);
  const sourceStat = fs.statSync(sourcePath);

  const stages = { pdf: { done: false, reused: false, error: null }, images: { done: false, reused: false, error: null } };

  // ---------- 阶段 1：Word → PDF ----------
  let pdfReused = false;
  const pdfUsable = isValidPdf(pdfPath);
  if (!force && forceStage !== 'pdf' && pdfUsable) {
    const pdfStat = fs.statSync(pdfPath);
    if (pdfStat.mtimeMs >= sourceStat.mtimeMs) {
      pdfReused = true;
    }
  }
  if (!pdfReused) {
    const conv = convertWordToPdf(sourcePath, pdfPath, { timeoutMs: 120000 });
    if (!isValidPdf(pdfPath)) {
      stages.pdf.error = '转换后未能得到有效 PDF';
      throw Object.assign(new Error(`预览失败（阶段: Word→PDF）：${stages.pdf.error}`), { stage: 'pdf', stages });
    }
    stages.pdf.done = true;
  } else {
    stages.pdf.done = true;
    stages.pdf.reused = true;
  }

  // ---------- 阶段 2：PDF → 逐页图片 ----------
  const existingPages = listPageImages(pageDir);
  let pageFiles = [];
  let pagesReused = false;
  if (!force && forceStage !== 'images' && existingPages.length > 0) {
    const pdfStat = fs.statSync(pdfPath);
    const oldestPage = Math.min(...existingPages.map(p => fs.statSync(p).mtimeMs));
    if (oldestPage >= pdfStat.mtimeMs) {
      pageFiles = existingPages;
      pagesReused = true;
    }
  }
  if (!pagesReused) {
    // 独立目录 + 先清理本项目文件，避免历史残留被当成本次成功 (PV06)
    if (fs.existsSync(pageDir)) clearDir(pageDir);
    try {
      const rendered = renderPdfToPageImages(pdfPath, pageDir, { scale, timeoutMs: 180000 });
      pageFiles = rendered.files;
      stages.images.engine = rendered.engine;
    } catch (e) {
      stages.images.error = e.message;
      throw Object.assign(new Error(`预览失败（阶段: PDF→页图）：${e.message}`), { stage: 'images', stages });
    }
    stages.images.done = true;
  } else {
    stages.images.done = true;
    stages.images.reused = true;
  }

  if (pageFiles.length === 0) {
    throw Object.assign(new Error('预览失败（阶段: PDF→页图）：未生成任何页图'), { stage: 'images', stages });
  }

  const pdfStat = fs.statSync(pdfPath);
  const version = `${Math.round(pdfStat.mtimeMs)}_${pageFiles.length}`;
  const pageUrls = pageFiles.map(p => previewAssetUrl(path.basename(pageDir) + '/' + path.basename(p), Math.round(fs.statSync(p).mtimeMs)));

  return {
    pdfPath,
    pdfUrl: previewAssetUrl(path.basename(pdfPath), version),
    pageUrls,
    pages: pageFiles.length,
    engine: pdfReused ? 'cached' : 'word-to-pdf',
    imageEngine: pagesReused ? 'cached' : (stages.images.engine || 'windows-data-pdf'),
    version,
    reused: pdfReused && pagesReused,
    stages: {
      pdf: { reused: stages.pdf.reused, error: null },
      images: { reused: stages.images.reused, error: null }
    }
  };
}

/** 删除某任务文件的预览产物（用于源文件更新后防止读到旧缓存） */
function clearDocumentPreview(previewDir, taskId, fileType) {
  try { const p = getPreviewPdfPath(previewDir, taskId, fileType); if (fileExists(p)) fs.unlinkSync(p); } catch (e) {}
  try { const d = getPreviewPageDir(previewDir, taskId, fileType); if (fs.existsSync(d)) clearDir(d); } catch (e) {}
}

module.exports = {
  generateDocumentPreview,
  getPreviewPdfPath,
  getPreviewPageDir,
  listPageImages,
  isValidPdf,
  clearDocumentPreview,
  getConversionCapabilities,
  SUPPORTED_WORD_EXT
};
