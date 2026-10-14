import sys
import os
import json
import shutil
import stat

def process_word_document(template_path, output_path, data):
    """
    Process Word template (.doc or .docx), perform text replacements and table updates.
    Preserves original template file completely (R17).
    """
    if not os.path.exists(template_path):
        raise FileNotFoundError(f"Template not found: {template_path}")

    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Ensure output file is not read-only
    if os.path.exists(output_path):
        try:
            os.chmod(output_path, stat.S_IWRITE | stat.S_IREAD)
        except Exception:
            pass

    if not os.path.exists(output_path) or os.path.abspath(template_path) != os.path.abspath(output_path):
        shutil.copy2(template_path, output_path)

    try:
        os.chmod(output_path, stat.S_IWRITE | stat.S_IREAD)
    except Exception:
        pass

    doc_type = data.get('type', 'cert') # 'cert' or 'packing'
    form_data = data.get('formData', {})

    is_windows = sys.platform.startswith('win')

    if is_windows:
        try:
            import win32com.client
            app = None
            try:
                app = win32com.client.Dispatch("KWps.Application")
            except Exception:
                try:
                    app = win32com.client.Dispatch("Wps.Application")
                except Exception:
                    app = win32com.client.Dispatch("Word.Application")

            if app is not None:
                app.Visible = False
                try:
                    app.DisplayAlerts = 0
                except Exception:
                    pass

                doc = app.Documents.Open(os.path.abspath(output_path))

                model = str(form_data.get('model', ''))
                device_sn = str(form_data.get('deviceSn', ''))
                shipping_location = str(form_data.get('shippingLocation') or '')
                sensor_model = str(form_data.get('sensorModel', ''))
                sensor_sn = str(form_data.get('sensorSn', ''))
                cert_date = str(form_data.get('certDate') or form_data.get('date') or '')
                has_pump = bool(form_data.get('hasPump', True))
                # 保护行/传感器行由该任务绑定模板的 protectedRows/packingItems 决定，
                # 不再用型号名称（含 POA）推导 (整改 B.1/B.5)，否则 POA3500 会被误当成 POA200
                is_pump_model = 'POA' in model.upper()
                field_mappings = data.get('fieldMappings') or data.get('field_mappings') or {}
                packing_cfg_items = field_mappings.get('packingItems') or []
                has_sensor_row_configured = False
                sensor_row_name = '传感器'
                sensor_data_index = -1
                for _idx, _cfg in enumerate(packing_cfg_items):
                    if _cfg.get('isProtectedSensor') or str(_cfg.get('name') or '') == '传感器':
                        has_sensor_row_configured = True
                        sensor_data_index = _idx
                        if _cfg.get('name'):
                            sensor_row_name = str(_cfg.get('name'))
                        break
                if not has_sensor_row_configured and sensor_model:
                    has_sensor_row_configured = True

                def set_cell_text(tbl, row, col, value):
                    """完整覆写单元格文本，避免 Range.Text 在存在格式标记时变成追加（如 19.998 mA mA）"""
                    if value is None:
                        return False
                    try:
                        rng = tbl.Cell(row, col).Range
                        try:
                            rng.MoveEnd(1, -1)  # wdCharacter=1，排除单元格结束标记
                        except Exception:
                            pass
                        rng.Text = str(value)
                        return True
                    except Exception:
                        return False

                # Replace default SN AP10007513 in StoryRanges
                if device_sn and device_sn != "AP10007513":
                    for story in doc.StoryRanges:
                        try:
                            find = story.Find
                            find.Text = "AP10007513"
                            find.Replacement.Text = device_sn
                            find.Execute(Replace=2)
                        except Exception:
                            pass

                if doc.Tables.Count >= 1:
                    table = doc.Tables.Item(1)

                    if doc_type == 'cert':
                        ambient_temp = str(form_data.get('ambientTemp', '')) if form_data.get('ambientTemp') is not None else ''
                        relative_humidity = str(form_data.get('relativeHumidity', '')) if form_data.get('relativeHumidity') is not None else ''

                        field_mappings = data.get('fieldMappings')
                        if not field_mappings:
                            field_mappings = data.get('field_mappings') or {}
                        tc = field_mappings.get('tableConfig')
                        if not tc:
                            tc = data.get('tableConfig') or {}
                        target_t_idx = (int(tc.get('tableIdx')) + 1) if (tc.get('tableIdx') is not None) else 1

                        if target_t_idx <= doc.Tables.Count:
                            target_table = doc.Tables.Item(target_t_idx)
                        else:
                            target_table = doc.Tables.Item(1)

                        # 1. Smart label scanning for single fields across tables (XP-07, XP-08, X64-08)
                        for t_i in range(1, doc.Tables.Count + 1):
                            tbl = doc.Tables.Item(t_i)
                            cell_count = tbl.Range.Cells.Count
                            for c_i in range(1, cell_count):
                                try:
                                    c_txt = tbl.Range.Cells.Item(c_i).Range.Text.replace('\r', '').replace('\x07', '').replace('\n', '').strip()
                                    if cert_date and (c_txt == "Date:" or c_txt == "Date" or c_txt.endswith("Date:") or c_txt == "日期:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = cert_date
                                    elif device_sn and (c_txt == "Inst. SN." or c_txt == "Inst. SN" or c_txt == "SN." or c_txt == "序列号:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = device_sn
                                    elif model and (c_txt == "Instrument" or c_txt == "仪器型号:" or c_txt == "型号:"):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = model
                                    elif ambient_temp and ("Ambient Temperature" in c_txt or "环境温度" in c_txt):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = f"{ambient_temp} ℃" if "℃" not in ambient_temp else ambient_temp
                                    elif relative_humidity and ("Relative Humidity" in c_txt or "相对湿度" in c_txt):
                                        next_cell = tbl.Range.Cells.Item(c_i + 1)
                                        rng = next_cell.Range
                                        try: rng.MoveEnd(1, -1)
                                        except Exception: pass
                                        rng.Text = f"{relative_humidity} %RH" if "%RH" not in relative_humidity else relative_humidity
                                except Exception:
                                    continue

                        # 2. Measurement Points in Certificate (X64-09, XP-09)
                        test_points = form_data.get('testPoints', [])
                        columns = tc.get('columns', []) if tc else []
                        start_r = tc.get('startRow', 12) + 1 if tc and tc.get('startRow') is not None else 13
                        end_r = tc.get('endRow', start_r + len(test_points) - 2) + 1 if tc and tc.get('endRow') is not None else (start_r + len(test_points) - 1)
                        template_data_rows = (end_r - start_r + 1) if (end_r >= start_r) else 0

                        if columns and start_r > 1:
                            header_r = tc.get('headerRow', start_r - 2) + 1 if 'headerRow' in tc else start_r - 1
                            if 1 <= header_r <= target_table.Rows.Count:
                                for col_def in columns:
                                    c_idx = col_def.get('colIdx', 0) + 1
                                    c_lbl = col_def.get('label')
                                    if c_lbl:
                                        try:
                                            target_table.Cell(header_r, c_idx).Range.Text = str(c_lbl)
                                        except Exception:
                                            try: table.Cell(header_r, c_idx).Range.Text = str(c_lbl)
                                            except Exception: pass

                        for idx, tp in enumerate(test_points):
                            r_idx = start_r + idx
                            if target_table.Rows.Count >= r_idx:
                                if columns:
                                    for col_def in columns:
                                        c_idx = col_def.get('colIdx', 0) + 1
                                        c_key = col_def.get('key')
                                        val = None
                                        vals = tp.get('values', {})
                                        if c_key in vals: val = vals[c_key]
                                        elif str(col_def.get('colIdx')) in vals: val = vals[str(col_def.get('colIdx'))]
                                        elif col_def.get('label') in vals: val = vals[col_def.get('label')]
                                        elif col_def.get('isSeq') and tp.get('name'): val = tp.get('name')
                                        elif col_def.get('isStd') and tp.get('std') is not None: val = tp.get('std')
                                        elif col_def.get('isAct') and tp.get('act') is not None: val = tp.get('act')
                                        if val is not None:
                                            set_cell_text(target_table, r_idx, c_idx, str(val))
                                else:
                                    std_val = tp.get('std') if tp.get('std') is not None else tp.get('standard')
                                    act_val = tp.get('act') if tp.get('act') is not None else tp.get('actual')
                                    pt_name = tp.get('name') if tp.get('name') is not None else tp.get('label')
                                    if pt_name is not None and target_table.Columns.Count >= 1:
                                        set_cell_text(target_table, r_idx, 1, str(pt_name))
                                    if std_val is not None and target_table.Columns.Count >= 2:
                                        set_cell_text(target_table, r_idx, 2, str(std_val))
                                    if act_val is not None and target_table.Columns.Count >= 3:
                                        set_cell_text(target_table, r_idx, 3, str(act_val))

                    elif doc_type == 'packing':
                        clean_sn = device_sn[3:].strip() if (device_sn.startswith("SN:") or device_sn.startswith("SN：")) else device_sn.strip()
                        clean_sensor_sn = sensor_sn[3:].strip() if (sensor_sn.startswith("SN:") or sensor_sn.startswith("SN：")) else sensor_sn.strip()
                        pump_str = "带泵" if (is_pump_model and has_pump) else ""
                        main_remark = f"SN: {clean_sn} {pump_str}".strip() if pump_str else f"SN: {clean_sn}"
                        sensor_remark_str = f"SN: {clean_sensor_sn}" if clean_sensor_sn else ""
                        packing_items = form_data.get('packingItems', [])
                        first_data_row = 2

                        # Dynamic column detection (XP-10, X64-10)
                        col_seq, col_name, col_spec, col_count, col_unit, col_std, col_remark = 1, 2, 3, 4, 5, 6, 7
                        try:
                            for c in range(1, table.Columns.Count + 1):
                                hdr_txt = str(table.Cell(1, c).Range.Text).replace('\r', '').replace('\x07', '').replace('\n', '').strip()
                                if "序号" in hdr_txt or hdr_txt.lower() in ("no", "seq"): col_seq = c
                                elif "名称" in hdr_txt or "物料" in hdr_txt or hdr_txt.lower() == "name": col_name = c
                                elif "规格" in hdr_txt or "型号" in hdr_txt or hdr_txt.lower() == "spec": col_spec = c
                                elif "数量" in hdr_txt or hdr_txt.lower() in ("qty", "count"): col_count = c
                                elif "单位" in hdr_txt or hdr_txt.lower() == "unit": col_unit = c
                                elif "标配" in hdr_txt or "标准" in hdr_txt or hdr_txt.lower() == "standard": col_std = c
                                elif "备注" in hdr_txt or hdr_txt.lower() == "remark": col_remark = c
                        except Exception: pass

                        # Locate main device index and sensor index (supports non-first main row, XP-10)
                        main_data_index = -1
                        for _i, _it in enumerate(packing_items):
                            it_name = str(_it.get('name') or '').strip()
                            if main_data_index < 0 and (it_name.startswith('主设备') or _it.get('isProtectedMain') or _it.get('isProtected') or _it.get('isMain')):
                                main_data_index = _i
                            if has_sensor_row_configured and sensor_data_index < 0 and (it_name == sensor_row_name or _it.get('isProtectedSensor')):
                                sensor_data_index = _i
                        if main_data_index < 0 and len(packing_items) > 0:
                            main_data_index = 0

                        # 按行名称识别真实存在的保护行 (整改 B.5/B.6)
                        for _r in range(2, table.Rows.Count + 1):
                            try:
                                _name = str(table.Cell(_r, col_name).Range.Text).strip()
                            except Exception:
                                continue
                            if _name.startswith('主设备'):
                                if model:
                                    set_cell_text(table, _r, col_spec, model)
                                set_cell_text(table, _r, col_remark, main_remark)
                            elif has_sensor_row_configured and _name == sensor_row_name:
                                if sensor_model:
                                    set_cell_text(table, _r, col_spec, sensor_model)
                                set_cell_text(table, _r, col_remark, sensor_remark_str)

                        if packing_items:
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
                                if r < first_data_row or r > table.Rows.Count:
                                    break
                                set_cell_text(table, r, col_seq, str(idx + 1))
                                if item.get('name') is not None:
                                    set_cell_text(table, r, col_name, str(item.get('name')))
                                if idx == main_data_index and model:
                                    set_cell_text(table, r, col_spec, model)
                                elif sensor_data_index >= 0 and idx == sensor_data_index and sensor_model:
                                    set_cell_text(table, r, col_spec, sensor_model)
                                elif item.get('spec') is not None:
                                    set_cell_text(table, r, col_spec, str(item.get('spec')))
                                if item.get('count') is not None:
                                    set_cell_text(table, r, col_count, str(item.get('count')))
                                if item.get('unit') is not None:
                                    set_cell_text(table, r, col_unit, str(item.get('unit')))
                                if item.get('standard') is not None:
                                    set_cell_text(table, r, col_std, str(item.get('standard')))
                                if idx == main_data_index:
                                    set_cell_text(table, r, col_remark, main_remark)
                                elif sensor_data_index >= 0 and idx == sensor_data_index:
                                    set_cell_text(table, r, col_remark, sensor_remark_str)
                                elif item.get('remark') is not None:
                                    set_cell_text(table, r, col_remark, str(item.get('remark')))

                doc.Save()
                doc.Close(False)
                app.Quit()
                return
        except Exception as e:
            print(f"win32com processing fallback: {e}", file=sys.stderr)

    # Cross-platform / python-docx fallback
    try:
        import docx
        if output_path.endswith('.docx'):
            doc = docx.Document(output_path)
            device_sn = form_data.get('deviceSn', '')
            if device_sn:
                for p in doc.paragraphs:
                    if 'AP10007513' in p.text:
                        p.text = p.text.replace('AP10007513', device_sn)
                for table in doc.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            if 'AP10007513' in cell.text:
                                cell.text = cell.text.replace('AP10007513', device_sn)
            doc.save(output_path)
    except Exception as e:
        print(f"docx processing notice: {e}", file=sys.stderr)

    print(f"Document processed successfully: {output_path}")

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: doc_processor.py <template_path> <output_path> <json_data_path>")
        sys.exit(1)

    template_p = sys.argv[1]
    output_p = sys.argv[2]
    json_data_p = sys.argv[3]

    with open(json_data_p, 'r', encoding='utf-8') as f:
        data_content = json.load(f)

    process_word_document(template_p, output_p, data_content)
