/**
 * Field Position Candidate Finder and Matcher Engine
 * Rules: T03, C04, F01-F05, G01-G04
 */

const ALIAS_MAP = {
  '设备序列号': ['inst. sn.', 'inst sn', 'serial no', 'sn'],
  '设备sn': ['inst. sn.', 'inst sn', 'serial no', 'sn'],
  '环境温度': ['ambient temperature:', 'ambient temp', 'ambient temperature'],
  '相对湿度': ['relative humidity', 'humidity'],
  '日期': ['date:'],
  '仪器': ['instrument'],
  '主设备': ['主设备'],
  '传感器': ['传感器']
};

const KNOWN_UNITS = ['ppm', '℃ dp', '℃', '°c', 'ma', '%rh', 'rh'];

function normalizeText(text) {
  if (!text) return '';
  return text
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
 * Match a target label against document structural items (paragraphs & table cells)
 * @param {string} targetLabel - e.g. "Inst. SN." or "Customer" or "Analyzer pv ppm"
 * @param {Array} docItems - list of items extracted from doc
 */
function findFieldCandidates(targetLabel, docItems) {
  const normTarget = normalizeText(targetLabel);
  const candidates = [];

  if (!normTarget || !docItems || !Array.isArray(docItems)) {
    return {
      label: targetLabel || '',
      matchCount: 0,
      matchStatus: 'NO_MATCH',
      candidates: []
    };
  }

  const targetUnits = extractUnits(normTarget);
  const aliases = ALIAS_MAP[targetLabel] || ALIAS_MAP[normTarget] || [];

  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    const normText = normalizeText(item?.text);

    if (!normText) continue; // Empty cells/text do NOT match anything (Q30)

    const textUnits = extractUnits(normText);

    // Check unit conflicts (e.g. target requested ppm, but cell contains ℃ dp or mA)
    if (targetUnits.length > 0 && textUnits.length > 0) {
      const hasOverlap = targetUnits.some(u => textUnits.includes(u));
      if (!hasOverlap) {
        // Unit conflict -> Skip! (F05)
        continue;
      }
    }

    let isFull = normText === normTarget;
    let isAlias = !isFull && aliases.some(a => normText === a || normText.includes(a));
    let isSub = !isFull && !isAlias && (normText.includes(normTarget) || normTarget.includes(normText));

    // Avoid matching common word "Analyzer" alone across different measurement columns
    if (isSub && (normTarget === 'analyzer' || normText === 'analyzer')) {
      if (targetUnits.length > 0 && textUnits.length === 0) {
        // Needs unit confirmation
      } else {
        continue;
      }
    }

    if (isFull || isAlias || isSub) {
      let score = 0.8;
      let status = 'NO_MATCH';
      let reason = '部分匹配';

      if (isFull) {
        score = 1.0;
        status = 'FULL_MATCH';
        reason = '完整匹配';
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

      // Find candidate value position (e.g., adjacent cell to the right or next paragraph)
      let candidateValue = '';
      let valueLocation = null;

      if (item.type === 'cell') {
        const rightCell = docItems.find(
          x => x.type === 'cell' && x.tableIdx === item.tableIdx && x.rowIdx === item.rowIdx && x.colIdx === item.colIdx + 1
        );
        if (rightCell) {
          candidateValue = rightCell.text.trim();
          valueLocation = { tableIdx: rightCell.tableIdx, rowIdx: rightCell.rowIdx, colIdx: rightCell.colIdx };
        }
      } else if (item.type === 'paragraph') {
        if (i + 1 < docItems.length) {
          candidateValue = docItems[i + 1].text.trim();
          valueLocation = { paragraphIdx: i + 1 };
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
        candidateValue
      });
    }
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);

  let matchStatus = 'NO_MATCH';
  if (candidates.length === 1) {
    matchStatus = candidates[0].status;
  } else if (candidates.length > 1) {
    matchStatus = 'MULTI_CANDIDATE';
  }

  return {
    label: targetLabel,
    matchCount: candidates.length,
    matchStatus,
    candidates
  };
}

module.exports = {
  normalizeText,
  findFieldCandidates,
  ALIAS_MAP
};
