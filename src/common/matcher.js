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
  '传感器': ['传感器'],
  '销售人员': ['sales', 'salesperson', 'rep', '销售', '销售人员', 'customer', '客户']
};

const KNOWN_UNITS = ['ppm', '℃ dp', '℃', '°c', 'ma', '%rh', 'rh'];
const FOOTER_TEXT_REGEX = /(we here?by certify|comments\s*&\s*observations|for and on behalf of|phymetrix|manager|authorized signature|印章|签名|声明|签字|备注说明)/i;

/**
 * 证书测量表头的特征词。
 * 仅在“区域识别”和“该格是否位于测量数据区上方”两点上使用；
 * 不能让特征词本身成为用户必填业务字段（整改 3.1）。
 */
const MEASUREMENT_HEADER_PATTERNS = [
  /test\s*point/, /testpoint/, /测试点/, /^序号$/, /^序\s*号$/,
  /\bstep\b/, /\bgas\b/, /介质/, /标准气体/,
  /\bnist\b/, /standard/, /nominal/, /标准值?/, /\bvalue\b/, /\breading\b/,
  /analyzer/, /measured/, /actual/, /indication/, /\boutput\b/, /\bma\b/, /\bppm\b/, /℃/, /°c/, /%rh/, /\bdp\b/
];

/**
 * 描述区（单值区）字段特征。这些字段即使右侧/下方有数字，也只是单值字段，
 * 绝不允许升级成整列测量数据（整改 3.1：Date、Inst. SN. 等）。
 */
const SINGLE_VALUE_LABEL_PATTERNS = [
  /^date\b/, /日期/, /^inst\.?\s*sn/, /serial\s*no/, /^s\/?n\b/, /仪器编号/,
  /^instrument\b/, /仪器(?!包装)/, /^customer\b/, /客户/, /销售/, /^sales\b/,
  /ambient/, /humidity/, /温度/, /湿度/, /destination/, /目的地/, /地址/, /^address\b/, /报告编号/, /^model\b/,
  /^tel\b/, /电话/, /传真/, /^fax\b/, /^page\b/
];

/**
 * 清单（装箱清单）表头特征。用于定位物料表头行，不作为业务必填字段本身。
 */
const PACKING_HEADER_PATTERNS = [
  /^序号$/, /名称/, /品名/, /^规格/, /型号$/, /数量/, /单位/, /标配/, /备注/, /说明/, /物料/
];

/** 清单行角色关键字：这些是“行角色”，不是列字段（整改 B03）。 */
const PACKING_MAIN_DEVICE_KEYWORDS = ['主设备', '主机', '本体', '主机设备'];
const PACKING_SENSOR_KEYWORDS = ['传感器', '探头'];
const PACKING_ACCESSORY_KEYWORDS = ['仪器包装箱', '包装箱', '用户手册', '操作说明', '合格证', '说明书'];

function compactLabel(text) {
  return normalizeText(text).replace(/[\s_.·・\-—/\\()（）\[\]【】]/g, '');
}

/**
 * 是否“明确”的测量表头标签。用于表头行选择与单值区判定。
 * 只认结构性特征词，避免把 "23.5℃" 这类单位数值误当成表头（整改 3.1）。
 */
const STRONG_MEASUREMENT_HEADER_PATTERNS = [
  /test\s*point/, /testpoint/, /测试点/, /^序号$/, /^序\s*号$/,
  /\bstep\b/, /\bgas\b/, /介质/, /标准气体/,
  /\bnist\b/, /analyzer/, /measured/, /actual\s*(reading|value)/,
  /指示值?/, /实测/, /标准值/, /\bnominal\b/, /traceable/,
  /reading/, /\bvalue\b/, /\boutput\b/
];

/** 测量点/序号锚点：出现即强烈指征“这一行就是测量表头”。 */
const MEASUREMENT_ANCHOR_PATTERN = /test\s*point\s*number|testpointnumber|测试点|^序号$|^序\s*号$/;

function isExplicitMeasurementHeaderLabel(label) {
  const norm = normalizeText(label);
  if (!norm || norm.length > 60) return false;
  return STRONG_MEASUREMENT_HEADER_PATTERNS.some(re => re.test(norm));
}

function isMeasurementAnchorLabel(label) {
  const norm = normalizeText(label);
  if (!norm || norm.length > 40) return false;
  return MEASUREMENT_ANCHOR_PATTERN.test(norm);
}

function isExplicitPackingHeaderLabel(label) {
  const norm = normalizeText(label);
  if (!norm || norm.length > 30) return false;
  if (/^序号$/.test(norm) || /^序\s*号$/.test(norm)) return true;
  return PACKING_HEADER_PATTERNS.some(re => re.test(norm));
}

function isPackingAnchorLabel(label) {
  const norm = normalizeText(label);
  if (!norm) return false;
  return /^序号$/.test(norm) || /^序\s*号$/.test(norm);
}

function isMeasurementHeaderLabel(label) {
  const norm = normalizeText(label);
  if (!norm) return false;
  if (isSingleValueLabel(label)) return false;
  return MEASUREMENT_HEADER_PATTERNS.some(re => re.test(norm));
}

function isPackingHeaderLabel(label) {
  const norm = normalizeText(label);
  if (!norm) return false;
  return PACKING_HEADER_PATTERNS.some(re => re.test(norm));
}

function isSingleValueLabel(label) {
  const norm = normalizeText(label);
  if (!norm) return false;
  if (norm.includes('test point') || norm.includes('testpoint')) return false;
  return SINGLE_VALUE_LABEL_PATTERNS.some(re => re.test(norm));
}

function collectTableCells(docItems, tableIdx) {
  return (docItems || []).filter(x => x.type === 'cell' && x.tableIdx === tableIdx);
}

function dotFindCell(docItems, tableIdx, rowIdx, colIdx) {
  return (docItems || []).find(x => x.type === 'cell' && x.tableIdx === tableIdx && x.rowIdx === rowIdx && x.colIdx === colIdx);
}

/**
 * 检测文档中的表格区域（区域先于字段匹配，整改 3.1）。
 *
 * @param {Array} docItems 解析产物（保留真实表格编号/行列/文本）
 * @param {{type?: 'cert'|'packing'}} [options]
 * @returns {Array<{tableIdx:number, kind:'measurement'|'packing', headerRow:number,
 *   dataStartRow:number, dataEndRow:number, headerColumns:Array<{colIdx:number,label:string}>,
 *   rowIndices:number[], ambiguous:boolean}>}
 */
function detectTableRegions(docItems, options = {}) {
  const type = options.type || 'cert';
  const cells = (docItems || []).filter(x => x.type === 'cell');
  if (cells.length === 0) return [];

  const isPacking = type === 'packing';
  const headerPredicate = isPacking ? isPackingHeaderLabel : isMeasurementHeaderLabel;
  const tables = [...new Set(cells.map(x => x.tableIdx))].sort((a, b) => a - b);
  const regions = [];

  for (const tableIdx of tables) {
    const tCells = collectTableCells(docItems, tableIdx);
    const rows = [...new Set(tCells.map(x => x.rowIdx))].sort((a, b) => a - b);
    if (rows.length === 0) continue;

    const explicitPredicate = isPacking ? isExplicitPackingHeaderLabel : isExplicitMeasurementHeaderLabel;
    const anchorPredicate = isPacking ? isPackingAnchorLabel : isMeasurementAnchorLabel;
    const softPredicate = headerPredicate;

    // 1. 表头行选择：锚点行（Test point Number / 序号）优先，其次明确表头特征最多的行
    const scored = rows.map(r => {
      const rowCells = tCells.filter(x => x.rowIdx === r && x.text && String(x.text).trim());
      const explicitCells = rowCells.filter(x => explicitPredicate(x.text));
      const anchorCells = rowCells.filter(x => anchorPredicate(x.text));
      const softCells = rowCells.filter(x => softPredicate(x.text));
      return { row: r, rowCells, explicitCells, anchorCells, softCells };
    });

    const anchored = scored.filter(s => s.anchorCells.length > 0 && s.explicitCells.length >= 2);
    const denseExplicit = scored.filter(s => s.explicitCells.length >= 2);
    let header = null;
    if (anchored.length > 0) {
      header = anchored[0];
    } else if (denseExplicit.length > 0) {
      header = denseExplicit[denseExplicit.length - 1];
    } else {
      const softBest = Math.max(...scored.map(s => s.softCells.length));
      const softCandidates = scored.filter(s => s.softCells.length === softBest && softBest >= 1);
      const dense = softCandidates.filter(s => s.rowCells.length >= 3);
      header = dense.length > 0 ? dense[dense.length - 1] : (softCandidates[0] || null);
    }
    if (!header) continue;

    const headerRow = header.row;

    // 2. 数据区必须位于表头下方，终止于下一逻辑区域/签章说明区
    const nextHeaderThreshold = Math.max(2, header.explicitCells.length > 0 ? header.explicitCells.length : header.softCells.length);

    const rowIndices = [];
    let previousRow = headerRow;
    for (const r of rows) {
      if (r <= headerRow) continue;
      if (r !== previousRow + 1) break;
      const rowCells = tCells.filter(x => x.rowIdx === r);
      const nonEmpty = rowCells.filter(x => x.text && String(x.text).trim());
      if (nonEmpty.length === 0) break;
      // 遇到下一逻辑区域（说明/签章/第二个表头）即终止，不跨区域拼接
      if (nonEmpty.some(c => FOOTER_TEXT_REGEX.test(c.text || ''))) break;
      const explicitish = nonEmpty.filter(c => explicitPredicate(c.text));
      if (explicitish.length >= nextHeaderThreshold && explicitish.length >= 2) break;
      rowIndices.push(r);
      previousRow = r;
    }

    if (rowIndices.length === 0) continue;

    // 3. 表头列：优先使用该行识别出的真实列，否则用该行的非空短标签格子
    let headerColumns = header.explicitCells
      .map(c => ({ colIdx: c.colIdx, label: String(c.text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter(c => c.label);
    if (headerColumns.length < 2) {
      headerColumns = header.rowCells
        .filter(c => {
          const t = String(c.text).trim();
          return t && (explicitPredicate(t) || (t.length <= 40 && !isNumericText(t)));
        })
        .map(c => ({ colIdx: c.colIdx, label: String(c.text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() }))
        .filter(c => c.label);
    }
    headerColumns.sort((a, b) => a.colIdx - b.colIdx);
    if (headerColumns.length < 2) continue;

    const allHeaderLabels = header.rowCells.map(c => normalizeText(c.text)).filter(Boolean);
    const recognized = header.explicitCells.length;
    const hasAnchor = header.anchorCells.length > 0;
    // 无锚点且明确表头不足 2 列时，区域定位不可靠，必须提示管理员一次确认
    const ambiguous = !hasAnchor && recognized < 2;

    regions.push({
      tableIdx,
      kind: isPacking ? 'packing' : 'measurement',
      headerRow,
      dataStartRow: rowIndices[0],
      dataEndRow: rowIndices[rowIndices.length - 1],
      rowCount: rowIndices.length,
      rowIndices,
      headerColumns,
      colStart: headerColumns[0].colIdx,
      colEnd: headerColumns[headerColumns.length - 1].colIdx,
      headerLabels: allHeaderLabels,
      ambiguous,
      source: 'detected'
    });
  }

  // 同一表格只保留一个最佳区域：优先“有 Test point Number/序号特征”的表头，其次数据行最多
  const byTable = new Map();
  for (const region of regions) {
    const prev = byTable.get(region.tableIdx);
    if (!prev) { byTable.set(region.tableIdx, region); continue; }
    const scoreOf = (r) => (r.headerColumns.some(c => /test\s*point|testpoint|测试点|^序号$/.test(normalizeText(c.label))) ? 100 : 0) + r.rowCount;
    if (scoreOf(region) > scoreOf(prev)) byTable.set(region.tableIdx, region);
  }

  return [...byTable.values()].sort((a, b) => a.tableIdx - b.tableIdx);
}

/** 判断某一单元格是否位于该区域的测量表头行上（忽略换行/空格差异）。 */
function isRegionHeaderItem(region, item) {
  if (!region || !item || item.type !== 'cell') return false;
  if (item.tableIdx !== region.tableIdx) return false;
  if (item.rowIdx !== region.headerRow) return false;
  return item.colIdx >= region.colStart && item.colIdx <= region.colEnd;
}

/** 找到包含该单元格的区域（同一表格内）。 */
function findRegionForItem(regions, item) {
  if (!regions || !item || item.type !== 'cell') return null;
  return (regions || []).find(r => r.tableIdx === item.tableIdx) || null;
}

/**
 * 判断“左标签 + 右取值”的单值结构：
 * 标签格右侧存在紧邻的取值格，且右侧格子不是明确的测量表头（整改 3.1）。
 * 注意：右侧格是 "23.5℃" 这类带单位数值时仍是合法取值，不能当作表头拒绝。
 */
function resolveSingleValueLocation(item, docItems) {
  if (!item || item.type !== 'cell') return null;
  const tableCells = collectTableCells(docItems, item.tableIdx);
  const rightCell = tableCells.find(x => x.rowIdx === item.rowIdx && x.colIdx === item.colIdx + 1);
  if (!rightCell) return null;
  if (isExplicitMeasurementHeaderLabel(rightCell.text) || isMeasurementAnchorLabel(rightCell.text)) return null;
  return { type: 'cell', tableIdx: item.tableIdx, rowIdx: item.rowIdx, colIdx: item.colIdx + 1 };
}

/**
 * 把清单表头映射到业务字段键。只使用模板真实存在的表头，不虚构列（整改 3.4）。
 * @returns {Array<{field:string, label:string, colIdx:number}>}
 */
function resolvePackingHeaderFields(headerColumns) {
  const mapField = (label) => {
    const norm = normalizeText(label);
    if (!norm) return null;
    if (/^序号$/.test(norm) || /^序\s*号$/.test(norm) || /^no\.?$/.test(norm) || /^item$/.test(norm)) return 'index';
    if (/名称|品名|物料名称|description/.test(norm)) return 'name';
    if (/规格|型号|spec/.test(norm)) return 'spec';
    if (/数量|count|qty|quantity/.test(norm)) return 'count';
    if (/单位|unit/.test(norm)) return 'unit';
    if (/标配|标准配置|standard/.test(norm)) return 'standard';
    if (/备注|说明|remark|note/.test(norm)) return 'remark';
    return null;
  };

  const fields = [];
  const used = new Set();
  for (const col of (headerColumns || [])) {
    const field = mapField(col.label);
    if (!field || used.has(field)) continue;
    used.add(field);
    fields.push({ field, label: col.label, colIdx: col.colIdx });
  }
  return fields;
}

/**
 * 识别清单中的行角色：主设备 / 传感器 / 参考仪器 / 普通物料。
 * “主设备”“传感器”是行角色而不是列字段（整改 B03）。
 */
function assignPackingRowRoles(rows, options = {}) {
  const snPattern = /SN[:：]?\s*([A-Za-z0-9_\-]+)/i;
  const roles = (rows || []).map((row, idx) => {
    const cells = (row.cells || []).map(c => String(c.text || '').trim());
    const joined = cells.filter(Boolean).join(' ');
    const firstCol = cells[0] || '';
    const allText = [firstCol, joined].join(' ');
    let role = 'material';
    let sn = null;

    const snMatch = joined.match(snPattern);
    if (snMatch) sn = snMatch[1];

    if (PACKING_MAIN_DEVICE_KEYWORDS.some(k => allText.includes(k))) role = 'mainDevice';
    else if (PACKING_SENSOR_KEYWORDS.some(k => allText.includes(k))) role = 'sensor';
    else if (/参考仪器|标准器|reference/i.test(allText)) role = 'reference';
    else if (PACKING_ACCESSORY_KEYWORDS.some(k => allText.includes(k))) role = 'accessory';

    return {
      rowIdx: row.rowIdx !== undefined ? row.rowIdx : idx,
      role,
      sn,
      name: cells.find((c, i) => i > 0 && c) || firstCol,
      cells
    };
  });

  // 无显式角色关键字时按 SN 语义推断（真实备注/独立序号格），歧义时保持 material
  const hasExplicitRole = roles.some(r => r.role === 'mainDevice');
  if (!hasExplicitRole) {
    const firstWithSn = roles.find(r => r.sn);
    if (firstWithSn) firstWithSn.role = 'mainDevice';
  }
  const hasSensorKeyword = roles.some(r => r.role === 'sensor');
  if (!hasSensorKeyword) {
    const sensorLike = roles.find(r => r.role === 'material' && /传感器|sensor|probe|探头/i.test(r.cells.join(' ')));
    if (sensorLike) sensorLike.role = 'sensor';
  }

  return roles;
}

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
  str = str.replace(/\s*(℃|°c|%rh|ppm)/gi, ' $1');
  str = str.replace(/\s*(\bma\b)/gi, ' $1');

  return str
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractUnits(text) {
  const norm = normalizeText(text);
  const found = [];
  for (const u of KNOWN_UNITS) {
    if (u === 'ma') {
      if (/\bma\b/i.test(norm) || /(?:^|[\s\(\[\{（])ma(?:$|[\s\)\]\}）])/i.test(norm)) {
        found.push('ma');
      }
    } else if (norm.includes(u.toLowerCase())) {
      found.push(u.toLowerCase());
    }
  }
  return found;
}

function isNumericText(text) {
  if (!text) return false;
  const cleaned = String(text).trim().replace(/[℃°c%rhppmma\s]/gi, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned);
}

function isTableColumnHeaderLabel(label) {
  if (!label) return false;
  const norm = normalizeText(label);
  return norm.includes('test point number') || norm.includes('testpointnumber') ||
         norm.includes('nist') || norm.includes('analyzer') ||
         norm === 'value' || norm.includes('value') || norm.includes('reading') || norm.includes('actual') ||
         norm === 'gas' || norm.includes('gas') || norm.includes('output') || norm.includes('standard') ||
         norm.includes('measured') || norm.includes('point') || norm.includes('nominal') ||
         norm === '序号' || norm === '名称' || norm.includes('规格') || norm === '数量' || norm === '单位' || norm === '标配' || norm === '备注';
}

/**
 * 提取某“表头格”下方的数据格。
 *
 * 整改 3.1：先限定测量区，再收集数据。
 * - 描述区单值字段（Date、Inst. SN. 等）永远不返回列数据；
 * - 位于测量表头上方/区域外的格子不返回列数据；
 * - 数据区必须在本表头下方连续，终止于下一逻辑区域、签章/说明区或非空行断裂；
 * - 不能按“清单 7 列 / 证书 3 列”的固定步长跨区域扫描。
 */
function getTableColumnDataCells(item, docItems, targetLabel, regions) {
  if (!item || !docItems || !Array.isArray(docItems)) return [];

  const normTarget = normalizeText(targetLabel || item.text);

  // 1. 描述区单值字段绝不升级为整列
  if (isSingleValueLabel(targetLabel) || isSingleValueLabel(item.text)) return [];

  const region = findRegionForItem(regions, item);
  const onRegionHeader = region ? isRegionHeaderItem(region, item) : false;

  if (region) {
    // 区域内的表头行：只有表头格子本身才有列数据
    if (item.rowIdx === region.headerRow && !onRegionHeader) return [];
    // 表头行之上（描述区）或数据区之下：不是列头
    if (item.rowIdx < region.headerRow) return [];
  }

  // 已由区域识别确认的表头行：该行上的每个格子都是真实列头，
  // 无需再依赖关键词（整改 3.1：数据区限定在自身表头下方）。
  if (onRegionHeader) {
    const headerTableCells = collectTableCells(docItems, item.tableIdx);
    const headerRowCells = [];
    let prevHeaderRow = item.rowIdx;
    const headerRowsBelow = [...new Set(headerTableCells.map(x => x.rowIdx))]
      .filter(r => r > item.rowIdx)
      .sort((a, b) => a - b);
    for (const r of headerRowsBelow) {
      if (r !== prevHeaderRow + 1) break;
      const rowCells = headerTableCells.filter(x => x.rowIdx === r);
      const nonEmpty = rowCells.filter(c => c.text && String(c.text).trim());
      if (nonEmpty.length === 0) break;
      if (nonEmpty.some(c => FOOTER_TEXT_REGEX.test(c.text || ''))) break;
      const colCell = rowCells.find(c => c.colIdx === item.colIdx);
      if (colCell && colCell.text && String(colCell.text).trim()) {
        headerRowCells.push(colCell);
        prevHeaderRow = r;
      } else {
        break;
      }
    }
    return headerRowCells;
  }

  const isHeaderLabel = isTableColumnHeaderLabel(targetLabel) || isTableColumnHeaderLabel(item.text);

  const tableCells = collectTableCells(docItems, item.tableIdx);
  const rowIndicesBelow = [...new Set(tableCells.map(x => x.rowIdx))]
    .filter(r => r > item.rowIdx)
    .sort((a, b) => a - b);

  // 未识别出区域时，不允许对非表头特征的单值字段做向下探测（整改 3.1）
  if (!region && !isHeaderLabel) return [];

  const gridDataCells = [];
  let prevRow = item.rowIdx;
  for (const r of rowIndicesBelow) {
    if (r !== prevRow + 1) break;
    const rowCells = tableCells.filter(x => x.rowIdx === r);
    const nonEmpty = rowCells.filter(c => c.text && String(c.text).trim());
    if (nonEmpty.length === 0) break;
    if (nonEmpty.some(c => FOOTER_TEXT_REGEX.test(c.text || ''))) break;
    const colCell = rowCells.find(c => c.colIdx === item.colIdx);
    if (colCell && colCell.text && String(colCell.text).trim()) {
      gridDataCells.push(colCell);
      prevRow = r;
    } else if (colCell) {
      // 保留区域内真实存在的空格（不补造数据），但连续两个空行即认为区域结束
      const nextRowCells = tableCells.filter(x => x.rowIdx === r + 1);
      const nextColCell = nextRowCells.find(x => x.colIdx === item.colIdx);
      if (colCell && nextColCell && nextColCell.text && String(nextColCell.text).trim()) {
        gridDataCells.push(colCell);
        prevRow = r;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // 数据列探测：仅作为表头特征缺失时的补充证据
  let hasNumericDataBelow = false;
  if (gridDataCells.length >= 2) {
    const nonEmptyCells = gridDataCells.filter(c => c.text && String(c.text).trim());
    const numericCells = nonEmptyCells.filter(c => isNumericText(c.text));
    if (nonEmptyCells.length >= 2 && (numericCells.length / nonEmptyCells.length) >= 0.5) {
      hasNumericDataBelow = true;
    }
  }

  let isRowHeader = false;
  const sameRowCells = tableCells.filter(x => x.rowIdx === item.rowIdx && x.text && String(x.text).trim());
  if (sameRowCells.length >= 3) {
    const headersOnRow = sameRowCells.filter(x => isTableColumnHeaderLabel(x.text));
    if (headersOnRow.length >= 2) {
      isRowHeader = true;
    }
  }

  if (gridDataCells.length > 0 && (isHeaderLabel || hasNumericDataBelow || isRowHeader || onRegionHeader)) {
    return gridDataCells;
  }

  return [];
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
 * @param {string|object} [options] - 'cert' | 'packing' | { type, regions }
 */
function findFieldCandidates(targetLabel, docItems, options = {}) {
  const opts = typeof options === 'string' ? { type: options } : (options || {});
  const docType = opts.type || 'cert';
  const regions = Array.isArray(opts.regions) ? opts.regions : detectTableRegions(docItems, { type: docType });
  const normTarget = normalizeText(targetLabel);
  const isSingleLabel = isSingleValueLabel(targetLabel);
  const inferredType = inferFieldType(targetLabel, isSingleLabel ? 'single' : 'single');

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
      let fullValues = [];

      if (item.type === 'cell') {
        const tableIdx = item.tableIdx;
        const rowIdx = item.rowIdx;
        const colIdx = item.colIdx;

        const dataCellsBelow = getTableColumnDataCells(item, docItems, targetLabel, regions);

        const isSeqNumCol = normTarget === '序号' || normTarget.includes('test point number') || isTestPointMatch;

        if (dataCellsBelow.length > 0) {
          if (isSeqNumCol) {
            const firstNumeric = dataCellsBelow.findIndex(c => /^\d+$/.test(String(c.text || '').trim()));
            fullValues = dataCellsBelow.map((c, idx) => {
              const raw = String(c.text || '').trim();
              if (/^\d+$/.test(raw)) return raw;
              return firstNumeric === -1 ? String(idx + 1) : raw;
            });
            sampleValues = fullValues.slice(0, 5);
          } else {
            fullValues = dataCellsBelow.map(c => (c.text ? String(c.text).trim() : ''));
            sampleValues = fullValues.slice(0, 5);
          }
          candidateValue = null;
          valueLocation = { type: 'table_column', tableIdx, colIdx, startRow: rowIdx + 1, endRow: rowIdx + dataCellsBelow.length };
        } else {
          const singleLoc = resolveSingleValueLocation(item, docItems);
          if (singleLoc) {
            const rightCell = dotFindCell(docItems, tableIdx, rowIdx, singleLoc.colIdx);
            candidateValue = rightCell && rightCell.text ? rightCell.text.trim() : '';
            valueLocation = singleLoc;
          } else {
            const tableCells = collectTableCells(docItems, tableIdx);
            const rightCell = tableCells.find(x => x.rowIdx === rowIdx && x.colIdx === colIdx + 1);
            if (rightCell && isMeasurementHeaderLabel(rightCell.text)) {
              candidateValue = '列名标题行(需按列数据绑定)';
              valueLocation = null;
            } else {
              candidateValue = '未绑定';
            }
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

      const region = findRegionForItem(regions, item);
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
        // 是否为单值字段：区域表头行上的列头为 false，描述区字段为 true
        isSingleValue: item.type === 'cell'
          ? !(region && isRegionHeaderItem(region, item))
          : true,
        regionId: region ? `region_${region.tableIdx}_${region.kind}` : null,
        candidateValue,
        sampleValues,
        fullValues: fullValues || []
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

  const chosen = candidates[0];
  const resolvedType = chosen && chosen.suggestedValueLocation && chosen.suggestedValueLocation.type === 'table_column'
    ? 'table'
    : inferredType;

  return {
    label: targetLabel,
    inferredType: resolvedType,
    tableRegions: regions,
    matchCount: candidates.length,
    matchStatus,
    candidates
  };
}

module.exports = {
  normalizeText,
  extractUnits,
  findFieldCandidates,
  inferFieldType,
  isDateFieldLabel,
  isMeasurementHeaderLabel,
  isSingleValueLabel,
  isPackingHeaderLabel,
  getTableColumnDataCells,
  detectTableRegions,
  assignPackingRowRoles,
  resolvePackingHeaderFields,
  ALIAS_MAP,
  MEASUREMENT_HEADER_PATTERNS,
  PACKING_HEADER_PATTERNS
};
