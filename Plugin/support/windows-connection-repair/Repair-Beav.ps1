# Windows PowerShell 5.1; no administrator privileges required.
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
    supportCase = 'cc5b3b14-f626-46e2-a959-509b86db1b91'
    toolVersion = '1.0.0'
    startedAt = [DateTime]::UtcNow.ToString('o')
    os = [Environment]::OSVersion.VersionString
    is64BitOS = [Environment]::Is64BitOperatingSystem
}
$resultText = '未完成修复'
$outDir = Join-Path ([Environment]::GetFolderPath('Desktop')) ('Beav-连接诊断-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Safe-Text($value) {
    $text = [string]$value
    if ($env:USERPROFILE) {
        $escapedProfile = ConvertTo-Json -InputObject $env:USERPROFILE -Compress
        $text = $text.Replace($escapedProfile.Substring(1, $escapedProfile.Length - 2), '%USERPROFILE%')
        $text = $text.Replace($env:USERPROFILE, '%USERPROFILE%')
    }
    $text = $text -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1[redacted]'
    $text = $text -replace '(?i)((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;}]+', '$1[redacted]'
    return $text
}
function Read-Registration {
    $rows = @()
    foreach ($browser in @('Microsoft\Edge', 'Google\Chrome', 'BraveSoftware\Brave-Browser')) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
            $key = $null
            try {
                $key = $base.OpenSubKey('Software\' + $browser + '\NativeMessagingHosts\com.redbox.browser_control')
                $manifestPath = if ($key) { [string]$key.GetValue('') } else { '' }
                $hostPath = ''; $errorText = ''; $origins = @()
                if ($manifestPath) {
                    try {
                        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                        $hostPath = [string]$manifest.path
                        $origins = @($manifest.allowed_origins)
                    } catch { $errorText = $_.Exception.Message }
                }
                $rows += [pscustomobject]@{ browser=$browser; view=[string]$view; manifestPath=$manifestPath; hostPath=$hostPath; allowedOrigins=$origins; error=$errorText }
            } finally { if ($key) { $key.Dispose() }; $base.Dispose() }
        }
    }
    return $rows
}
function Run-AppCommand([string]$executable, [string]$argument) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $executable; $info.Arguments = $argument
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { $process.Kill(); throw '注册命令超时' }
        return @{ exitCode=$process.ExitCode; stdout=$stdout.Result; stderr=$stderr.Result }
    } finally { $process.Dispose() }
}

Write-Host 'Beav 浏览器连接修复与诊断' -ForegroundColor Cyan
Write-Host '请保持 Beav 打开。本工具修复本用户的浏览器连接注册，并自动发送脱敏诊断。'
Write-Host '不会关闭您的 App、清理数据或修改浏览器安全策略。'
try {
    $before = @(Read-Registration)
    $report.registrationBefore = $before
    # Prefer the running App; multiple installations require explicit file selection.
    $candidates = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('Beav', 'beav', 'redbox', 'RedBox') } | ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ } | Select-Object -Unique)
    if ($candidates.Count -eq 1) { $exe = $candidates[0] }
    else {
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.OpenFileDialog
        $picker.Title = '请选择您当前安装的 Beav.exe（通常在桌面快捷方式对应的位置）'
        $picker.Filter = 'Beav 应用 (*.exe)|*.exe'
        if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '未选择 Beav 程序，未修改注册' }
        $exe = $picker.FileName
    }
    $file = Get-Item -LiteralPath $exe
    if ($file.VersionInfo.ProductName -notmatch '(?i)beav|redbox' -and $file.BaseName -notmatch '^(?i:beav|redbox)$') { throw '所选文件不是 Beav 程序，已停止' }
    $report.executable = @{ path=$exe; fileVersion=$file.VersionInfo.FileVersion; productVersion=$file.VersionInfo.ProductVersion; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash; signature=[string](Get-AuthenticodeSignature -LiteralPath $exe).Status }
    Add-Type -Path (Join-Path $PSScriptRoot 'NativeProbe.cs')
    Write-Host '1/3 测试当前 Beav 的 Native Host...'
    try {
        $ping = [BeavNativeProbe]::Ping($exe) | ConvertFrom-Json
        $report.probe = @{ ok=($ping.result.ok -eq $true); hostVersion=$ping.result.appVersion; bridgeConnected=$ping.result.desktopBridge.connected; bridgeError=$ping.result.desktopBridge.errorCode; appVersion=$ping.result.desktopBridge.appVersion }
        if (!$report.probe.ok) { throw 'Host 未返回成功握手' }
    } catch { $report.probe = @{ ok=$false; error=$_.Exception.GetBaseException().Message } }
    Write-Host '2/3 备份注册并由 Beav 重新注册连接...'
    # Original paths stay local for support/rollback; only redacted copies are uploaded.
    $before | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outDir 'registration-backup.json') -Encoding UTF8
    $backupIndex = 0
    foreach ($entry in $before) {
        if ($entry.manifestPath -and (Test-Path -LiteralPath $entry.manifestPath)) {
            Copy-Item -LiteralPath $entry.manifestPath -Destination (Join-Path $outDir ('manifest-backup-' + $backupIndex + '.json'))
        }
        $backupIndex++
    }
    $repair = Run-AppCommand $exe '--install-browser-native-host'
    $report.repair = @{ exitCode=$repair.exitCode; stderr=$repair.stderr }
    $after = @(Read-Registration)
    # Browsers can inspect the 32-bit registry view first. Repair a stale shadow
    # only from a manifest just verified against the selected App and origin.
    if ($repair.exitCode -eq 0) {
        foreach ($browser in @('Microsoft\Edge', 'Google\Chrome', 'BraveSoftware\Brave-Browser')) {
            $valid = @($after | Where-Object { $_.browser -eq $browser -and $_.hostPath -ieq $exe -and $_.allowedOrigins -contains 'chrome-extension://dhfphfekcjahljnefpdjoidehnhhoeie/' })
            if ($valid.Count -eq 0) { continue }
            foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
                $key = $null
                try {
                    $key = $base.CreateSubKey('Software\' + $browser + '\NativeMessagingHosts\com.redbox.browser_control')
                    $key.SetValue('', $valid[0].manifestPath, [Microsoft.Win32.RegistryValueKind]::String)
                } finally { if ($key) { $key.Dispose() }; $base.Dispose() }
            }
        }
        $after = @(Read-Registration)
    }
    $report.registrationAfter = $after
    $edge = @($after | Where-Object { $_.browser -eq 'Microsoft\Edge' })
    $registered = @($edge | Where-Object { $_.hostPath -ieq $exe -and $_.allowedOrigins -contains 'chrome-extension://dhfphfekcjahljnefpdjoidehnhhoeie/' }).Count -eq $edge.Count
    $report.registrationMatches = $registered
    if ($repair.exitCode -eq 0 -and $registered -and $report.probe.ok) {
        $resultText = 'Host 握手通过，浏览器注册已修复。请到 Edge 扩展管理页重新加载 Beav 插件，再打开弹窗测试。'
    } elseif (!$report.probe.ok) {
        $resultText = '已定位：直接启动 Beav Native Host 也无法握手。详细错误将自动上报，请把下方诊断编号告知客服。'
    } else { $resultText = 'Host 握手通过，但注册校验未通过。详细错误将自动上报。' }
} catch { $report.error = $_.Exception.Message; $resultText = '未完成修复：' + $_.Exception.Message }

Write-Host '3/3 保存并上报诊断...'
try {
    $hostLog = Join-Path $env:APPDATA 'RedBox\native-host\browser-control-host.log'
    if (Test-Path -LiteralPath $hostLog) {
        # Only Host lifecycle and framing errors, not agent calls or business payloads.
        $report.hostLog = @(Get-Content -LiteralPath $hostLog -Tail 200 | Where-Object { $_ -match 'native host started|native messaging first request|native messaging stdin ended|fatal ' } | Select-Object -Last 40)
    }
} catch { $report.hostLogError = $_.Exception.Message }
$reportJson = Safe-Text ($report | ConvertTo-Json -Depth 12)
$reportJson | Set-Content -LiteralPath (Join-Path $outDir 'diagnostic.json') -Encoding UTF8
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $body = @{
        title='Windows 浏览器连接修复诊断'; content=('连接修复工具：' + $resultText)
        source='windows_connection_support'; request_kind='support_diagnostic'; category='plugin_connection'; priority='high'
        client=@{ platform='windows'; os_version=$report.os; app_version=$report.executable.productVersion }
        log_text=$reportJson.Substring(0, [Math]::Min($reportJson.Length, 16000))
        context=@{ supportCase=$report.supportCase; operation='windows_native_host_repair'; automatic=$true }
    } | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Uri 'https://api.ziz.hk/beav/v1/public-feedback' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
    if (!$response.item.id) { throw '服务器未返回反馈编号' }
    Write-Host ('诊断已送达，编号：' + $response.item.id) -ForegroundColor Green
    $response.item.id | Set-Content -LiteralPath (Join-Path $outDir 'feedback-id.txt') -Encoding UTF8
} catch { Write-Host ('自动发送失败，诊断已保存在桌面：' + $outDir) -ForegroundColor Yellow }
Write-Host $resultText -ForegroundColor Cyan
Write-Host '直接握手成功不代表 Edge 已恢复；请以插件弹窗显示“已连接”为准。'
