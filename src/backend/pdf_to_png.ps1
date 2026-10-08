param(
    [Parameter(Mandatory=$true)][string]$PdfPath,
    [Parameter(Mandatory=$true)][string]$OutDir,
    [int]$Scale = 2,
    [int]$TimeoutSeconds = 120
)

# PDF 逐页渲染为 PNG（手机免 Office 预览的页图来源）
#
# 设计要点（整改 3.2 / PV05、PV07）：
#  - 只用 Windows 运行时自带的 Windows.Data.Pdf，不要求安装第三方组件，也不依赖手机浏览器；
#  - 每页渲染后校验文件非空，页图数量必须与 PDF 页数一致；
#  - 只输出一行 JSON，成功/失败与阶段由 Node 侧判定，不在此处伪造成功；
#  - 失败时保留 PDF 与源 Word，不清除既有产物。
#
# 实现注意（Windows PowerShell 5.1 实测）：
#  - PdfPage.RenderToStreamAsync 返回 IAsyncAction，必须用
#    WindowsRuntimeSystemExtensions.AsTask(IAsyncAction) 等待；直接 .AsTask() 会报
#    “[System.__ComObject] does not contain a method named 'AsTask'”；
#  - InMemoryRandomAccessStream 在 5.1 下没有可用的 AsStreamForRead 扩展方法，
#    必须用 DataReader + LoadAsync 读回字节。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$result = [ordered]@{
    ok     = $false
    engine = $null
    pages  = 0
    files  = @()
    error  = $null
    stage  = 'init'
}

function Write-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

if (-not (Test-Path -LiteralPath $PdfPath)) {
    $result.stage = 'pdf-check'
    $result.error = "PDF 不存在: $PdfPath"
    Write-Result $result
    exit 1
}

$pdfItem = Get-Item -LiteralPath $PdfPath
if ($pdfItem.Length -le 0) {
    $result.stage = 'pdf-check'
    $result.error = "PDF 为空文件（0 字节），拒绝渲染页图: $PdfPath"
    Write-Result $result
    exit 1
}

$absPdf = $pdfItem.FullName
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

try {
    $result.stage = 'load-runtime'
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

    $extMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskAction = $extMethods | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncAction*'
    } | Select-Object -First 1
    $asTaskGeneric = ($extMethods | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    if (-not $asTaskAction -or -not $asTaskGeneric) { throw '当前系统不支持 WinRT 异步等待（缺少 AsTask 扩展）' }

    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
    [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    [void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

    $timeoutMs = [math]::Max(5000, $TimeoutSeconds * 1000)

    $result.stage = 'load-pdf'
    $op = [Windows.Storage.StorageFile]::GetFileFromPathAsync($absPdf)
    $t = $asTaskGeneric.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @($op))
    if (-not $t.Wait($timeoutMs)) { throw "打开 PDF 超时（${timeoutMs}ms）" }
    $file = $t.Result

    $op2 = [Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)
    $t2 = $asTaskGeneric.MakeGenericMethod([Windows.Data.Pdf.PdfDocument]).Invoke($null, @($op2))
    if (-not $t2.Wait($timeoutMs)) { throw "解析 PDF 超时（${timeoutMs}ms）" }
    $pdf = $t2.Result
    $result.engine = 'windows-data-pdf'

    if ($pdf.PageCount -le 0) {
        $result.stage = 'validate-pdf'
        $result.error = 'PDF 页数为 0，判定为不可用 PDF，拒绝生成页图'
        Write-Result $result
        exit 1
    }

    $result.stage = 'render-pages'
    for ($i = 0; $i -lt $pdf.PageCount; $i++) {
        $page = $null
        $stream = $null
        $reader = $null
        try {
            $page = $pdf.GetPage($i)
            $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $opts.DestinationWidth = [uint32][math]::Max(1, [math]::Round($page.Size.Width * $Scale))
            $opts.DestinationHeight = [uint32][math]::Max(1, [math]::Round($page.Size.Height * $Scale))

            $renderOp = $page.RenderToStreamAsync($stream, $opts)
            $renderTask = $asTaskAction.Invoke($null, @($renderOp))
            if (-not $renderTask.Wait($timeoutMs)) { throw "第 $($i + 1) 页渲染超时（${timeoutMs}ms）" }
            if ($renderTask.IsFaulted) { throw "第 $($i + 1) 页渲染失败: $($renderTask.Exception.GetBaseException().Message)" }

            $stream.Seek(0)
            $size = [uint32]$stream.Size
            if ($size -le 0) { throw "第 $($i + 1) 页渲染输出为空流" }

            $reader = New-Object Windows.Storage.Streams.DataReader($stream)
            $loadOp = $reader.LoadAsync($size)
            $loadTask = $asTaskGeneric.MakeGenericMethod([uint32]).Invoke($null, @($loadOp))
            if (-not $loadTask.Wait($timeoutMs)) { throw "第 $($i + 1) 页读取超时（${timeoutMs}ms）" }
            $loaded = [int]$loadTask.Result
            $bytes = New-Object 'byte[]' $loaded
            $reader.ReadBytes($bytes)

            $outFile = Join-Path $OutDir ("page_{0:D3}.png" -f ($i + 1))
            [System.IO.File]::WriteAllBytes($outFile, $bytes)

            if ((Get-Item -LiteralPath $outFile).Length -le 0) {
                throw "第 $($i + 1) 页页图为空文件"
            }
            $result.files += $outFile
        } finally {
            if ($reader) { try { $reader.Dispose() } catch {} }
            if ($stream) { try { $stream.Dispose() } catch {} }
            if ($page) { try { $page.Dispose() } catch {} }
        }
    }

    # 页数与页图数量必须一致，否则不算成功（PV05/PV07）
    if ($result.files.Count -ne $pdf.PageCount) {
        $result.stage = 'validate-pages'
        $result.error = "页图数量 ($($result.files.Count)) 与 PDF 页数 ($($pdf.PageCount)) 不一致"
        Write-Result $result
        exit 1
    }

    $result.pages = $pdf.PageCount
    $result.ok = $true
    $result.stage = 'done'
    Write-Result $result
    exit 0
} catch {
    $result.error = $_.Exception.Message
    if ($_.Exception.InnerException) { $result.error += " / " + $_.Exception.InnerException.Message }
    Write-Result $result
    exit 1
}
