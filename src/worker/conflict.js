const fs = require('fs');
const path = require('path');
const { generateDuplicateCopyFilename } = require('../common/naming');

/**
 * Handle File Overwrite & Conflict Protection (E07, R18-R20)
 * Re-names existing conflicting file to "original_name-副本(N).doc"
 */
function handleFileConflictAndOverwrite(targetDir, officialFilename, overwriteConfirmed = false) {
  const officialFilePath = path.join(targetDir, officialFilename);

  if (!fs.existsSync(officialFilePath)) {
    return { officialFilePath, renamedCopyPath: null };
  }

  // File exists! Check if conflict requires renaming to -副本(N)
  let copyIndex = 1;
  let copyFilename = generateDuplicateCopyFilename(officialFilename, copyIndex);
  let copyFilePath = path.join(targetDir, copyFilename);

  while (fs.existsSync(copyFilePath)) {
    copyIndex++;
    copyFilename = generateDuplicateCopyFilename(officialFilename, copyIndex);
    copyFilePath = path.join(targetDir, copyFilename);
  }

  // Rename old file to copy path
  fs.renameSync(officialFilePath, copyFilePath);

  return {
    officialFilePath,
    renamedCopyPath: copyFilePath,
    copyFilename
  };
}

module.exports = {
  handleFileConflictAndOverwrite
};
