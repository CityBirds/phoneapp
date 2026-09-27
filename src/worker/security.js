/**
 * Local Whitelist Boundary Enforcer (E02, R03, R05)
 */

const path = require('path');

function isPathInWhitelist(targetPath, allowedRootDir) {
  if (!targetPath || !allowedRootDir) return false;

  // Resolve absolute paths
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(allowedRootDir);

  // Check for path traversal or invalid characters
  if (targetPath.includes('\0') || targetPath.includes('..')) {
    // Double check if resolved path actually starts with resolved root
    if (!resolvedTarget.startsWith(resolvedRoot)) return false;
  }

  return resolvedTarget.startsWith(resolvedRoot);
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

module.exports = {
  isPathInWhitelist,
  isPrinterAllowed,
  sanitizeFilename
};
