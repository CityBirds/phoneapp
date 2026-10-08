param(
    [Parameter(Mandatory=$true)][string]$FilePath,
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [int]$Copies = 1
)

# 打印真实 Word 原件（整改 4.2 / PR07）
# - 参数通过命令行参数传入，不做 shell 字符串拼接，中文/空格/括号路径安全
# - 优先 Word/WPS COM 的 PrintOut（.doc/.docx 的真实打印能力），失败再退回外壳打印动词
# - 仅输出一行 JSON 结果，供 Node 侧解析；不在这里判定“已出纸”

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress)
}

$result = [ordered]@{
    success      = $false
    stage        = 'init'
    engine       = $null
    windowsJobIds = @()
    error        = $null
}

if (-not (Test-Path -LiteralPath $FilePath)) {
    $result.stage = 'file-check'
    $result.error = "文件不存在: $FilePath"
    Write-Result $result
    exit 1
}

$extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
if ($extension -ne '.doc' -and $extension -ne '.docx') {
    $result.stage = 'file-check'
    $result.error = "只支持 .doc/.docx 打印，当前为 $extension"
    Write-Result $result
    exit 1
}

# 记录提交前该打印机队列中已有的作业号，便于之后区分新作业
function Get-QueueJobIds() {
    try {
        return @(Get-PrintJob -PrinterName $PrinterName -ErrorAction Stop | ForEach-Object { [string]$_.Id })
    } catch {
        return @()
    }
}

$before = Get-QueueJobIds

$app = $null
$doc = $null
$comError = $null

# 引擎 1：Word/WPS COM PrintOut
try {
    $result.stage = 'open'
    $candidates = @('Word.Application', 'KWps.Application', 'Wps.Application')
    foreach ($progId in $candidates) {
        try {
            $app = New-Object -ComObject $progId -ErrorAction Stop
            if ($app) { break }
        } catch {
            $app = $null
        }
    }
    if ($null -eq $app) {
        $comError = '未找到可用的 Word/WPS COM 组件'
    } else {
        try { $app.Visible = $false } catch {}
        try { $app.DisplayAlerts = 0 } catch {}
        $result.stage = 'print'
        $doc = $app.Documents.Open($FilePath, $false, $true)
        # Background=$false 以便尽量同步拿到队列作业
        $doc.PrintOut([ref]$false, [ref]$false, [ref]0, [ref]"", [ref]$PrinterName, [ref]$false, [ref]$Copies, [ref]"", [ref]$false, [ref]$false, [ref]0, [ref]$false, [ref]$false, [ref]$false, [ref]$false, [ref]0)
        $result.engine = 'word-com'
        $result.success = $true
    }
} catch {
    $comError = $_.Exception.Message
} finally {
    if ($doc) { try { $doc.Close([ref]0) } catch {} }
    if ($app) { try { $app.Quit() } catch {} }
    if ($doc) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch {} }
    if ($app) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {} }
}

# 引擎 2：外壳打印动词（用户默认关联程序）
if (-not $result.success) {
    try {
        $result.stage = 'shell-print'
        Start-Process -FilePath $FilePath -Verb PrintTo -ArgumentList "`"$PrinterName`"" -PassThru | Out-Null
        $result.engine = 'shell-printto'
        $result.success = $true
        $result.error = $null
    } catch {
        $result.stage = 'failed'
        $result.error = "COM: $comError / Shell: $($_.Exception.Message)"
        $result.success = $false
        Write-Result $result
        exit 1
    }
}

# 采集 Windows 队列证据（可能滞后，取不到不算失败，但要如实返回空）
$result.stage = 'spooler-evidence'
$after = @()
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 400
    $after = Get-QueueJobIds
    $new = @($after | Where-Object { $before -notcontains $_ })
    if ($new.Count -gt 0) {
        $result.windowsJobIds = $new
        break
    }
}
if ($result.windowsJobIds.Count -eq 0) {
    # 已有作业可能已快速完成，返回当前队列可见作业供参考
    $result.windowsJobIds = @($after)
}

Write-Result $result
exit 0
