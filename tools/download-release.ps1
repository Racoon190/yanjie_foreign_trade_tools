<#
  言界 v1.6.0 安装包 —— 一键下载并合并 Release 分卷

  为什么分成多个分卷：本机上行链路对单个长连接有约 90 秒 / 8 MB 的限制，
  162 MiB 的安装包无法一次上传，因此 Release 里按 4 MB 切分上传。

  用法：
    1) 生成一个 fine-grained GitHub Token（该私有仓库需要权限：Contents: Read）
       https://github.com/settings/personal-access-tokens/new
       也可以先设置环境变量 GH_TOKEN，脚本会直接使用。
    2) 在本目录执行：
         powershell -ExecutionPolicy Bypass -File .\tools\download-release.ps1
    3) 脚本会下载全部分卷、合并成 YanJie-1.6.0-portable.zip 并校验 SHA256。

  断点续传：分卷保存在 .\parts\ 目录，重新运行会自动跳过已完整的文件。
#>
param(
    [string]$Token,
    [string]$OutFile = 'YanJie-1.6.0-portable.zip',
    [string]$PartsDir = 'parts'
)

$ErrorActionPreference = 'Stop'

$Owner = 'Racoon190'
$Repo = 'yanjie_foreign_trade_tools'
$Tag = 'v1.6.0'
$ExpectedSize = 169613034
$ExpectedSha256 = 'cd157331218de74fe5dafa28d61d4304626cd75d949dd03c59d815ec1a6faa67'

if (-not $Token) { $Token = $env:GH_TOKEN }
if (-not $Token) { $Token = Read-Host '请输入 GitHub Token（fine-grained，Contents: Read 即可）' }
if (-not $Token) { throw '需要 GitHub Token 才能下载私有仓库的 Release 附件。' }

$Headers = @{
    Authorization = "Bearer $Token"
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'yanjie-release-downloader'
}

Write-Host "读取 Release $Tag ..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag" -Headers $Headers

$parts = @($release.assets | Where-Object { $_.name -match '\.part\d+$' } | Sort-Object Name)
if ($parts.Count -eq 0) { throw '没有在 Release 中找到分卷，请确认 Token 有 Contents: Read 权限。' }

$totalMB = [math]::Round((($parts | Measure-Object -Property size -Sum).Sum / 1MB), 1)
Write-Host ("找到 {0} 个分卷，共 {1} MB" -f $parts.Count, $totalMB)

New-Item -ItemType Directory -Force -Path $PartsDir | Out-Null
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue

foreach ($part in $parts) {
    $dest = Join-Path $PartsDir $part.name
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $part.size)) {
        Write-Host ("跳过 {0}（已完整）" -f $part.name)
        continue
    }

    $done = $false
    for ($attempt = 1; $attempt -le 5 -and -not $done; $attempt++) {
        try {
            if ($curl) {
                & $curl.Source -sS -L --retry 3 --retry-delay 2 `
                    -H "Authorization: Bearer $Token" `
                    -H 'Accept: application/octet-stream' `
                    -H 'User-Agent: yanjie-release-downloader' `
                    -o $dest $part.url
            } else {
                Invoke-WebRequest -Uri $part.url -OutFile $dest -Headers @{
                    Authorization = "Bearer $Token"
                    Accept = 'application/octet-stream'
                    'User-Agent' = 'yanjie-release-downloader'
                }
            }
            if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $part.size)) {
                $done = $true
            } else {
                Remove-Item $dest -Force -ErrorAction SilentlyContinue
                throw '下载大小与预期不符'
            }
        } catch {
            Write-Warning ("{0} 第 {1} 次失败：{2}" -f $part.name, $attempt, $_.Exception.Message)
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    if (-not $done) { throw ("下载失败：{0}" -f $part.name) }
    Write-Host ("完成 {0}" -f $part.name)
}

$files = @(Get-ChildItem -Path $PartsDir -Filter '*.part??' | Sort-Object Name)
Write-Host ("合并 {0} 个分卷 -> {1}" -f $files.Count, $OutFile)
$outPath = Join-Path (Get-Location) $OutFile
if (Test-Path $outPath) { Remove-Item $outPath -Force }

$fs = [System.IO.File]::Create($outPath)
try {
    foreach ($f in $files) {
        $in = [System.IO.File]::OpenRead($f.FullName)
        try { $in.CopyTo($fs) } finally { $in.Dispose() }
    }
} finally {
    $fs.Dispose()
}

$size = (Get-Item $outPath).Length
$hash = (Get-FileHash $outPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ("大小：{0:N0} 字节（期望 {1:N0}）" -f $size, $ExpectedSize)
Write-Host ("SHA256：{0}" -f $hash)

if ($size -eq $ExpectedSize -and $hash -eq $ExpectedSha256) {
    Write-Host '✔ 校验通过：解压 YanJie-1.6.0-portable.zip，双击 言界.exe 运行。' -ForegroundColor Green
} else {
    Write-Host '✘ 校验失败：请删除 parts 目录后重新运行本脚本。' -ForegroundColor Red
    exit 1
}
