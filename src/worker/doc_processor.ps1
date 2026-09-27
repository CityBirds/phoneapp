# PowerShell Native Word/WPS COM Document Processor
# Rules: E05, E06, R17, T03, T04, T05, T06

param(
    [string]$templatePath,
    [string]$outputPath,
    [string]$jsonPath
)

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
    $shippingLocation = if ($formData.shippingLocation) { [string]$formData.shippingLocation } elseif ($formData.customer) { [string]$formData.customer } else { "" }
    $sensorModel = if ($formData.sensorModel) { [string]$formData.sensorModel } else { "" }
    $sensorSn = if ($formData.sensorSn) { [string]$formData.sensorSn } else { "" }
    $certDate = if ($formData.certDate) { [string]$formData.certDate } elseif ($formData.date) { [string]$formData.date } else { "" }
    $hasPump = if ($null -ne $formData.hasPump) { [bool]$formData.hasPump } else { $true }

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

            # Row 4, Col 2: Customer / shippingLocation
            if ($shippingLocation -and $table.Rows.Count -ge 4 -and $table.Columns.Count -ge 2) {
                $table.Cell(4, 2).Range.Text = $shippingLocation
            }

            # Row 4, Col 6: Date / certDate
            if ($certDate -and $table.Rows.Count -ge 4 -and $table.Columns.Count -ge 6) {
                $table.Cell(4, 6).Range.Text = $certDate
            }

            # Row 7, Col 2: Inst. SN. / deviceSn
            if ($deviceSn -and $table.Rows.Count -ge 7 -and $table.Columns.Count -ge 2) {
                $table.Cell(7, 2).Range.Text = $deviceSn
            }

            # Row 13 onwards: Test points table rows
            $testPoints = $formData.testPoints
            if ($testPoints -and $testPoints.Count -gt 0) {
                for ($i = 0; $i -lt $testPoints.Count; $i++) {
                    $rowIdx = 13 + $i
                    if ($table.Rows.Count -ge $rowIdx) {
                        $tp = $testPoints[$i]
                        $stdVal = if ($null -ne $tp.std) { $tp.std } else { $tp.standard }
                        $actVal = if ($null -ne $tp.act) { $tp.act } else { $tp.actual }

                        if ($null -ne $stdVal -and $table.Columns.Count -ge 2) {
                            $table.Cell($rowIdx, 2).Range.Text = [string]$stdVal
                        }
                        if ($null -ne $actVal -and $table.Columns.Count -ge 3) {
                            $table.Cell($rowIdx, 3).Range.Text = [string]$actVal
                        }
                    }
                }
            }
        }
    } elseif ($type -eq "packing") {
        # Packing List Replacement
        if ($doc.Tables.Count -ge 1) {
            $table = $doc.Tables.Item(1)

            $pumpStr = if ($hasPump) { "带泵" } else { "" }
            $mainRemark = if ($pumpStr) { "SN: $deviceSn $pumpStr" } else { "SN: $deviceSn" }
            $sensorRemarkStr = if ($sensorSn) { "SN: $sensorSn" } else { "" }

            # Update protected Row 2 (Main Device)
            if ($table.Rows.Count -ge 2) {
                if ($model -and $table.Columns.Count -ge 3) {
                    $table.Cell(2, 3).Range.Text = $model
                }
                if ($table.Columns.Count -ge 7) {
                    $table.Cell(2, 7).Range.Text = $mainRemark
                }
            }

            # Update protected Row 3 (Sensor)
            if ($table.Rows.Count -ge 3) {
                if ($sensorModel -and $table.Columns.Count -ge 3) {
                    $table.Cell(3, 3).Range.Text = $sensorModel
                }
                if ($table.Columns.Count -ge 7) {
                    $table.Cell(3, 7).Range.Text = $sensorRemarkStr
                }
            }

            # Update full packingItems array
            $packingItems = $formData.packingItems
            if ($packingItems -and $packingItems.Count -gt 0) {
                $neededRows = 1 + $packingItems.Count

                while ($table.Rows.Count -lt $neededRows) {
                    [void]$table.Rows.Add()
                }
                while ($table.Rows.Count -gt $neededRows -and $table.Rows.Count -gt 3) {
                    $table.Rows.Item($table.Rows.Count).Delete()
                }

                for ($idx = 0; $idx -lt $packingItems.Count; $idx++) {
                    $r = 2 + $idx
                    if ($r -ge 2 -and $r -le $table.Rows.Count) {
                        $item = $packingItems[$idx]
                        if ($table.Columns.Count -ge 7) {
                            $table.Cell($r, 1).Range.Text = [string]($idx + 1)
                            if ($null -ne $item.name) { $table.Cell($r, 2).Range.Text = [string]$item.name }

                            # Model / Spec
                            if ($idx -eq 0 -and $model) {
                                $table.Cell($r, 3).Range.Text = $model
                            } elseif ($idx -eq 1 -and $sensorModel) {
                                $table.Cell($r, 3).Range.Text = $sensorModel
                            } elseif ($null -ne $item.spec) {
                                $table.Cell($r, 3).Range.Text = [string]$item.spec
                            }

                            if ($null -ne $item.count) { $table.Cell($r, 4).Range.Text = [string]$item.count }
                            if ($null -ne $item.unit) { $table.Cell($r, 5).Range.Text = [string]$item.unit }
                            if ($null -ne $item.standard) { $table.Cell($r, 6).Range.Text = [string]$item.standard }

                            # Remarks: Ensure main device and sensor retain updated SN and pump status
                            if ($idx -eq 0) {
                                $table.Cell($r, 7).Range.Text = $mainRemark
                            } elseif ($idx -eq 1) {
                                $table.Cell($r, 7).Range.Text = $sensorRemarkStr
                            } elseif ($null -ne $item.remark) {
                                $table.Cell($r, 7).Range.Text = [string]$item.remark
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
