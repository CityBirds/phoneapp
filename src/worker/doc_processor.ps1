param(

    [string]$templatePath,

    [string]$outputPath,

    [string]$jsonPath

)



[Console]::OutputEncoding = [System.Text.Encoding]::UTF8



# PowerShell Native Word/WPS COM Document Processor

# Rules: E05, E06, R17, T03, T04, T05, T06, 03-Spec Sec 8-9



# Unset ReadOnly attribute on target output file if present

if (Test-Path $outputPath) {

    Set-ItemProperty -Path $outputPath -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue

}



if (-not (Test-Path $jsonPath)) {

    Write-Error "JSON data file not found: $jsonPath"

    exit 1

}



$jsonData = Get-Content -Path $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

$type = $jsonData.type

$formData = $jsonData.formData

$fieldMappings = $jsonData.fieldMappings

# 临时诊断日志（设置 DSH_DEBUG_LOG 环境变量为日志路径时启用）
$script:DebugLog = $env:DSH_DEBUG_LOG
function Write-Dbg([string]$msg) {
    if ($script:DebugLog) {
        try { Add-Content -Path $script:DebugLog -Value ("[PS1] " + $msg) -Encoding UTF8 } catch {}
    }
}



# Auto-detect and prioritize WPS Office (KWps.Application) or MS Word (Word.Application)

$app = $null



try {

    $app = New-Object -ComObject "KWps.Application" -ErrorAction Stop

} catch {

    try {

        $app = New-Object -ComObject "Wps.Application" -ErrorAction Stop

    } catch {

        try {

            $app = New-Object -ComObject "Word.Application" -ErrorAction Stop

        } catch {

            Write-Warning "Neither WPS Office nor Microsoft Word COM object is available."

            exit 0

        }

    }

}



if ($null -eq $app) {

    exit 0

}



# Configure silent execution

try { $app.Visible = $false } catch {}

try { $app.DisplayAlerts = 0 } catch {}



$doc = $null

try {

    $absOutputPath = (Resolve-Path $outputPath).Path

    $doc = $app.Documents.Open($absOutputPath)



    if ($null -eq $doc) {

        Write-Error "Failed to open document at $absOutputPath"

        exit 1

    }



    # Extract form fields

    $model = if ($formData.model) { [string]$formData.model } else { "" }

    $deviceSn = if ($formData.deviceSn) { [string]$formData.deviceSn } else { "" }

    $shippingLocation = if ($formData.shippingLocation) { [string]$formData.shippingLocation } else { "" }

    $sensorModel = if ($formData.sensorModel) { [string]$formData.sensorModel } else { "" }

    $sensorSn = if ($formData.sensorSn) { [string]$formData.sensorSn } else { "" }

    $ambientTemp = if ($null -ne $formData.ambientTemp) { [string]$formData.ambientTemp } else { "" }

    $relativeHumidity = if ($null -ne $formData.relativeHumidity) { [string]$formData.relativeHumidity } else { "" }

    $certDate = if ($formData.certDate) { [string]$formData.certDate } elseif ($formData.date) { [string]$formData.date } else { "" }

    $hasPump = if ($null -ne $formData.hasPump) { [bool]$formData.hasPump } else { $true }

    # 保护行/传感器行由该任务实际绑定模板的 protectedRows / packingItems 决定，
    # 不再用型号名称（含 POA）推导 —— 否则 POA3500 会被误当成 POA200 要求传感器行 (2.B)
    $isPumpModel = ($model -like "*POA*")
    $hasSensorRowConfigured = $false
    $sensorRowName = "传感器"
    try {
        if ($fieldMappings -and $fieldMappings.packingItems) {
            foreach ($cfgItem in $fieldMappings.packingItems) {
                if ($cfgItem.isProtectedSensor -or "$($cfgItem.name)" -eq "传感器") {
                    $hasSensorRowConfigured = $true
                    if ("$($cfgItem.name)" -ne "") { $sensorRowName = "$($cfgItem.name)" }
                }
            }
        }
    } catch {}
    if (-not $hasSensorRowConfigured -and "$sensorModel" -ne "") { $hasSensorRowConfigured = $true }

    # 单元格完整覆写，避免 Range.Text 在存在格式标记时变成"追加"（例如写入 19.998 mA 后变成 19.998 mA mA）(3.C.4)
    function Set-CellText {
        param($Table, [int]$Row, [int]$Col, $Value)
        if ($null -eq $Value) { return $false }
        $str = [string]$Value
        try {
            $cell = $Table.Cell($Row, $Col)
            $rng = $cell.Range
            $rng.MoveEnd(1, -1) | Out-Null   # wdCharacter=1，排除单元格结束标记
            $rng.Text = $str
            return $true
        } catch {}
        try {
            $cell = $Table.Rows.Item($Row).Cells.Item($Col)
            $rng = $cell.Range
            $rng.MoveEnd(1, -1) | Out-Null
            $rng.Text = $str
            return $true
        } catch {}
        return $false
    }

    # 只在测量数据区内增删行：在"最后一行数据行"的某个单元格上 Range.Rows.Add()，
    # 新行会插入到该数据行之后、声明/签字行之前；
    # 绝不追加到表格末尾，也绝不使用 Rows.Item(n).Select()（含纵向合并单元格时不可用）(3.C.6)
    #
    # 参数说明：TemplateDataRows = 模板配置的数据行数（tableConfig.endRow - startRow + 1）。
    # 该值决定哪些行属于测量数据区，避免把表格中的声明/签字行误当成数据行。
    function Set-MeasurementRowCount {
        param($Table, [int]$FirstDataRow, [int]$TargetRows, [int]$TemplateDataRows = 0)
        if ($TargetRows -lt 0) { return $false }
        $colCount = $Table.Columns.Count

        if ($TemplateDataRows -le 0) {
            # 未配置 endRow：无法确定数据区边界，不做增删，避免误改非测量区域
            Write-Dbg "Set-MeasurementRowCount: TemplateDataRows unknown, skip resize"
            return $false
        }

        $currentDataRows = $TemplateDataRows
        $guard = 0
        while ($currentDataRows -lt $TargetRows -and $guard -lt 60) {
            $guard++
            $added = $false
            # 当前最后一行数据行
            $lastDataRow = $FirstDataRow + $currentDataRows - 1
            for ($tryCol = $colCount; $tryCol -ge 1; $tryCol--) {
                try {
                    $rng = $Table.Cell($lastDataRow, $tryCol).Range
                    $null = $rng.Rows.Add()
                    $added = $true
                    break
                } catch {}
            }
            if (-not $added) { break }
            $currentDataRows++
        }
        $guard = 0
        while ($currentDataRows -gt $TargetRows -and $guard -lt 60) {
            $guard++
            $lastDataRow = $FirstDataRow + $currentDataRows - 1
            $deleted = $false
            for ($tryCol = $colCount; $tryCol -ge 1; $tryCol--) {
                try {
                    $rng = $Table.Cell($lastDataRow, $tryCol).Range
                    $rng.Rows.Delete()
                    $deleted = $true
                    break
                } catch {}
            }
            if (-not $deleted) { break }
            $currentDataRows--
        }
        return $true
    }



    # Global text replacement for default SN AP10007513 in StoryRanges

    if ($deviceSn -and $deviceSn -ne "AP10007513") {

        foreach ($story in $doc.StoryRanges) {

            try {

                $find = $story.Find

                $find.Text = "AP10007513"

                $find.Replacement.Text = $deviceSn

                [void]$find.Execute("AP10007513", $true, $true, $false, $false, $false, $true, 1, $false, $deviceSn, 2)

            } catch {}

        }

    }



    if ($type -eq "cert") {

        # Calibration Certificate Replacement

        if ($doc.Tables.Count -ge 1) {

            $table = $doc.Tables.Item(1)



            # Smart label matching across all cells (handles merged cells robustly)

            # Customer is strictly PRESERVED as static template original (J02, J07)

            $foundDate = $false

            $foundSn = $false

            $foundModel = $false

            $foundTemp = $false

            $foundHumidity = $false



            for ($i = 1; $i -lt $table.Range.Cells.Count; $i++) {

                try {

                    $cellTxt = $table.Range.Cells.Item($i).Range.Text.Trim("`r", "`a", "`n", " ")

                    if (-not $foundDate -and ($cellTxt -eq "Date:" -or $cellTxt -like "*Date*") -and $certDate) {

                        $table.Range.Cells.Item($i + 1).Range.Text = $certDate

                        $foundDate = $true

                    } elseif (-not $foundSn -and $cellTxt -eq "Inst. SN." -and $deviceSn) {

                        $table.Range.Cells.Item($i + 1).Range.Text = $deviceSn

                        $foundSn = $true

                    } elseif (-not $foundModel -and $cellTxt -eq "Instrument" -and $model) {

                        $table.Range.Cells.Item($i + 1).Range.Text = $model

                        $foundModel = $true

                    } elseif (-not $foundTemp -and ($cellTxt -like "*Ambient Temperature*" -or $cellTxt -like "*Ambient Temp*") -and $ambientTemp) {

                        $table.Range.Cells.Item($i + 1).Range.Text = if ($ambientTemp -like "*℃*") { $ambientTemp } else { "$ambientTemp ℃" }

                        $foundTemp = $true

                    } elseif (-not $foundHumidity -and ($cellTxt -eq "Relative Humidity" -or $cellTxt -like "*Relative Humidity*") -and $relativeHumidity) {

                        $table.Range.Cells.Item($i + 1).Range.Text = if ($relativeHumidity -like "*%RH*") { $relativeHumidity } else { "$relativeHumidity %RH" }

                        $foundHumidity = $true

                    }

                } catch {}

            }



            # Update Test Points in Table (Aligned with confirmed tableConfig and fallback)
            $testPoints = $formData.testPoints
            Write-Dbg ("cert testPoints.count=" + $(if ($testPoints) { $testPoints.Count } else { 'null' }) + " hasTc=" + ($null -ne $fieldMappings.tableConfig) + " tableCount=" + $doc.Tables.Count)
            if ($testPoints -and $testPoints.Count -gt 0) {
                $writtenByCoords = $false
                if ($fieldMappings -and $fieldMappings.tableConfig) {
                    $tc = $fieldMappings.tableConfig
                    $targetTIdx = if ($null -ne $tc.tableIdx) { [int]$tc.tableIdx + 1 } else { 1 }
                    if ($targetTIdx -le $doc.Tables.Count) {
                        $targetTable = $doc.Tables.Item($targetTIdx)
                        $startRowIdx = if ($null -ne $tc.startRow) { [int]$tc.startRow + 1 } else { -1 }
                        $endRowIdx = if ($null -ne $tc.endRow) { [int]$tc.endRow + 1 } else { -1 }
                        $stdColIdx = if ($tc.standardCol -and $null -ne $tc.standardCol.colIdx) { [int]$tc.standardCol.colIdx + 1 } elseif ($tc.standardCol) { [int]$tc.standardCol + 1 } else { -1 }
                        $actColIdx = if ($tc.actualCol -and $null -ne $tc.actualCol.colIdx) { [int]$tc.actualCol.colIdx + 1 } elseif ($tc.actualCol) { [int]$tc.actualCol + 1 } else { -1 }
                        $pointColIdx = if ($tc.pointCol -and $null -ne $tc.pointCol.colIdx) { [int]$tc.pointCol.colIdx + 1 } elseif ($tc.pointCol) { [int]$tc.pointCol + 1 } else { -1 }
                        Write-Dbg ("cert coords targetT=$targetTIdx start=$startRowIdx end=$endRowIdx std=$stdColIdx act=$actColIdx point=$pointColIdx rowsBefore=" + $targetTable.Rows.Count)

                        if ($startRowIdx -gt 0) {
                            # 模板数据行数由 tableConfig 的 startRow/endRow 推导，用于界定测量数据区
                            $templateDataRows = if ($endRowIdx -ge $startRowIdx) { $endRowIdx - $startRowIdx + 1 } else { 0 }
                            # 只在测量数据区增删行，保留表头与表格下方的声明/签字内容
                            [void](Set-MeasurementRowCount -Table $targetTable -FirstDataRow $startRowIdx -TargetRows $testPoints.Count -TemplateDataRows $templateDataRows)
                            Write-Dbg ("cert rowsAfterResize=" + $targetTable.Rows.Count + " templateDataRows=" + $templateDataRows)

                            $cells = $targetTable.Range.Cells
                            $hasCustomCols = ($null -ne $tc.columns -and $tc.columns.Count -gt 0)
                            # 默认保留模板原表头：仅当管理员显式修改过表头（config 与模板不一致）时才改写 (3.C.8)
                            $headerRowIdx = if ($null -ne $tc.headerRow) { [int]$tc.headerRow + 1 } else { $startRowIdx - 1 }
                            if ($headerRowIdx -gt 0 -and $hasCustomCols) {
                                foreach ($colDef in $tc.columns) {
                                    $cIdx = [int]$colDef.colIdx + 1
                                    $lbl = [string]$colDef.label
                                    if ($lbl -eq "") { continue }
                                    $currentLbl = ""
                                    try {
                                        $currentLbl = $targetTable.Cell($headerRowIdx, $cIdx).Range.Text.Trim("`r", "`a", "`n", " ")
                                    } catch {}
                                    if ($currentLbl -eq $lbl) { continue }
                                    [void](Set-CellText -Table $targetTable -Row $headerRowIdx -Col $cIdx -Value $lbl)
                                }
                            }

                            for ($p = 0; $p -lt $testPoints.Count; $p++) {
                                $targetR = $startRowIdx + $p
                                if ($targetR -gt $targetTable.Rows.Count) { break }
                                $tp = $testPoints[$p]
                                $ptName = if ($null -ne $tp.name) { $tp.name } else { $tp.label }
                                $stdVal = if ($null -ne $tp.std) { $tp.std } else { $tp.standard }
                                $actVal = if ($null -ne $tp.act) { $tp.act } else { $tp.actual }
                                if ($hasCustomCols) {
                                    foreach ($colDef in $tc.columns) {
                                        $cIdx = [int]$colDef.colIdx + 1
                                        $k = [string]$colDef.key
                                        $cVal = $null
                                        if ($null -ne $tp.values) {
                                            if ($null -ne $tp.values.$k) { $cVal = $tp.values.$k }
                                            elseif ($null -ne $tp.values."$($colDef.colIdx)") { $cVal = $tp.values."$($colDef.colIdx)" }
                                            elseif ($null -ne $tp.values."$($colDef.label)") { $cVal = $tp.values."$($colDef.label)" }
                                        }
                                        # 仅在确实缺少该列数据时才回退到兼容字段；
                                        # 多列 isAct 时不得让后一列覆盖前一列的旧 act 值 (3.C.2)
                                        if ($null -eq $cVal) {
                                            if ($colDef.isSeq -and $null -ne $ptName) { $cVal = $ptName }
                                            elseif ($colDef.isStd -and $null -ne $stdVal) { $cVal = $stdVal }
                                        }
                                        if ($null -ne $cVal) {
                                            $ok = Set-CellText -Table $targetTable -Row $targetR -Col $cIdx -Value $cVal
                                            Write-Dbg ("cert write R$targetR C$cIdx key=$k val=[$cVal] ok=$ok")
                                        }
                                    }
                                } else {
                                    if ($pointColIdx -gt 0 -and $null -ne $ptName -and "$ptName" -ne "") {
                                        [void](Set-CellText -Table $targetTable -Row $targetR -Col $pointColIdx -Value $ptName)
                                    }
                                    if ($stdColIdx -gt 0 -and $null -ne $stdVal -and "$stdVal" -ne "") {
                                        [void](Set-CellText -Table $targetTable -Row $targetR -Col $stdColIdx -Value $stdVal)
                                    }
                                    if ($actColIdx -gt 0 -and $null -ne $actVal -and "$actVal" -ne "") {
                                        [void](Set-CellText -Table $targetTable -Row $targetR -Col $actColIdx -Value $actVal)
                                    }
                                }
                            }
                            $writtenByCoords = $true
                        }
                    }
                }

                if (-not $writtenByCoords) {
                    for ($p = 0; $p -lt $testPoints.Count; $p++) {
                        $ptNumStr = [string]($p + 1)
                        $tp = $testPoints[$p]
                        $stdVal = if ($null -ne $tp.std) { $tp.std } else { $tp.standard }
                        $actVal = if ($null -ne $tp.act) { $tp.act } else { $tp.actual }

                        for ($i = 1; $i -lt $table.Range.Cells.Count - 1; $i++) {
                            try {
                                $cText = $table.Range.Cells.Item($i).Range.Text.Trim("`r", "`a", "`n", " ")
                                if ($cText -eq $ptNumStr) {
                                    if ($null -ne $stdVal) { $table.Range.Cells.Item($i + 1).Range.Text = [string]$stdVal }
                                    if ($null -ne $actVal) { $table.Range.Cells.Item($i + 2).Range.Text = [string]$actVal }
                                    break
                                }
                            } catch {}
                        }
                    }
                }
            }
        }
    } elseif ($type -eq "packing") {

        # Packing List Replacement

        if ($doc.Tables.Count -ge 1) {

            $table = $doc.Tables.Item(1)

            # 清单模板的数据行数 = 原表行数 - 1 个表头行（在写入前记录，用于界定数据区边界）
            $packingTemplateDataRows = if ($table.Rows.Count -gt 1) { $table.Rows.Count - 1 } else { 0 }
            Write-Dbg ("packing start rows=" + $table.Rows.Count + " templateDataRows=" + $packingTemplateDataRows + " sensorRowConfigured=" + $hasSensorRowConfigured + " items=" + $(if ($formData.packingItems) { $formData.packingItems.Count } else { 'null' }))



            $pumpStr = if ($isPumpModel -and $hasPump) { "带泵" } else { "" }

            $mainRemark = if ($pumpStr) { "SN: $deviceSn $pumpStr" } else { "SN: $deviceSn" }

            $sensorRemarkStr = if ($sensorSn) { "SN: $sensorSn" } else { "" }



            # 更新模板中真实存在的保护行：按行名称识别，不假设"第二行就是传感器行" (2.B.5, 2.B.6)

            for ($r = 2; $r -le $table.Rows.Count; $r++) {

                try {

                    $cName = $table.Cell($r, 2).Range.Text.Trim("`r", "`a", "`n", " ")

                    if ($cName -eq "主设备" -or $cName -like "*主设备*") {

                        if ($model) { [void](Set-CellText -Table $table -Row $r -Col 3 -Value $model) }

                        [void](Set-CellText -Table $table -Row $r -Col 7 -Value $mainRemark)

                    } elseif ($hasSensorRowConfigured -and $cName -eq $sensorRowName) {

                        if ($sensorModel) { [void](Set-CellText -Table $table -Row $r -Col 3 -Value $sensorModel) }

                        [void](Set-CellText -Table $table -Row $r -Col 7 -Value $sensorRemarkStr)

                    }

                } catch {}

            }



            # Update full packingItems array

            $packingItems = $formData.packingItems

            # 表头行数：默认第一行为表头，数据从第 2 行开始

            $firstDataRow = 2

            # 传感器行在数据区中的相对位置（只有模板确实配置了传感器行时才存在）

            $sensorDataIdx = -1

            try {

                if ($fieldMappings -and $fieldMappings.packingItems) {

                    $cfgIdx = 0

                    foreach ($cfgItem in $fieldMappings.packingItems) {

                        if ($cfgItem.isProtectedSensor -or "$($cfgItem.name)" -eq $sensorRowName) { $sensorDataIdx = $cfgIdx; break }

                        $cfgIdx++

                    }

                }

            } catch {}

            if ($sensorDataIdx -lt 0 -and $hasSensorRowConfigured -and $packingItems -and $packingItems.Count -gt 1) {

                $probeIdx = 0

                foreach ($probeItem in $packingItems) {

                    if ("$($probeItem.name)" -eq $sensorRowName -or $probeItem.isProtectedSensor) { $sensorDataIdx = $probeIdx; break }

                    $probeIdx++

                }

            }



            if ($packingItems -and $packingItems.Count -gt 0) {

                # 只在数据区增删行，保留表格下方的签字/说明内容 (3.C.6)

                [void](Set-MeasurementRowCount -Table $table -FirstDataRow $firstDataRow -TargetRows $packingItems.Count -TemplateDataRows $packingTemplateDataRows)

                Write-Dbg ("packing rowsAfterResize=" + $table.Rows.Count)



                for ($idx = 0; $idx -lt $packingItems.Count; $idx++) {

                    $r = $firstDataRow + $idx

                    if ($r -ge $firstDataRow -and $r -le $table.Rows.Count) {

                        $item = $packingItems[$idx]

                        if ($table.Columns.Count -ge 7) {

                            [void](Set-CellText -Table $table -Row $r -Col 1 -Value ([string]($idx + 1)))

                            if ($null -ne $item.name) { [void](Set-CellText -Table $table -Row $r -Col 2 -Value ([string]$item.name)) }



                            # 规格：主设备用型号；仅当该行确实是传感器行时用传感器型号，其余保留用户填写值

                            if ($idx -eq 0 -and $model) {

                                [void](Set-CellText -Table $table -Row $r -Col 3 -Value $model)

                            } elseif ($sensorDataIdx -ge 0 -and $idx -eq $sensorDataIdx -and $sensorModel) {

                                [void](Set-CellText -Table $table -Row $r -Col 3 -Value $sensorModel)

                            } elseif ($null -ne $item.spec) {

                                [void](Set-CellText -Table $table -Row $r -Col 3 -Value ([string]$item.spec))

                            }



                            if ($null -ne $item.count) { [void](Set-CellText -Table $table -Row $r -Col 4 -Value ([string]$item.count)) }

                            if ($null -ne $item.unit) { [void](Set-CellText -Table $table -Row $r -Col 5 -Value ([string]$item.unit)) }

                            if ($null -ne $item.standard) { [void](Set-CellText -Table $table -Row $r -Col 6 -Value ([string]$item.standard)) }



                            # 备注：只有主设备行与真实传感器行使用自动备注，其余保留用户填写值 (2.B.6)

                            if ($idx -eq 0) {

                                [void](Set-CellText -Table $table -Row $r -Col 7 -Value $mainRemark)

                            } elseif ($sensorDataIdx -ge 0 -and $idx -eq $sensorDataIdx) {

                                [void](Set-CellText -Table $table -Row $r -Col 7 -Value $sensorRemarkStr)

                            } elseif ($null -ne $item.remark) {

                                [void](Set-CellText -Table $table -Row $r -Col 7 -Value ([string]$item.remark))

                            }

                        }

                    }

                }

            }

        }

    }



    # Save modified document

    $doc.Save()

} catch {

    Write-Error "Error during PowerShell COM processing: $_"

} finally {

    if ($null -ne $doc) {

        try { $doc.Close([ref]$false) } catch {}

        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null

    }

    if ($null -ne $app) {

        try { $app.Quit() } catch {}

        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null

    }

    [System.GC]::Collect()

    [System.GC]::WaitForPendingFinalizers()

}

