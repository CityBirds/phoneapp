/**
 * Field Position Candidate Finder and Matcher Engine
 * Rules: T03, C04
 */

function normalizeText(text) {
  if (!text) return '';
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Match a target label against document structural items (paragraphs & table cells)
 * @param {string} targetLabel - e.g. "Inst. SN." or "Customer" or "Analyzer pv ppm"
 * @param {Array} docItems - list of items extracted from doc { type: 'paragraph'|'cell', text, tableIdx, rowIdx, colIdx }
 */
function findFieldCandidates(targetLabel, docItems) {
  const normTarget = normalizeText(targetLabel);
  const candidates = [];

  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    const normText = normalizeText(item.text);

    if (normText.includes(normTarget) || normTarget.includes(normText)) {
      // Find candidate value position (e.g., adjacent cell or next paragraph)
      let candidateValue = '';
      let valueLocation = null;

      if (item.type === 'cell') {
        // Check adjacent cell to the right
        const rightCell = docItems.find(
          x => x.type === 'cell' && x.tableIdx === item.tableIdx && x.rowIdx === item.rowIdx && x.colIdx === item.colIdx + 1
        );
        if (rightCell) {
          candidateValue = rightCell.text.trim();
          valueLocation = { tableIdx: rightCell.tableIdx, rowIdx: rightCell.rowIdx, colIdx: rightCell.colIdx };
        }
      } else if (item.type === 'paragraph') {
        // Next paragraph or same paragraph after colon
        if (i + 1 < docItems.length) {
          candidateValue = docItems[i + 1].text.trim();
          valueLocation = { paragraphIdx: i + 1 };
        }
      }

      candidates.push({
        matchedLabel: item.text.trim(),
        score: normText === normTarget ? 1.0 : 0.8,
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

  return {
    label: targetLabel,
    matchCount: candidates.length,
    candidates
  };
}

module.exports = {
  normalizeText,
  findFieldCandidates
};
