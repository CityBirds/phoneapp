const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function isValidDocumentText(text) {
  if (!text) return false;
  const clean = text.replace(/[\uE000-\uF8FF\uFFF0-\uFFFF\uD800-\uDFFF]/g, '').trim();
  if (!clean) return false;
  const validMatches = clean.match(/[\u4e00-\u9fa5A-Za-z0-9°℃%#:\-\.\(\)\/（）,\*\"\:\s]/g) || [];
  return (validMatches.length / clean.length) >= 0.7;
}

/**
 * Extract Document Structure for .doc and .docx files
 * Returns array of docItems:
 * - Paragraphs: { type: 'paragraph', paragraphIdx, text, rawText }
 * - Table Cells: { type: 'cell', tableIdx, rowIdx, colIdx, text, rawText }
 */
function extractDocumentStructure(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const ext = path.extname(filepath).toLowerCase();

  // Strategy 1: Try PowerShell COM script on Windows if Word/WPS is available
  if (process.platform === 'win32') {
    const psScript = path.join(__dirname, '../worker/extract_doc_structure.ps1');
    if (fs.existsSync(psScript)) {
      try {
        const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & '${psScript.replace(/'/g, "''")}' '${filepath.replace(/'/g, "''")}'"`, {
          encoding: 'utf-8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const trimmed = output.trim();
        if (trimmed && trimmed.startsWith('[')) {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      } catch (e) {
        console.warn(`Real document structure extraction notice: PowerShell COM extraction failed or unavailable (${e.message}). Falling back to stream parser.`);
      }
    }
  }

  // Strategy 2: Extract from binary stream / cell delimiters or XML
  const raw = fs.readFileSync(filepath);

  if (ext === '.docx') {
    return extractDocxStructure(raw);
  } else {
    return extractDocBinaryStructure(raw);
  }
}

/**
 * Parser for .doc binary streams preserving cell structures and filtering binary metadata noise
 */
function extractDocBinaryStructure(buffer) {
  const items = [];
  const binaryGarbageRegex = /(Root Entry|SummaryInformation|DocumentSummaryInformation|WordDocument|KSOProduct|WpsCustomData|Microsoft Office|Normal|Table|Data|CompObj|ObjectPool)/i;

  const processToken = (cleanedText, token, currentTableIdx, currentRowIdx, currentColIdx) => {
    if (cleanedText && !binaryGarbageRegex.test(cleanedText) && cleanedText.length <= 300) {
      if (isValidDocumentText(cleanedText)) {
        items.push({
          type: 'cell',
          text: cleanedText,
          rawText: token,
          tableIdx: currentTableIdx,
          rowIdx: currentRowIdx,
          colIdx: currentColIdx
        });
      }
    }
  };

  const str16 = buffer.toString('utf16le');
  const rawTokens = str16.split('\x07');

  let currentTableIdx = 0;
  let currentRowIdx = 0;
  let currentColIdx = 0;

  for (let i = 0; i < rawTokens.length; i++) {
    let token = rawTokens[i];
    const hasRowEnd = token.includes('\r');

    let cleanToken = token.replace(/[\x00-\x06\x08-\x09\x0b-\x1f\x7f]/g, '');

    const cleanedText = cleanToken
      .replace(/[\uFEFF\uFFFE\uE000-\uF8FF\uD800-\uDFFF]/g, '')
      .replace(/^\r+|\r+$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    processToken(cleanedText, token, currentTableIdx, currentRowIdx, currentColIdx);

    currentColIdx++;
    if (hasRowEnd) {
      currentColIdx = 0;
      currentRowIdx++;
    }
  }

  // Also parse 8-bit ASCII cell tokens (for Word 8-bit text pieces)
  let asciiCurrent = '';
  let aTableIdx = 0, aRowIdx = 0, aColIdx = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === 0x07) {
      const cleanedText = asciiCurrent
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleanedText && !items.some(it => it.text === cleanedText || it.text.includes(cleanedText))) {
        processToken(cleanedText, asciiCurrent, aTableIdx, aRowIdx, aColIdx);
      }
      asciiCurrent = '';
      aColIdx++;
    } else if (b === 0x0d) {
      asciiCurrent += ' ';
      aRowIdx++;
      aColIdx = 0;
    } else if (b >= 0x20 && b <= 0x7e) {
      asciiCurrent += String.fromCharCode(b);
    }
  }

  return items;
}

/**
 * Parser for .docx files (XML structures)
 */
function extractDocxStructure(buffer) {
  const items = [];
  try {
    const str = buffer.toString('utf8');

    // Match tables
    const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
    let tblMatch;
    let tableIdx = 0;

    while ((tblMatch = tblRegex.exec(str)) !== null) {
      const tblXml = tblMatch[1];
      const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let trMatch;
      let rowIdx = 0;

      while ((trMatch = trRegex.exec(tblXml)) !== null) {
        const trXml = trMatch[1];
        const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let tcMatch;
        let colIdx = 0;

        while ((tcMatch = tcRegex.exec(trXml)) !== null) {
          const tcXml = tcMatch[1];
          const textMatches = tcXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          const text = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();

          const cleanText = text.replace(/\s+/g, ' ').trim();

          if (isValidDocumentText(cleanText)) {
            items.push({
              type: 'cell',
              text: cleanText,
              rawText: text,
              tableIdx,
              rowIdx,
              colIdx
            });
          }

          colIdx++;
        }
        rowIdx++;
      }
      tableIdx++;
    }

    // Match paragraphs outside tables if no table items were found
    if (items.length === 0) {
      const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let pMatch;
      let paragraphIdx = 0;

      while ((pMatch = pRegex.exec(str)) !== null) {
        const pXml = pMatch[1];
        const textMatches = pXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [];
        const text = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join(' ').trim();
        const cleanText = text.replace(/\s+/g, ' ').trim();

        if (cleanText && isValidDocumentText(cleanText)) {
          items.push({
            type: 'paragraph',
            text: cleanText,
            rawText: text,
            paragraphIdx
          });
          paragraphIdx++;
        }
      }
    }
  } catch (e) {}

  return items;
}

module.exports = {
  extractDocumentStructure
};
