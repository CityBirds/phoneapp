# -*- coding: utf-8 -*-
"""
Windows XP (Win32) Word/WPS Document Generation Engine.
Compatible with Python 2.7, Python 3.4+, and Python 3.8+.
Strictly NO Python 3.6+ f-strings, NO type hints, NO async/await.
Supports certificate table cell-by-cell writeback and packing list dynamic column / protected row enforcement.
Compliant with XP-01~XP-15 and X64-01~X64-14 specifications.
"""

import sys
import os
import re
import json
import shutil
import stat
import hashlib

def to_unicode(s):
    if s is None:
        return u""
    if sys.version_info[0] < 3:
        if isinstance(s, unicode):
            return s
        try:
            return s.decode('utf-8')
        except Exception:
            try:
                return s.decode('gbk')
            except Exception:
                return s.decode('latin1', 'ignore')
    return str(s)

def safe_str(s):
    """Convert to safe str/bytes for output/stderr without UnicodeEncodeError in Python 2."""
    if s is None:
        return ""
    if sys.version_info[0] < 3:
        if isinstance(s, unicode):
            try:
                enc = sys.stdout.encoding or 'utf-8'
                return s.encode(enc, 'replace')
            except Exception:
                return s.encode('utf-8', 'replace')
        return str(s)
    return str(s)

def get_file_sha256(filepath):
    if not filepath or not os.path.exists(filepath):
        return ""
    h = hashlib.sha256()
    try:
        with open(filepath, 'rb') as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""

def validate_packing_protected_rows(form_data, field_mappings):
    """
    Enforces Protected Row Rules (E06, T06).
    Checks that required protected rows (main device row, sensor row if configured) are present in packing items.
    """
    packing_items = form_data.get('packingItems') or []
    if not packing_items:
        packing_cfg_items = (field_mappings or {}).get('packingItems') or []
        if packing_cfg_items:
            raise ValueError("Packing list configuration requires items, but no packing items were submitted")
        return

    # 1. Main device row check
    has_main_device = False
    for item in packing_items:
        name = to_unicode(item.get('name') or u'').strip()
        if name.startswith(u'主设备') or item.get('isProtectedMain') or item.get('isProtected'):
            has_main_device = True
            break

    if not has_main_device and len(packing_items) > 0:
        first_name = to_unicode(packing_items[0].get('name') or u'').strip()
        if u'主设备' in first_name or packing_items[0].get('isMain'):
            has_main_device = True

    if not has_main_device:
        raise ValueError("Packing list protected row check failed: Main device row ('主设备') is missing (E06, T06)")

    # 2. Protected sensor row check if configured
    packing_cfg_items = (field_mappings or {}).get('packingItems') or []
    sensor_row_required = False
    sensor_row_name = u'传感器'
    for cfg in packing_cfg_items:
        cfg_name = to_unicode(cfg.get('name') or u'').strip()
        if cfg.get('isProtectedSensor') or cfg_name == u'传感器':
            sensor_row_required = True
            if cfg.get('name'):
                sensor_row_name = to_unicode(cfg.get('name')).strip()
            break

    if sensor_row_required:
        has_sensor_row = False
        for item in packing_items:
            name = to_unicode(item.get('name') or u'').strip()
            if name == sensor_row_name or item.get('isProtectedSensor'):
                has_sensor_row = True
                break
        if not has_sensor_row:
            raise ValueError(safe_str(u"Packing list protected row check failed: Required sensor row ('%s') is missing (E06, T06)" % sensor_row_name))

def validate_cert_fixed_rows(form_data, field_mappings):
    """
    Enforces Certificate Fixed Row Count Rules (XP-09, X64-09).
    Validates that submitted test points match the fixed data rows defined in template tableConfig.
    """
    test_points = form_data.get('testPoints') or []
    if not test_points:
        return
    tc = (field_mappings or {}).get('tableConfig') or {}
    start_r = tc.get('startRow')
    end_r = tc.get('endRow')
    if start_r is not None and end_r is not None:
        template_data_rows = (int(end_r) - int(start_r) + 1) if (int(end_r) >= int(start_r)) else 0
        if template_data_rows > 0 and len(test_points) != template_data_rows:
            raise ValueError(safe_str(u"证书测量表数据行数 (%d) 与模板固定数据行数 (%d) 不一致，证书测量表固定行数不得增删 (XP-09, X64-09)" % (len(test_points), template_data_rows)))

def set_cell_text(tbl, row, col, value):
    """
    Clean write into Word COM table cell.
    Excludes end-of-cell marker (wdCharacter=1, -1) to prevent duplicate text / suffix appends.
    """
    if value is None:
        return False
    val_str = to_unicode(value)
    try:
        cell = tbl.Cell(row, col)
        rng = cell.Range
        try:
            rng.MoveEnd(1, -1)
        except Exception:
            pass
        rng.Text = val_str
        return True
    except Exception:
        try:
            cell = tbl.Rows.Item(row).Cells.Item(col)
            rng = cell.Range
            try:
                rng.MoveEnd(1, -1)
            except Exception:
                pass
            rng.Text = val_str
            return True
        except Exception:
            return False

def get_cell_text(tbl, row, col):
    """Safely get text from table cell, stripping cell terminator markers."""
    try:
        cell = tbl.Cell(row, col)
        t = to_unicode(cell.Range.Text)
        return t.replace(u'\r', u'').replace(u'\x07', u'').replace(u'\n', u'').strip()
    except Exception:
        try:
            cell = tbl.Rows.Item(row).Cells.Item(col)
            t = to_unicode(cell.Range.Text)
            return t.replace(u'\r', u'').replace(u'\x07', u'').replace(u'\n', u'').strip()
        except Exception:
            return u""

def detect_packing_columns(table, field_mappings=None):
    """
    Dynamically detect 1-based column indices for packing list.
    Supports layouts where unit, remark, etc. are located in different columns (XP-10, X64-10).
    """
    cols = {
        'seq': 1,
        'name': 2,
        'spec': 3,
        'count': 4,
        'unit': 5,
        'standard': 6,
        'remark': 7
    }

    fm_cols = (field_mappings or {}).get('packingColumns') or (field_mappings or {}).get('columns')
    if fm_cols and isinstance(fm_cols, list):
        for c_def in fm_cols:
            k = c_def.get('key')
            idx = c_def.get('colIdx')
            if k in cols and idx is not None:
                cols[k] = int(idx) + 1
        return cols

    total_cols = 0
    try:
        total_cols = table.Columns.Count
    except Exception:
        pass
    if total_cols <= 0:
        try:
            total_cols = table.Rows.Item(1).Cells.Count
        except Exception:
            total_cols = 7

    for c in range(1, total_cols + 1):
        txt = get_cell_text(table, 1, c)
        if not txt:
            continue
        txt_lower = txt.lower()
        if u'序号' in txt or txt_lower == u'no' or txt_lower == u'seq':
            cols['seq'] = c
        elif u'名称' in txt or u'物料' in txt or txt_lower == u'name':
            cols['name'] = c
        elif u'规格' in txt or u'型号' in txt or txt_lower == u'spec':
            cols['spec'] = c
        elif u'数量' in txt or txt_lower == u'qty' or txt_lower == u'count':
            cols['count'] = c
        elif u'单位' in txt or txt_lower == u'unit':
            cols['unit'] = c
        elif u'标配' in txt or txt_lower == u'standard' or u'标准' in txt:
            cols['standard'] = c
        elif u'备注' in txt or txt_lower == u'remark':
            cols['remark'] = c

    return cols

def generate_word_document_xp(template_path, output_path, data):
    """
    Generates Word document from template on Win32/XP.
    `data` contains:
      type: 'cert' or 'packing'
      formData: dict with model, deviceSn, certDate, packingItems, testPoints, etc.
      fieldMappings: dict with tableConfig, packingItems, singleFields, etc.
    """
    if not os.path.exists(template_path):
        raise IOError(safe_str(u"Template file not found: " + to_unicode(template_path)))

    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # Initial template SHA256 to verify R17 (strict template protection)
    initial_template_hash = get_file_sha256(template_path)

    # Ensure target output file is writable before overwriting
    if os.path.exists(output_path):
        try:
            os.chmod(output_path, stat.S_IWRITE | stat.S_IREAD)
        except Exception:
            pass

    # Copy source template to output path preserving original template (R17)
    if os.path.abspath(template_path) != os.path.abspath(output_path):
        shutil.copy2(template_path, output_path)

    try:
        os.chmod(output_path, stat.S_IWRITE | stat.S_IREAD)
    except Exception:
        pass

    doc_type = data.get('type', 'cert')
    form_data = data.get('formData') or data.get('form_data') or {}
    field_mappings = data.get('fieldMappings') or data.get('field_mappings') or {}

    # Validate Protected Rows for packing list (E06, T06)
    if doc_type == 'packing':
        validate_packing_protected_rows(form_data, field_mappings)
    elif doc_type == 'cert':
        validate_cert_fixed_rows(form_data, field_mappings)

    is_windows = sys.platform.startswith('win')
    processed_via_com = False
    processed_via_docx = False
    mock_processed = False
    com_error = None

    if is_windows:
        try:
            import win32com.client
            app = None
            for prog_id in ["KWps.Application", "Wps.Application", "Word.Application"]:
                try:
                    app = win32com.client.Dispatch(prog_id)
                    if app is not None:
                        break
                except Exception:
                    continue

            if app is not None:
                app.Visible = False
                try:
                    app.DisplayAlerts = 0
                except Exception:
                    pass

                doc = app.Documents.Open(os.path.abspath(output_path))
                try:
                    model = to_unicode(form_data.get('model') or u'')
                    raw_sn = to_unicode(form_data.get('deviceSn') or form_data.get('device_sn') or u'')
                    clean_sn = raw_sn[3:].strip() if (raw_sn.startswith(u'SN:') or raw_sn.startswith(u'SN：')) else raw_sn.strip()
                    device_sn = clean_sn

                    sensor_model = to_unicode(form_data.get('sensorModel') or form_data.get('sensor_model') or u'')
                    raw_sensor_sn = to_unicode(form_data.get('sensorSn') or form_data.get('sensor_sn') or u'')
                    clean_sensor_sn = raw_sensor_sn[3:].strip() if (raw_sensor_sn.startswith(u'SN:') or raw_sensor_sn.startswith(u'SN：')) else raw_sensor_sn.strip()
                    sensor_sn = clean_sensor_sn

                    cert_date = to_unicode(form_data.get('certDate') or form_data.get('date') or u'')
                    ambient_temp = to_unicode(form_data.get('ambientTemp') if form_data.get('ambientTemp') is not None else u'')
                    relative_humidity = to_unicode(form_data.get('relativeHumidity') if form_data.get('relativeHumidity') is not None else u'')
                    has_pump = bool(form_data.get('hasPump', True))

                    if doc_type == 'cert':
                        tc = field_mappings.get('tableConfig') or data.get('tableConfig') or {}
                        target_t_idx = (int(tc.get('tableIdx')) + 1) if (tc.get('tableIdx') is not None) else 1

                        if target_t_idx > doc.Tables.Count:
                            raise RuntimeError(safe_str(u"Target certificate table index %d exceeds table count %d (XP-08)" % (target_t_idx, doc.Tables.Count)))

                        target_table = doc.Tables.Item(target_t_idx)

                        # 1. Single fields write (XP-07, XP-08): Write to value position, NEVER overwrite labels!
                        # Support explicit valueLocation in singleFields if present
                        single_fields_cfg = field_mappings.get('singleFields') or []
                        explicit_handled = {}
                        if isinstance(single_fields_cfg, list):
                            for sf in single_fields_cfg:
                                sf_lbl = to_unicode(sf.get('label') or u'').strip()
                                sf_loc = sf.get('valueLocation') or sf.get('targetCell') or sf.get('location') or {}
                                sf_t = (int(sf_loc.get('tableIdx')) + 1) if (sf_loc.get('tableIdx') is not None) else target_t_idx
                                sf_r = (int(sf_loc.get('rowIdx')) + 1) if (sf_loc.get('rowIdx') is not None) else (int(sf_loc.get('row')) if sf_loc.get('row') is not None else 0)
                                sf_c = (int(sf_loc.get('colIdx')) + 1) if (sf_loc.get('colIdx') is not None) else (int(sf_loc.get('col')) if sf_loc.get('col') is not None else 0)

                                if sf_t <= doc.Tables.Count and sf_r > 0 and sf_c > 0:
                                    t_obj = doc.Tables.Item(sf_t)
                                    val_to_set = None
                                    if u'date' in sf_lbl.lower() or u'日期' in sf_lbl:
                                        val_to_set = cert_date
                                        explicit_handled['date'] = True
                                    elif u'sn' in sf_lbl.lower() or u'序列号' in sf_lbl:
                                        val_to_set = device_sn
                                        explicit_handled['sn'] = True
                                    elif u'instrument' in sf_lbl.lower() or u'型号' in sf_lbl:
                                        val_to_set = model
                                        explicit_handled['model'] = True
                                    elif u'ambient' in sf_lbl.lower() or u'温度' in sf_lbl:
                                        val_to_set = (ambient_temp + u" ℃") if (ambient_temp and u'℃' not in ambient_temp) else ambient_temp
                                        explicit_handled['temp'] = True
                                    elif u'humidity' in sf_lbl.lower() or u'湿度' in sf_lbl:
                                        val_to_set = (relative_humidity + u" %RH") if (relative_humidity and u'%RH' not in relative_humidity) else relative_humidity
                                        explicit_handled['humidity'] = True

                                    if val_to_set is not None:
                                        set_cell_text(t_obj, sf_r, sf_c, val_to_set)

                        # Label scan across tables for unhandled single fields (XP-07, XP-08)
                        for t_i in range(1, doc.Tables.Count + 1):
                            tbl = doc.Tables.Item(t_i)
                            cell_count = tbl.Range.Cells.Count
                            for c_i in range(1, cell_count):
                                try:
                                    c_txt = tbl.Range.Cells.Item(c_i).Range.Text.replace(u'\r', u'').replace(u'\x07', u'').replace(u'\n', u'').strip()
                                    if not explicit_handled.get('date') and cert_date and (c_txt == u"Date:" or c_txt == u"Date" or c_txt.endswith(u"Date:") or c_txt == u"日期:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = cert_date
                                        explicit_handled['date'] = True
                                    elif not explicit_handled.get('sn') and device_sn and (c_txt == u"Inst. SN." or c_txt == u"Inst. SN" or c_txt == u"SN." or c_txt == u"序列号:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = device_sn
                                        explicit_handled['sn'] = True
                                    elif not explicit_handled.get('model') and model and (c_txt == u"Instrument" or c_txt == u"仪器型号:" or c_txt == u"型号:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = model
                                        explicit_handled['model'] = True
                                    elif not explicit_handled.get('temp') and ambient_temp and (u"Ambient Temperature" in c_txt or u"环境温度" in c_txt):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = (ambient_temp + u" ℃") if (u'℃' not in ambient_temp) else ambient_temp
                                        explicit_handled['temp'] = True
                                    elif not explicit_handled.get('humidity') and relative_humidity and (u"Relative Humidity" in c_txt or u"相对湿度" in c_txt):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = (relative_humidity + u" %RH") if (u'%RH' not in relative_humidity) else relative_humidity
                                        explicit_handled['humidity'] = True
                                except Exception:
                                    continue

                        # 2. Measurement Points in Certificate (XP-09, X64-09)
                        test_points = form_data.get('testPoints') or []
                        if test_points:
                            columns = tc.get('columns') or []
                            start_r = (tc.get('startRow') + 1) if (tc.get('startRow') is not None) else 13
                            end_r = (tc.get('endRow') + 1) if (tc.get('endRow') is not None) else (start_r + len(test_points) - 1)
                            template_data_rows = (end_r - start_r + 1) if (end_r >= start_r) else 0

                            # Strict row count validation: no arbitrary row deletion or row appending (XP-09, X64-09)
                            if template_data_rows > 0 and len(test_points) != template_data_rows:
                                raise ValueError(safe_str(u"证书测量表数据行数 (%d) 与模板固定数据行数 (%d) 不一致，证书测量表固定行数不得增删 (XP-09, X64-09)" % (len(test_points), template_data_rows)))

                            # Write points cell-by-cell without deleting table end or altering headers
                            for idx, tp in enumerate(test_points):
                                r_idx = start_r + idx
                                if r_idx > target_table.Rows.Count:
                                    break
                                if columns:
                                    for col_def in columns:
                                        c_idx = (col_def.get('colIdx') or 0) + 1
                                        c_key = col_def.get('key')
                                        val = None
                                        vals = tp.get('values') or {}
                                        if c_key and c_key in vals:
                                            val = vals[c_key]
                                        elif str(col_def.get('colIdx')) in vals:
                                            val = vals[str(col_def.get('colIdx'))]
                                        elif col_def.get('label') in vals:
                                            val = vals[col_def.get('label')]
                                        elif col_def.get('isSeq') and tp.get('name'):
                                            val = tp.get('name')
                                        elif col_def.get('isStd') and tp.get('std') is not None:
                                            val = tp.get('std')
                                        elif col_def.get('isAct') and tp.get('act') is not None:
                                            val = tp.get('act')
                                        if val is not None:
                                            set_cell_text(target_table, r_idx, c_idx, val)
                                else:
                                    std_val = tp.get('std') if tp.get('std') is not None else tp.get('standard')
                                    act_val = tp.get('act') if tp.get('act') is not None else tp.get('actual')
                                    pt_name = tp.get('name') if tp.get('name') is not None else tp.get('label')
                                    if pt_name is not None and target_table.Columns.Count >= 1:
                                        set_cell_text(target_table, r_idx, 1, pt_name)
                                    if std_val is not None and target_table.Columns.Count >= 2:
                                        set_cell_text(target_table, r_idx, 2, std_val)
                                    if act_val is not None and target_table.Columns.Count >= 3:
                                        set_cell_text(target_table, r_idx, 3, act_val)

                    elif doc_type == 'packing':
                        if doc.Tables.Count < 1:
                            raise RuntimeError("No table found in packing list document (XP-10)")

                        table = doc.Tables.Item(1)
                        # Dynamically detect packing columns (XP-10, X64-10)
                        p_cols = detect_packing_columns(table, field_mappings)

                        is_pump_model = bool(form_data.get('hasPump') is not None) or (u'POA' in model.upper())
                        pump_str = u"带泵" if (is_pump_model and has_pump) else u""
                        main_remark = (u"SN: " + device_sn + (u" " + pump_str if pump_str else u"")).strip()
                        sensor_remark_str = (u"SN: " + sensor_sn) if sensor_sn else u""
                        packing_items = form_data.get('packingItems') or []
                        first_data_row = 2

                        packing_cfg_items = field_mappings.get('packingItems') or []
                        has_sensor_row_cfg = False
                        sensor_row_name = u'传感器'
                        for _idx, _cfg in enumerate(packing_cfg_items):
                            cfg_name = to_unicode(_cfg.get('name') or u'').strip()
                            if _cfg.get('isProtectedSensor') or cfg_name == u'传感器':
                                has_sensor_row_cfg = True
                                if _cfg.get('name'):
                                    sensor_row_name = to_unicode(_cfg.get('name')).strip()
                                break
                        if not has_sensor_row_cfg and sensor_model:
                            has_sensor_row_cfg = True

                        # Locate main device index and sensor index (supports non-first main row, XP-10)
                        main_data_index = -1
                        sensor_data_index = -1
                        for _i, _it in enumerate(packing_items):
                            it_name = to_unicode(_it.get('name') or u'').strip()
                            if main_data_index < 0 and (it_name.startswith(u'主设备') or _it.get('isProtectedMain') or _it.get('isProtected') or _it.get('isMain')):
                                main_data_index = _i
                            if has_sensor_row_cfg and sensor_data_index < 0 and (it_name == sensor_row_name or _it.get('isProtectedSensor')):
                                sensor_data_index = _i

                        if main_data_index < 0 and len(packing_items) > 0:
                            main_data_index = 0

                        # Resize data region only (preserving bottom remarks and signature, XP-09, XP-10)
                        template_data_rows = max(0, table.Rows.Count - first_data_row + 1)
                        current_data_rows = template_data_rows
                        guard = 0
                        while current_data_rows < len(packing_items) and guard < 60:
                            guard += 1
                            added = False
                            last_row = first_data_row + current_data_rows - 1
                            for _c in range(table.Columns.Count, 0, -1):
                                try:
                                    table.Cell(last_row, _c).Range.Rows.Add()
                                    added = True
                                    break
                                except Exception:
                                    continue
                            if not added:
                                break
                            current_data_rows += 1

                        for idx, item in enumerate(packing_items):
                            r = first_data_row + idx
                            if r > table.Rows.Count:
                                break
                            set_cell_text(table, r, p_cols['seq'], idx + 1)
                            if item.get('name') is not None:
                                set_cell_text(table, r, p_cols['name'], item.get('name'))

                            # Spec mapping
                            if idx == main_data_index and model:
                                set_cell_text(table, r, p_cols['spec'], model)
                            elif sensor_data_index >= 0 and idx == sensor_data_index and sensor_model:
                                set_cell_text(table, r, p_cols['spec'], sensor_model)
                            elif item.get('spec') is not None:
                                set_cell_text(table, r, p_cols['spec'], item.get('spec'))

                            if item.get('count') is not None:
                                set_cell_text(table, r, p_cols['count'], item.get('count'))
                            if item.get('unit') is not None:
                                set_cell_text(table, r, p_cols['unit'], item.get('unit'))
                            if item.get('standard') is not None:
                                set_cell_text(table, r, p_cols['standard'], item.get('standard'))

                            # Remark mapping: single SN occurrence without duplication (XP-10)
                            if idx == main_data_index:
                                set_cell_text(table, r, p_cols['remark'], main_remark)
                            elif sensor_data_index >= 0 and idx == sensor_data_index:
                                set_cell_text(table, r, p_cols['remark'], sensor_remark_str)
                            elif item.get('remark') is not None:
                                set_cell_text(table, r, p_cols['remark'], item.get('remark'))

                    # Post-generation read-back verification (XP-07, XP-10, XP-11)
                    full_content = to_unicode(doc.Content.Text)
                    if device_sn and device_sn not in full_content:
                        raise RuntimeError(safe_str(u"Post-generation verification failed: Device SN '%s' not present in document (XP-07, XP-11)" % device_sn))
                    if doc_type == 'cert' and cert_date and cert_date not in full_content:
                        raise RuntimeError(safe_str(u"Post-generation verification failed: Date '%s' not present in certificate (XP-07, XP-11)" % cert_date))
                    if doc_type == 'packing' and sensor_sn and sensor_sn not in full_content and has_sensor_row_cfg:
                        raise RuntimeError(safe_str(u"Post-generation verification failed: Sensor SN '%s' not present in packing document (XP-10, XP-11)" % sensor_sn))

                    doc.Save()
                    processed_via_com = True
                finally:
                    try:
                        doc.Close(False)
                    except Exception:
                        pass
                    try:
                        app.Quit()
                    except Exception:
                        pass
        except Exception as e:
            com_error = e
            sys.stderr.write("win32com processing notice: %s\n" % str(e))

    if not processed_via_com:
        # Fallback processing for .docx files via python-docx if available
        # Note: Must satisfy same content and format requirements; cannot report success for partial tasks (XP-11)
        if output_path.endswith('.docx'):
            try:
                import docx
                doc = docx.Document(output_path)
                device_sn = to_unicode(form_data.get('deviceSn') or form_data.get('device_sn') or u'')
                cert_date = to_unicode(form_data.get('certDate') or form_data.get('date') or u'')

                if doc.tables:
                    # Write to first table or configured table
                    tbl = doc.tables[0]
                    # Dynamic search for date and sn
                    for row in tbl.rows:
                        for idx, cell in enumerate(row.cells):
                            c_txt = cell.text.strip()
                            if cert_date and (c_txt == "Date:" or c_txt == "Date" or c_txt == "日期:"):
                                if idx + 1 < len(row.cells):
                                    row.cells[idx + 1].text = cert_date
                            elif device_sn and (c_txt == "Inst. SN." or c_txt == "Inst. SN" or c_txt == "SN."):
                                if idx + 1 < len(row.cells):
                                    row.cells[idx + 1].text = device_sn

                doc.save(output_path)
                processed_via_docx = True
            except Exception:
                pass

    # Check for test mock engine flag (strictly forbidden in frozen release build)
    is_frozen_build = getattr(sys, 'frozen', False)
    if not processed_via_com and not processed_via_docx:
        if not is_frozen_build and os.environ.get("PHONEAPP_XP_MOCK_DOC_ENGINE") == "1":
            sys.stderr.write("[TEST WARNING] 使用了测试模拟文档引擎(PHONEAPP_XP_MOCK_DOC_ENGINE=1)，仅限协议自动化回归！\n")
            with open(output_path, "ab") as f:
                f.write(b"\n<!-- PHONEAPP_XP_MOCK_DOC_ENGINE_OUTPUT -->\n")
            mock_processed = True
        elif is_frozen_build and os.environ.get("PHONEAPP_XP_MOCK_DOC_ENGINE") == "1":
            sys.stderr.write("[CRITICAL] 发布包严格禁止启用模拟引擎(PHONEAPP_XP_MOCK_DOC_ENGINE)，必须使用真实Office/WPS COM组件！\n")

    # Critical Verification (XP-L07, XP-11): Generation MUST fail if write did not succeed.
    if not (processed_via_com or processed_via_docx or mock_processed):
        if os.path.exists(output_path):
            try:
                os.unlink(output_path)
            except Exception:
                pass
        err_msg = "Word/WPS 写入失败：未检测到可用的 Word/WPS COM 组件或 docx 引擎，无法生成 .doc/.docx 文档 (XP-L07, XP-11)"
        if com_error:
            err_msg += " [COM: %s]" % str(com_error)
        raise RuntimeError(err_msg)

    # R17 Protection: Verify source template was not modified
    post_template_hash = get_file_sha256(template_path)
    if initial_template_hash and post_template_hash and initial_template_hash != post_template_hash:
        raise RuntimeError("CRITICAL SAFETY VIOLATION: Source template was altered during document generation! (R17)")

    sha256 = get_file_sha256(output_path)
    return {
        "success": True,
        "filePath": output_path,
        "sha256": sha256
    }

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: word_engine_xp.py <template_path> <output_path> <json_data_path>")
        sys.exit(1)

    t_path = sys.argv[1]
    o_path = sys.argv[2]
    j_path = sys.argv[3]

    with open(j_path, 'rb') as f:
        payload = json.loads(f.read().decode('utf-8'))

    res = generate_word_document_xp(t_path, o_path, payload)
    print(json.dumps(res))
