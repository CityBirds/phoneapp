/**
 * Local Whitelist Boundary Enforcer (E02, R03, R05, 4.2, 6.7)
 *
 * 说明：
 * - 目录边界必须按“真实路径 + 相对路径”判断，禁止仅用字符串前缀比较，
 *   否则允许 D:\docs 时会误放行 D:\docs-other。
 * - 必须解析目录联接 (junction) / 符号链接，防止通过链接跳出授权范围。
 */

const path = require('path');
const fs = require('fs');

function normalizeComparePath(p) {
  if (!p) return '';
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 解析真实路径（跟随符号链接与目录联接）。
 * 目标可以不存在：向上找到最近的存在祖先做 realpath，再拼回剩余片段。
 */
function safeRealPath(targetPath) {
  if (!targetPath) return '';
  let current = path.resolve(targetPath);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return tail.length ? path.resolve(real, ...tail.reverse()) : real;
    } catch (e) {
      const parent = path.dirname(current);
      if (parent === current) break;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(targetPath);
}

/**
 * 严格判断 child 是否位于 parent 之内（含自身）。
 * - 使用相对路径判断，避免 D:\docs 与 D:\docs-other 的前缀误判；
 * - 解析符号链接 / 目录联接，避免链接越界；
 * - Windows 下大小写不敏感。
 */
function isSubpath(parent, child) {
  if (!parent || !child) return false;
  const realParent = normalizeComparePath(safeRealPath(parent));
  const realChild = normalizeComparePath(safeRealPath(child));
  if (!realParent || !realChild) return false;
  if (realParent === realChild) return true;

  const rel = path.relative(realParent, realChild);
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith('..') && !rel.startsWith(`..${path.sep}`);
}

/**
 * 兼容历史接口：判断目标路径是否位于授权根目录内。
 */
function isPathInWhitelist(targetPath, allowedRootDir) {
  if (!targetPath || !allowedRootDir) return false;
  if (typeof targetPath !== 'string') return false;
  if (targetPath.includes('\0')) return false;
  return isSubpath(allowedRootDir, targetPath);
}

function isPrinterAllowed(printerName, allowedPrinters) {
  if (!printerName || !Array.isArray(allowedPrinters)) return false;
  return allowedPrinters.includes(printerName);
}

function sanitizeFilename(filename) {
  if (!filename) return 'unnamed.doc';
  // Strip control chars, slash, backslash, colons, wildcards
  return filename.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 校验子文件夹名称片段是否安全（不得穿越、不得含非法字符、不得为保留名）。
 */
function isSafePathSegment(segment) {
  if (!segment || typeof segment !== 'string') return false;
  if (segment === '.' || segment === '..') return false;
  if (segment.includes('..')) return false;
  if (/[\\/:*?"<>|\0]/.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  return true;
}

module.exports = {
  isPathInWhitelist,
  isSubpath,
  safeRealPath,
  isSafePathSegment,
  isPrinterAllowed,
  sanitizeFilename
};
