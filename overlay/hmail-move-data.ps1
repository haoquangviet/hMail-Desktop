# hMail Desktop — di chuyển thư mục dữ liệu (MIT — HQV Software)
#
# Được nút "Di chuyển dữ liệu…" trong Cài đặt gọi, ngay trước khi hMail tự
# thoát. Chờ ứng dụng đóng hẳn, chuyển thư mục hồ sơ sang nơi người dùng đã
# chọn, trỏ profiles.ini theo đường dẫn TUYỆT ĐỐI tới nơi mới (đúng cơ chế
# trang "Nơi lưu dữ liệu" của bộ cài dùng cho máy mới), rồi mở lại hMail.
# Không có bước nào phá huỷ trước khi bản sao hoàn tất: cùng ổ đĩa thì đổi
# tên (tức thời), khác ổ thì robocopy xong xuôi mới xoá nguồn.
param(
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$AppExe
)

$log = Join-Path $env:TEMP "hmail-move-data.log"
Start-Transcript -Path $log -Force | Out-Null

function Fail([string]$why) {
  Write-Output "BỎ DỞ: $why"
  Stop-Transcript | Out-Null
  exit 1
}

# ---- 1. app phải đóng hẳn đã ------------------------------------------------
for ($i = 0; $i -lt 180; $i++) {
  if (-not (Get-Process hmail -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}
if (Get-Process hmail -ErrorAction SilentlyContinue) {
  Fail "hMail không thoát trong 180 giây — không đụng vào dữ liệu."
}

if (-not (Test-Path $ProfilePath)) { Fail "Không thấy thư mục hồ sơ: $ProfilePath" }
$src = (Get-Item $ProfilePath).FullName.TrimEnd('\')
$dst = $Target.TrimEnd('\')
if ($src -ieq $dst) { Fail "Nơi mới trùng nơi cũ." }

# Đích phải trống (hoặc chưa tồn tại): không bao giờ trộn vào dữ liệu lạ.
if (Test-Path $dst) {
  if (@(Get-ChildItem $dst -Force -ErrorAction SilentlyContinue).Count -gt 0) {
    Fail "Thư mục đích không trống: $dst"
  }
  Remove-Item $dst -Force -Confirm:$false
}

# ---- 2. chuyển --------------------------------------------------------------
$sameVolume = ([IO.Path]::GetPathRoot($src) -ieq [IO.Path]::GetPathRoot($dst))
if ($sameVolume) {
  $parent = Split-Path $dst -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Move-Item -Path $src -Destination $dst
} else {
  robocopy $src $dst /E /COPY:DAT /DCOPY:DAT /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "robocopy lỗi (mã $LASTEXITCODE) — dữ liệu gốc còn nguyên." }
  Remove-Item $src -Recurse -Force -Confirm:$false
}

# ---- 3. trỏ profiles.ini sang nơi mới --------------------------------------
# Cả mục [ProfileN] (Path=, IsRelative=) lẫn [Install…] (Default=) đều có thể
# đang tham chiếu hồ sơ vừa chuyển — theo đường tương đối "Profiles/xxx" hoặc
# tuyệt đối. Ghi lại tất cả về một đường tuyệt đối duy nhất.
$ini = Join-Path $env:APPDATA "Thunderbird\profiles.ini"
if (-not (Test-Path $ini)) { Fail "Không thấy profiles.ini: $ini" }
$leaf = Split-Path $src -Leaf
$relative = "Profiles/$leaf"
$matchesOld = {
  param($value)
  $v = $value.Trim().Replace('\', '/')
  ($v -ieq $relative) -or ($v.TrimEnd('/') -ieq $src.Replace('\', '/'))
}

$lines = Get-Content $ini -Encoding UTF8
$section = ""
$touched = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]
  if ($line -match '^\[(.+)\]') { $section = $Matches[1]; continue }
  if ($line -match '^(Path|Default)=(.*)$' -and (& $matchesOld $Matches[2])) {
    $lines[$i] = "$($Matches[1])=$dst"
    if ($Matches[1] -eq 'Path') { $touched += $section }
  }
}
# Đường đã tuyệt đối thì IsRelative của mục đó phải là 0.
$section = ""
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\[(.+)\]') { $section = $Matches[1]; continue }
  if (($touched -contains $section) -and $lines[$i] -match '^IsRelative=') {
    $lines[$i] = "IsRelative=0"
  }
}
Set-Content -Path $ini -Value $lines -Encoding UTF8
Write-Output "profiles.ini đã trỏ về: $dst (mục: $($touched -join ', '))"

# ---- 4. mở lại --------------------------------------------------------------
Start-Process -FilePath $AppExe
Write-Output "XONG."
Stop-Transcript | Out-Null
