/**
 * Field Position Candidate Finder and Matcher Engine
 * Rules: T03, C04, F01-F05, G01-G04, D01-D03, D15, D16
 */

const ALIAS_MAP = {
  '设备序列号': ['inst. sn.', 'inst sn', 'serial no', 'sn'],
  '设备sn': ['inst. sn.', 'inst sn', 'serial no', 'sn'],
  '环境温度': ['ambient temperature:', 'ambient temp', 'ambient temperature'],
  '相对湿度': ['relative humidity', 'humidity'],
  '日期': ['date:', 'certificate date', 'date'],
  '证书日期': ['date:', 'certificate date', 'date'],
  '仪器': ['instrument'],
  '主设备': ['主设备'],
  '传感器': ['传感器']
};

const KNOWN_UNITS = ['ppm', '℃ dp', '℃', '°c', 'ma', '%rh', 'rh'];
const FOOTER_TEXT_REGEX = /(we hereby certify|comments\s*&\s*observations|for and on behalf of|phymetrix|manager|authorized signature|印章|签名)/i;

/**
 * Check if label has explicit date meaning
 * English date match strictly uses word boundary to avoid false positives on "Update" or "Candidate"
 */
function isDateFieldLabel(label) {
  if (!label) return false;
  const str = String(label).trim();
  if (/证书日期|日期|出厂日期/i.test(str)) return true;
  if (/\bdate\b/i.test(str)) return true;
  return false;
}

function normalizeText(text) {
  if (!text) return '';
  let str = String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[:：]/g, '');

  // Normalize Chinese character spacing e.g. "序 号" -> "序号"
  str = str.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2');
  str = str.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2');

  // Normalize unit spacing e.g. "Analyzer℃ dp" -> "analyzer ℃ dp"
  str = str.replace(/\s*(℃|°c|%rh|ppm|ma)/gi, ' $1');

  return str
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractUnits(text) {
  const norm = normalizeText(text);
  const found = [];
  for (const u of KNOWN_UNITS) {
    if (norm.includes(u.toLowerCase())) {
      found.push(u.toLowerCase());
    }
  }
  return found;
}

function isTableColumnHeaderLabel(label) {
  const norm = normalizeText(label);
  return norm.includes('test point number') || norm.includes('nist') || norm.includes('analyzer') ||
         norm === '序号' || norm === '名称' || norm.includes('规格') || norm === '数量' || norm === '单位' || norm === '标配' || norm === '备注';
}

function getTableColumnDataCells(item, docItems, targetLabel) {
  if (!item || !docItems || !Array.isArray(docItems)) return [];

  const normTarget = normalizeText(targetLabel || item.text);
  if (!isTableColumnHeaderLabel(targetLabel) && !isTableColumnHeaderLabel(item.text)) {
    return [];
  }

  const tableIdx = item.tableIdx;
  const rowIdx = item.rowIdx;
  const colIdx = item.colIdx;

  const tableCells = docItems.filter(x => x.type === 'cell' && x.tableIdx === tableIdx);
  const rowIndicesBelow = [...new Set(tableCells.map(x => x.rowIdx))]
    .filter(r => r > rowIdx)
    .sort((a, b) => a - b);

  const gridDataCells = [];
  let prevRow = rowIdx;
  for (const r of rowIndicesBelow) {
    if (r !== prevRow + 1) break;
    const rowCells = tableCells.filter(x => x.rowIdx === r);
    if (rowCells.some(c => FOOTER_TEXT_REGEX.test(c.text || ''))) break;
    const colCell = rowCells.find(c => c.colIdx === colIdx);
    if (colCell) {
      gridDataCells.push(colCell);
      prevRow = r;
    } else {
      break;
    }
  }

  if (gridDataCells.length > 0) {
    return gridDataCells;
  }

  // Sequential Stride Fallback
  const cellItems = docItems.filter(x => x.type === 'cell');
  const itemIdx = cellItems.findIndex(x => x === item || (x.tableIdx === item.tableIdx && x.rowIdx === item.rowIdx && x.colIdx === item.colIdx && x.text === item.text));
  if (itemIdx < 0) return [];

  const seqStartIdx = cellItems.findIndex((x, idx) => idx > itemIdx && x.text === '1');
  if (seqStartIdx < 0) return [];

  const isPacking = cellItems.some(x => x.text.includes('主设备') || x.text.includes('装箱清单'));
  const numCols = isPacking ? 7 : 3;

  let colOffset = 0;
  if (normTarget.includes('test point number') || normTarget === '序号') colOffset = 0;
  else if (normTarget.includes('nist') || normTarget === '名称') colOffset = 1;
  else if (normTarget.includes('analyzer') || normTarget.includes('规格')) colOffset = 2;
  else if (normTarget === '数量') colOffset = 3;
  else if (normTarget === '单位') colOffset = 4;
  else if (normTarget === '标配') colOffset = 5;
  else if (normTarget === '备注') colOffset = 6;

  const sequentialCells = [];
  for (let i = seqStartIdx; i < cellItems.length; i += numCols) {
    const targetCell = cellItems[i + colOffset];
    if (!targetCell || FOOTER_TEXT_REGEX.test(targetCell.text || '')) break;
    sequentialCells.push(targetCell);
  }
  return sequentialCells;
}

/**
 * Infer recommended input field type according to Spec Section 4.1
 */
function inferFieldType(targetLabel, category = 'single') {
  if (category === 'table') {
    return 'table';
  }
  if (isDateFieldLabel(targetLabel)) {
    return 'date';
  }
  if (targetLabel === 'sensorModel' || targetLabel === '传感器型号') {
    return 'enum';
  }
  return 'text';
}

/**
 * Match a target label against document structural items (paragraphs & table cells)
 * @param {string} targetLabel - e.g. "Inst. SN." or "Customer" or "Analyzer ℃ dp" or "Date:"
 * @param {Array} docItems - list of items extracted from doc
 */
function findFieldCandidates(targetLabel, docItems) {
  const normTarget = normalizeText(targetLabel);
  const inferredType = inferFieldType(targetLabel);

  if (!normTarget || !docItems || !Array.isArray(docItems)) {
    return {
      label: targetLabel || '',
      inferredType,
      matchCount: 0,
      matchStatus: 'NO_MATCH',
      candidates: []
    };
  }

  const targetUnits = extractUnits(normTarget);
  const aliases = ALIAS_MAP[targetLabel] || ALIAS_MAP[normTarget] || [];
  const candidates = [];

  // Handle multi-line "Test point Number" recognition (D01)
  const isTestPointFeature = normTarget.includes('test point number') || 
                             normTarget.includes('testpointnumber') ||
                             (normTarget.includes('test') && normTarget.includes('point') && normTarget.includes('number'));

  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    const normText = normalizeText(item?.text);

    if (!normText) continue; // Empty cells do NOT match anything (Q30)

    const textUnits = extractUnits(normText);

    // Prevent cross-unit conflicts (F05, D15: e.g. ppm vs ℃ dp vs mA)
    if (targetUnits.length > 0 && textUnits.length > 0) {
      const hasOverlap = targetUnits.some(u => textUnits.includes(u));
      if (!hasOverlap) {
        continue; // Skip conflicting unit candidate
      }
    }

    let isFull = normText === normTarget;
    let isAlias = !isFull && aliases.some(a => normText === a || normText.includes(a));
    let isTestPointMatch = !isFull && isTestPointFeature && 
                           (normText.includes('test') && normText.includes('point') && normText.includes('number'));
    let isSub = !isFull && !isAlias && !isTestPointMatch && 
                (normText.includes(normTarget) || normTarget.includes(normText));

    if (isSub && (normTarget === 'analyzer' || normText === 'analyzer')) {
      if (targetUnits.length > 0 && textUnits.length === 0) {
        // Needs unit confirmation
      } else {
        continue;
      }
    }

    if (isFull || isAlias || isTestPointMatch || isSub) {
      let score = 0.8;
      let status = 'NO_MATCH';
      let reason = '部分匹配';

      if (isFull || isTestPointMatch) {
        score = 1.0;
        status = 'FULL_MATCH';
        reason = isTestPointMatch ? '表头特征匹配' : '完整匹配';
      } else if (isAlias) {
        score = 0.95;
        status = 'ALIAS_MATCH';
        reason = '别名匹配';
      } else if (targetUnits.length > 0 && textUnits.length === 0) {
        score = 0.85;
        status = 'NEEDS_UNIT_CONFIRM';
        reason = '需确认单位';
      } else {
        score = 0.80;
        status = 'NEEDS_UNIT_CONFIRM';
        reason = '需确认单位';
      }

      // Find candidate value location & sample values
      let candidateValue = null;
      let valueLocation = null;
      let sampleValues = [];

      if (item.type === 'cell') {
        const tableIdx = item.tableIdx;
        const rowIdx = item.rowIdx;
        const colIdx = item.colIdx;

        const dataCellsBelow = getTableColumnDataCells(item, docItems, targetLabel);

        const isSeqNumCol = normTarget === '序号' || normTarget.includes('test point number') || isTestPointMatch;

        if (dataCellsBelow.length > 0) {
          if (isSeqNumCol) {
            sampleValues = dataCellsBelow.map((c, idx) => String(idx + 1)).slice(0, 5);
          } else {
            sampleValues = dataCellsBelow.map(c => (c.text ? c.text.trim() : '空')).filter(Boolean).slice(0, 5);
          }
          candidateValue = null;
          valueLocation = { type: 'table_column', tableIdx, colIdx, startRow: rowIdx + 1, endRow: rowIdx + dataCellsBelow.length };
        } else {
          const tableCells = docItems.filter(x => x.type === 'cell' && x.tableIdx === tableIdx);
          const rightCell = tableCells.find(x => x.rowIdx === rowIdx && x.colIdx === colIdx + 1);
          if (rightCell) {
            candidateValue = rightCell.text ? rightCell.text.trim() : '空';
            valueLocation = { type: 'cell', tableIdx, rowIdx, colIdx: colIdx + 1 };
          } else {
            candidateValue = '未绑定';
          }
        }
      } else if (item.type === 'paragraph') {
        if (i + 1 < docItems.length) {
          candidateValue = docItems[i + 1].text ? docItems[i + 1].text.trim() : '空';
          valueLocation = { type: 'paragraph', paragraphIdx: i + 1 };
        } else {
          candidateValue = '未绑定';
        }
      }

      candidates.push({
        matchedLabel: item.text.trim(),
        score,
        status,
        reason,
        location: item.type === 'cell' 
          ? { type: 'cell', tableIdx: item.tableIdx, rowIdx: item.rowIdx, colIdx: item.colIdx }
          : { type: 'paragraph', paragraphIdx: i },
        context: item.text.trim(),
        suggestedValueLocation: valueLocation,
        candidateValue,
        sampleValues
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  let matchStatus = 'NO_MATCH';
  if (candidates.length === 1) {
    matchStatus = candidates[0].status;
  } else if (candidates.length > 1) {
    matchStatus = 'MULTI_CANDIDATE';
  }

  return {
    label: targetLabel,
    inferredType: candidates.length > 0 && candidates[0].sampleValues?.length > 0 ? 'table' : inferredType,
    matchCount: candidates.length,
    matchStatus,
    candidates
  };
}

module.exports = {
  normalizeText,
  findFieldCandidates,
  inferFieldType,
  isDateFieldLabel,
  ALIAS_MAP
};
