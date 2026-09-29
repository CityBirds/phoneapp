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
  return String(text)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[:：]/g, '')
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
      let candidateValue = '';
      let valueLocation = null;
      let sampleValues = [];

      if (item.type === 'cell') {
        // 1. Right cell in same row for single value fields
        const rightCell = docItems.find(
          x => x.type === 'cell' && x.tableIdx === item.tableIdx && x.rowIdx === item.rowIdx && x.colIdx === item.colIdx + 1
        );
        if (rightCell) {
          candidateValue = rightCell.text ? rightCell.text.trim() : '空';
          valueLocation = { type: 'cell', tableIdx: rightCell.tableIdx, rowIdx: rightCell.rowIdx, colIdx: rightCell.colIdx };
        } else {
          candidateValue = '未绑定';
        }

        // 2. Below cells in same column for table data areas (e.g. test points or packing list columns)
        const columnCellsBelow = docItems.filter(
          x => x.type === 'cell' && x.tableIdx === item.tableIdx && x.colIdx === item.colIdx && x.rowIdx > item.rowIdx
        );
        if (columnCellsBelow.length > 0) {
          sampleValues = columnCellsBelow.map(c => c.text ? c.text.trim() : '空').slice(0, 5);
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
    inferredType,
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
