param(
    [string]$filepath
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# PowerShell Native Word/WPS COM Document Structure Extractor
# Returns JSON array of paragraphs and table cells

if (-not $filepath -or -not (Test-Path $filepath)) {
    Write-Error "File not found or empty path: $filepath"
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
            Write-Error "COM not available: Neither WPS Office nor Microsoft Word COM object is available."
            Write-Output "[]"
            exit 0
        }
    }
}

if ($null -eq $app) {
    Write-Error "Failed to instantiate COM application object."
    Write-Output "[]"
    exit 0
}

try { $app.Visible = $false } catch {}
try { $app.DisplayAlerts = 0 } catch {}

$doc = $null
$items = @()

try {
    $doc = $app.Documents.Open($absPath)

    if ($null -ne $doc) {
        # 1. Extract Table Cells using Range.Cells (immune to merged cells and 0x800A1767)
        if ($doc.Tables.Count -ge 1) {
            for ($tIdx = 1; $tIdx -le $doc.Tables.Count; $tIdx++) {
                $table = $doc.Tables.Item($tIdx)
                $cells = $table.Range.Cells
                $cTotal = $cells.Count
                
                for ($cIdx = 1; $cIdx -le $cTotal; $cIdx++) {
                    try {
                        $cell = $cells.Item($cIdx)
                        $txt = $cell.Range.Text
                        $rIdx = $cell.RowIndex - 1
                        $colIdx = $cell.ColumnIndex - 1
                        
                        # Trim Word cell termination markers (\r\x07 or \x07 or \r or \n)
                        $cleanText = $txt -replace "[\r\n\x07\x00-\x08\x0b-\x1f]", " "
                        $cleanText = $cleanText -replace "\s+", " "
                        $cleanText = $cleanText.Trim()
                        
                        $rawText = $txt -replace "[\x07\x00-\x08\x0b-\x1f]", ""
                        
                        $item = [PSCustomObject]@{
                            type     = "cell"
                            tableIdx = $tIdx - 1
                            rowIdx   = $rIdx
                            colIdx   = $colIdx
                            text     = $cleanText
                            rawText  = $rawText
                        }
                        $items += $item
                    } catch {}
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
    } else {
        Write-Error "Failed to open document: $absPath"
    }
} catch {
    Write-Error "Document parsing error: $_"
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
