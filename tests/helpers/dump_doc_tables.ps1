param(
    [Parameter(Mandatory = $true)][string]$DocPath,
    [Parameter(Mandatory = $true)][string]$OutJson
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($DocPath, $false, $true)
    $tables = @()
    for ($t = 1; $t -le $doc.Tables.Count; $t++) {
        $tb = $doc.Tables.Item($t)
        $rows = @()
        for ($r = 1; $r -le $tb.Rows.Count; $r++) {
            $cells = @()
            for ($c = 1; $c -le $tb.Columns.Count; $c++) {
                try {
                    $txt = $tb.Cell($r, $c).Range.Text
                    $txt = $txt -replace "[`r`a`n]", ''
                    $cells += $txt.Trim()
                } catch { $cells += $null }
            }
            $rows += ,$cells
        }
        $tables += @{ rows = $rows; rowCount = $tb.Rows.Count; colCount = $tb.Columns.Count }
    }
    $paras = @()
    foreach ($p in $doc.Paragraphs) {
        $txt = ($p.Range.Text -replace "[`r`a`n]", '').Trim()
        if ($txt -ne '') { $paras += $txt }
    }
    $result = @{ tables = $tables; paragraphs = $paras; pageCount = [int]$doc.ComputeStatistics(2) }
    $json = $result | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "dumped tables=$($tables.Count) pages=$($result.pageCount)"
    $doc.Close([ref]$false)
} finally {
    try { $word.Quit() } catch {}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
