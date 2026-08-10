# hMail Desktop — deploy overlay đang sửa vào bản đã cài rồi mở lại app.
# Dùng khi dev: sửa file trong overlay\ xong chạy script này là thấy ngay.
#
# Đóng app bằng CloseMainWindow (tương đương bấm nút X — đi đường shutdown
# sạch, không hỏng cache .msf như Stop-Process -Force; hmail://quit hiện
# không tin được — xem backlog #7). App đang bận (dựng index…) mà không chịu
# thoát thì script bỏ cuộc thay vì ép.
$ErrorActionPreference = "Stop"
# Cửa sổ elevated đóng ngay khi lỗi — transcript giữ lại hiện trường.
Start-Transcript -Path (Join-Path $env:TEMP "hmail-deploy-dev.log") -Append | Out-Null
$repo = Split-Path $PSScriptRoot -Parent
$dest = "C:\Program Files\hMail Desktop"

$isAdmin = ([Security.Principal.WindowsPrincipal](
  [Security.Principal.WindowsIdentity]::GetCurrent()
)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  exit
}

$live = Get-Process hmail -ErrorAction SilentlyContinue
if ($live) {
  # Thoát tử tế qua deep link (KHÔNG -osint — cờ tự chế bị remoting vứt,
  # backlog #7); không ăn thì bồi nút X.
  Write-Output "Đóng hMail (hmail://quit)…"
  & "$dest\hmail.exe" -hmail-url "hmail://quit" 2>$null
  Start-Sleep -Seconds 5
  $live = Get-Process hmail -ErrorAction SilentlyContinue
}
if ($live) {
  Write-Output "Đóng hMail (nút X)…"
  $live | Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { $null = $_.CloseMainWindow() }
  for ($i = 0; $i -lt 90; $i++) {
    if (-not (Get-Process hmail -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
  if (Get-Process hmail -ErrorAction SilentlyContinue) {
    throw "hMail không thoát trong 90 giây (đang bận?) — không deploy."
  }
}

Write-Output "Chép overlay vào $dest…"
# robocopy thay cho Copy-Item: lần chép wildcard từng bỏ sót hmail.cfg mà
# không kêu một tiếng; robocopy báo lỗi ra mặt và tự thử lại.
robocopy "$repo\overlay" $dest /E /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) {
  throw "robocopy lỗi (mã $LASTEXITCODE) — soát lại quyền ghi vào $dest."
}

# Mở lại qua explorer để app chạy KHÔNG elevated (app elevated phá bộ gõ
# tiếng Việt và kéo-thả từ Explorer thường).
Start-Process explorer.exe "$dest\hmail.exe"
Write-Output "Xong — app đã mở lại với bản overlay mới."
