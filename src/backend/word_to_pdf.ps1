# 把 Word 文档导出为 PDF（用于手机端真实预览）
# 只读取源文件，不修改；失败时以非零退出码与明确错误信息返回。
param(
    [Parameter(Mandatory = $true)][string]$WordPath,
    [Parameter(Mandatory = $true)][string]$PdfPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $WordPath)) {
    Write-Error "Word 源文件不存在: $WordPath"
    exit 2
}

$outDir = Split-Path -Parent $PdfPath
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path -LiteralPath $PdfPath) {
    try { Remove-Item -LiteralPath $PdfPath -Force } catch {}
}

# 优先使用 WPS（KWps.Application），其次 MS Word；两者导出格式常量一致（PDF = 17）
$app = $null
foreach ($progId in @('Word.Application', 'KWps.Application', 'Wps.Application')) {
    try {
        $candidate = New-Object -ComObject $progId -ErrorAction Stop
        $app = $candidate
        $appName = "$progId"
        try { $appName += " (" + $candidate.Name + ")" } catch {}
        break
    } catch {
        $app = $null
    }
}

if ($null -eq $app) {
    Write-Error "未检测到可用的 Word/WPS COM 组件，无法生成 PDF 预览"
    exit 3
}

$doc = $null
try {
    try { $app.Visible = $false } catch {}
    try { $app.DisplayAlerts = 0 } catch {}

    # 只读方式打开源文档（ConfirmConversions=false, ReadOnly=true），确保不改动执行端返回的 Word 原件
    try {
        $doc = $app.Documents.Open($WordPath, $false, $true)
    } catch {
        Write-Error ("打开 Word 文档失败 [" + $appName + "]: " + $_.Exception.Message)
        exit 4
    }
    if ($null -eq $doc) {
        Write-Error ("无法打开 Word 文档 [" + $appName + "]: $WordPath")
        exit 4
    }

    $pages = 0
    try { $pages = [int]$doc.ComputeStatistics(2) } catch { $pages = 0 }

    # wdExportFormatPDF = 17, wdExportOptimizeForPrint = 0, wdExportAllDocument = 0
    try {
        $doc.ExportAsFixedFormat($PdfPath, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, 0)
    } catch {
        Write-Error ("导出 PDF 失败 [" + $appName + "]: " + $_.Exception.Message)
        exit 6
    }

    Write-Output ("engine=" + $appName)
    Write-Output "pages=$pages"
    if (-not (Test-Path -LiteralPath $PdfPath)) {
        Write-Error ("导出命令已执行但未生成 PDF 文件 [" + $appName + "]")
        exit 5
    }
} finally {
    if ($null -ne $doc) {
        try { $doc.Close([ref]$false) } catch {}
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null } catch {}
    }
    if ($null -ne $app) {
        try { $app.Quit() } catch {}
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch {}
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

exit 0
