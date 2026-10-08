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

# 每个引擎必须完成打开、导出和输出检查，不能仅凭 COM 创建成功就停止回退。
$failures = @()
foreach ($progId in @('Word.Application', 'KWps.Application', 'Wps.Application')) {
    $app = $null
    $doc = $null
    $completed = $false
    $stage = '创建组件'
    try {
        # 上一个引擎留下的空文件或半成品不能被当作本次成功。
        if (Test-Path -LiteralPath $PdfPath) { Remove-Item -LiteralPath $PdfPath -Force -ErrorAction Stop }
        $app = New-Object -ComObject $progId -ErrorAction Stop
        try { $app.Visible = $false } catch {}
        try { $app.DisplayAlerts = 0 } catch {}
        $stage = '打开文档'
        $doc = $app.Documents.Open($WordPath, $false, $true)
        if ($null -eq $doc) { throw '未返回文档对象' }
        $pages = 0
        try { $pages = [int]$doc.ComputeStatistics(2) } catch {}
        $stage = '导出 PDF'
        $doc.ExportAsFixedFormat($PdfPath, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, 0)
        $stage = '检查 PDF 输出'
        if (-not (Test-Path -LiteralPath $PdfPath)) { throw '未生成 PDF 文件' }
        # 完整解析由后续预览流程执行；这里拒绝空文件与明显非 PDF 半成品。
        $stream = [IO.File]::OpenRead($PdfPath)
        try {
            $header = [byte[]]@(0, 0, 0, 0, 0)
            $count = $stream.Read($header, 0, 5)
            if ($count -ne 5 -or [Text.Encoding]::ASCII.GetString($header) -ne '%PDF-') {
                throw '输出为空或不是 PDF 文件'
            }
        } finally { $stream.Dispose() }
        $completed = $true
    } catch {
        $detail = "[$progId][$stage] $($_.Exception.Message)"
        $failures += $detail
        # 不用 Write-Error：Stop 策略会提前终止，导致后续 WPS 无法尝试。
        [Console]::Error.WriteLine("转换引擎失败，继续尝试下一引擎：$detail")
    } finally {
        if ($null -ne $doc) {
            try { $doc.Close([ref]$false) } catch {}
            try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch {}
        }
        if ($null -ne $app) {
            try { $app.Quit() } catch {}
            try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
        }
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }
    if ($completed) {
        Write-Output "engine=$progId"
        Write-Output "pages=$pages"
        exit 0
    }
    if (Test-Path -LiteralPath $PdfPath) {
        try { Remove-Item -LiteralPath $PdfPath -Force -ErrorAction Stop }
        catch { [Console]::Error.WriteLine("无法清理失败输出：$($_.Exception.Message)"); exit 7 }
    }
}
[Console]::Error.WriteLine('所有 Word/WPS 转换引擎均失败：' + ($failures -join '；'))
exit 6