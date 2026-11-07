# 从金蝶 K3Cloud 元数据索引里析出某个业务对象的字段清单
#
# 用法：
#   pwsh -NoProfile -File "F:\AIXM\烟花爆竹\tools\get-object-fields.ps1" -ObjectId STK_InStock
#   pwsh -NoProfile -File "...\get-object-fields.ps1" -ObjectId SAL_SaleOrder
#   pwsh -NoProfile -File "...\get-object-fields.ps1" -ObjectId STK_InStock -Format Csv > fields.csv
#
# 实测：STK_InStock 匹配 94 份元数据文件，去重 255 个字段，约 14 秒。
#
# 原理：metadata-index.jsonl 有 422 MB、单行可达几十 KB。
#       必须先 Select-String 命中行，再逐行 ConvertFrom-Json，绝不能整文件读进来。
param(
    [Parameter(Mandatory = $true)]
    [string]$ObjectId,

    [string]$Index = 'E:\测试\.work\rea-full\metadata-index.jsonl',

    [ValidateSet('Table', 'Csv', 'Json')]
    [string]$Format = 'Table'
)

if (-not (Test-Path $Index)) {
    Write-Error "索引文件不存在: $Index"
    exit 1
}

$seen = @{}
$hit = 0

Select-String -Path $Index -Pattern ('"businessObjectId": "' + $ObjectId + '"') -SimpleMatch | ForEach-Object {
    $hit++
    try { $o = $_.Line | ConvertFrom-Json } catch { return }
    if ($o.businessObjectId -ne $ObjectId) { return }
    foreach ($f in $o.fields) {
        if ([string]::IsNullOrWhiteSpace($f.key)) { continue }
        if (-not $seen.ContainsKey($f.key)) {
            $seen[$f.key] = [pscustomobject]@{
                Key  = $f.key
                Name = $f.name
                Type = $f.type
            }
        }
    }
}

$rows = $seen.Values | Sort-Object Key

switch ($Format) {
    'Csv' { $rows | ConvertTo-Csv -NoTypeInformation }
    'Json' { $rows | ConvertTo-Json -Depth 3 }
    default {
        "# $ObjectId  (匹配元数据文件 $hit 份, 去重字段 $($seen.Count) 个)"
        if ($seen.Count -eq 0) {
            Write-Warning "没匹配到字段。检查 ObjectId 拼写，例如 STK_InStock / SAL_SaleOrder / PUR_PurchaseOrder / BD_MATERIAL"
        }
        $rows | Format-Table -AutoSize
    }
}