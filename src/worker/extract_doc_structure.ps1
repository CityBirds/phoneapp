﻿[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# PowerShell Native Word/WPS COM Document Structure Extractor
# Returns JSON array of paragraphs and table cells
param(
    [string]$filepath
)

if (-not (Test-Path $filepath)) {
    Write-Output "[]"
    exit 0
}

$absPath = (Resolve-Path $filepath).Path

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
            Write-Output "[]"
            exit 0
        }
    }
}

if ($null -eq $app) {
    Write-Output "[]"
    exit 0
}

try { $app.Visible = $false } catch {}
try { $app.DisplayAlerts = 0 } catch {}

$doc = $null
$items = @()

try {
    $doc = $app.Documents.Open($absPath, $false, $true) # Open ReadOnly

    if ($null -ne $doc) {
        # 1. Extract Table Cells
        if ($doc.Tables.Count -ge 1) {
            for ($tIdx = 1; $tIdx -le $doc.Tables.Count; $tIdx++) {
                $table = $doc.Tables.Item($tIdx)
                $rCount = $table.Rows.Count
                
                for ($rIdx = 1; $rIdx -le $rCount; $rIdx++) {
                    $row = $table.Rows.Item($rIdx)
                    $cCount = $row.Cells.Count
                    
                    for ($cIdx = 1; $cIdx -le $cCount; $cIdx++) {
                        try {
                            $cell = $row.Cells.Item($cIdx)
                            $txt = $cell.Range.Text
                            
                            # Trim Word cell termination markers (\r\x07 or \x07 or \r or \n)
                            $cleanText = $txt -replace "[\r\n\x07\x00-\x08\x0b-\x1f]", " "
                            $cleanText = $cleanText -replace "\s+", " "
                            $cleanText = $cleanText.Trim()
                            
                            $rawText = $txt -replace "[\x07\x00-\x08\x0b-\x1f]", ""
                            
                            $item = [PSCustomObject]@{
                                type     = "cell"
                                tableIdx = $tIdx - 1
                                rowIdx   = $rIdx - 1
                                colIdx   = $cIdx - 1
                                text     = $cleanText
                                rawText  = $rawText
                            }
                            $items += $item
                        } catch {}
                    }
                }
            }
        }

        # 2. Extract Standalone Paragraphs outside tables
        if ($doc.Paragraphs.Count -ge 1) {
            for ($pIdx = 1; $pIdx -le $doc.Paragraphs.Count; $pIdx++) {
                try {
                    $p = $doc.Paragraphs.Item($pIdx)
                    # Check if paragraph is inside a table
                    if ($p.Range.Tables.Count -eq 0) {
                        $pText = $p.Range.Text
                        $cleanP = $pText -replace "[\r\n\x07\x00-\x08\x0b-\x1f]", " "
                        $cleanP = $cleanP -replace "\s+", " "
                        $cleanP = $cleanP.Trim()

                        if ($cleanP) {
                            $item = [PSCustomObject]@{
                                type         = "paragraph"
                                paragraphIdx = $pIdx - 1
                                text         = $cleanP
                                rawText      = $pText
                            }
                            $items += $item
                        }
                    }
                } catch {}
            }
        }
    }
} catch {
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

$items | ConvertTo-Json -Depth 5 -Compress
