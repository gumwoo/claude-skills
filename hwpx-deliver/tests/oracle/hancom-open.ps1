# 개발 검증용: 한컴오피스(설치돼 있을 때만)로 HWPX를 열어 본다. skill 실행에는 쓰지 않는다.
# 한컴은 임시 폴더 밖 파일을 열 때 '접근 허용' 창을 띄우므로, 입력을 %TEMP% 아래로 복사해서 다룬다.
# 결과: <이름>.hancom.pdf, <이름>.hancom.hwpx, <이름>.hancom.txt(UNICODE), <이름>.hancom.html, 표준 출력에 JSON 한 줄
param([Parameter(Mandatory = $true)][string]$Hwpx, [string]$OutDir = "")
$ErrorActionPreference = "Stop"
$work = Join-Path $env:TEMP "hwpx-deliver-oracle"
New-Item -ItemType Directory -Force $work | Out-Null
$name = [IO.Path]::GetFileNameWithoutExtension($Hwpx)
$src = Join-Path $work "$name.hwpx"
if ((Resolve-Path $Hwpx).Path -ne $src) { Copy-Item $Hwpx $src -Force }
if (-not $OutDir) { $OutDir = Split-Path (Resolve-Path $Hwpx).Path }
$res = [ordered]@{ file = $Hwpx; opened = $false; pages = $null; saved_pdf = $false; saved_hwpx = $false; error = $null }
$hwp = $null
try {
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $res.opened = [bool]$hwp.Open($src, "HWPX", "forceopen:true;versionwarning:false")
  if ($res.opened) {
    $res.pages = $hwp.PageCount
    $txt = $hwp.GetTextFile("UNICODE", "")
    [IO.File]::WriteAllText((Join-Path $work "$name.hancom.txt"), $txt, [Text.UTF8Encoding]::new($false))
    $html = $hwp.GetTextFile("HTML", "")
    [IO.File]::WriteAllText((Join-Path $work "$name.hancom.html"), $html, [Text.UTF8Encoding]::new($false))
    $res.saved_pdf = [bool]$hwp.SaveAs((Join-Path $work "$name.hancom.pdf"), "PDF", "")
    $res.saved_hwpx = [bool]$hwp.SaveAs((Join-Path $work "$name.hancom.hwpx"), "HWPX", "")
  }
} catch { $res.error = $_.Exception.Message }
finally {
  if ($hwp) { try { $hwp.Clear(1) | Out-Null; $hwp.Quit() } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) }
}
foreach ($ext in @("hancom.pdf", "hancom.hwpx", "hancom.txt", "hancom.html")) {
  $f = Join-Path $work "$name.$ext"
  if ((Test-Path $f) -and ($work -ne $OutDir)) { Copy-Item $f (Join-Path $OutDir "$name.$ext") -Force }
}
$res | ConvertTo-Json -Compress
