# =============================================================
# 記録 v1 → v2 切替スクリプト（v1.3.0 リリース時に1回実行）
#
# 実行順序（7/19 当日）:
#   1. .\deploy.ps1 -Target backend
#        → RECORDS_VERSION=2 で Lambda が v2 盤面（leaderboard#v2）に切替
#        （DynamoDB の v1 データは pk="leaderboard" のまま残る）
#   2. .\tools\cutover-v2.ps1
#        → 現行 leaderboard.json を site/archive/leaderboard-v1.json に凍結し、
#          S3 の leaderboard.json を空盤面で初期化
#   3. 凍結ファイルを確認して git commit（アーカイブページの実データになる）
#   4. .\deploy.ps1 -Target site
#
# 注意: 手順1と2の間にランクインがあると v2 盤面へ書かれた記録が
#       手順2の初期化で消える。当日はこの間隔を最小にすること。
# =============================================================

param(
    [string]$Bucket = "all-stars.precure.tv",
    [string]$ProfileName = "allstars-deployer"
)

$ErrorActionPreference = "Stop"

$archivePath = Join-Path $PSScriptRoot "..\site\archive\leaderboard-v1.json"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " 1/2: 現行ランキングを凍結アーカイブ化"    -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
aws s3 cp "s3://$Bucket/leaderboard.json" $archivePath --profile $ProfileName
if ($LASTEXITCODE -ne 0) { throw "leaderboard.json の取得に失敗" }
Write-Host "凍結完了: $archivePath" -ForegroundColor Green

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " 2/2: S3 の現行盤面を空で初期化"           -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$empty = "{`n  `"updatedAt`": `"$now`",`n  `"entries`": []`n}"
$tmp = New-TemporaryFile
Set-Content -Path $tmp -Value $empty -Encoding utf8
aws s3 cp $tmp "s3://$Bucket/leaderboard.json" `
    --content-type "application/json" `
    --cache-control "public, max-age=30" `
    --profile $ProfileName
if ($LASTEXITCODE -ne 0) { throw "空盤面のアップロードに失敗" }
Remove-Item $tmp

Write-Host ""
Write-Host "切替完了。次の手順:" -ForegroundColor Green
Write-Host "  1. $archivePath の内容を確認"
Write-Host "  2. git add site/archive/leaderboard-v1.json → コミット"
Write-Host "  3. .\deploy.ps1 -Target site"
