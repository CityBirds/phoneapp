# 生成 Word 测试夹具（结构固定、内容可预测）
# 用于让测试自包含，不依赖生产库或任何现存模板文件。
param(
    [Parameter(Mandatory = $true)][string]$CertOut,
    [Parameter(Mandatory = $true)][string]$PackOut
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    # ============ 1. 证书夹具：4 列，表头 + 3 行数据 + 认证声明 ============
    $doc = $word.Documents.Add()
    $doc.Content.Font.Name = 'Arial'
    $doc.Content.Font.Size = 10

    $rng = $doc.Content
    $rng.InsertAfter('Calibration Certificate')
    $rng.InsertParagraphAfter()

    # 5 列表格：第 1 列为纵向合并的占位列，忠实反映真实 POA3500 模板结构
    # （真实模板首列纵向合并，这正是无法用 Rows.Item(n) 访问行的原因）
    $table = $doc.Tables.Add($doc.Paragraphs.Last.Range, 4, 5)
    $table.Borders.Enable = $true
    $table.Cell(1, 1).Merge($table.Cell(4, 1))

    $headers = @('Gas', 'Value', 'Actual Reading', 'mA Output(If fitted)')
    for ($c = 1; $c -le 4; $c++) {
        $table.Cell(1, $c + 1).Range.Text = $headers[$c - 1]
        $table.Cell(1, $c + 1).Range.Bold = 1
    }
    $rows = @(
        @('Oxygen', '100.00', '99.99', '19.998'),
        @('Nitrogen', '0.00', '0.00', '4.000'),
        @('Air', '21.00', '20.98', '7.356')
    )
    for ($r = 0; $r -lt 3; $r++) {
        for ($c = 1; $c -le 4; $c++) {
            $table.Cell($r + 2, $c + 1).Range.Text = $rows[$r][$c - 1]
        }
    }

    # 表格下方的认证声明
    $doc.Content.InsertParagraphAfter()
    $para = $doc.Paragraphs.Last.Range
    $para.InsertAfter('We herby certify that the analyzer detailed above has been tested and calibrated by the Undersigned.')
    $doc.SaveAs2($CertOut, 0)
    $doc.Close([ref]$false)
    Write-Output "cert fixture rows=$($table.Rows.Count) cols=$($table.Columns.Count)"

    # ============ 2. 清单夹具：7 列，表头 + 主设备 + 传感器 + 2 行普通物料 ============
    $doc2 = $word.Documents.Add()
    $doc2.Content.Font.Name = 'Arial'
    $doc2.Content.Font.Size = 10
    $doc2.Content.InsertAfter('Packing List')
    $doc2.Content.InsertParagraphAfter()

    $t2 = $doc2.Tables.Add($doc2.Paragraphs.Last.Range, 5, 7)
    $t2.Borders.Enable = $true
    $h2 = @('序号', '名称', '规格/型号', '数量', '单位', '标配', '备注')
    for ($c = 1; $c -le 7; $c++) {
        $t2.Cell(1, $c).Range.Text = $h2[$c - 1]
        $t2.Cell(1, $c).Range.Bold = 1
    }
    $items = @(
        @('1', '主设备', 'POA200', '1', '台', '是', 'SN: AP10007513带泵'),
        @('2', '传感器', 'PMT210SEN', '1', '只', '是', 'SN: 201N200258'),
        @('3', '包装箱', 'ABS', '1', '个', '是', ''),
        @('4', '用户手册', '中英文', '2', '本', '是', '')
    )
    for ($r = 0; $r -lt 4; $r++) {
        for ($c = 1; $c -le 7; $c++) {
            $t2.Cell($r + 2, $c).Range.Text = $items[$r][$c - 1]
        }
    }
    $doc2.SaveAs2($PackOut, 0)
    $doc2.Close([ref]$false)
    Write-Output "pack fixture rows=$($t2.Rows.Count) cols=$($t2.Columns.Count)"
} finally {
    try { $word.Quit() } catch {}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

Write-Output 'done'
