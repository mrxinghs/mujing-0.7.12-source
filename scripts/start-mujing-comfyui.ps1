$ErrorActionPreference = "Stop"

$pythonPath = "C:\ComfyUI-Kawork-v312\ComfyUI-Kawork-v312\python\python.exe"
$comfyRoot = "C:\ComfyUI-Kawork-v312\ComfyUI-Kawork-v312\ComfyUI"
$mainPath = Join-Path $comfyRoot "main.py"

if (-not (Test-Path -LiteralPath $pythonPath)) {
  throw "未找到 ComfyUI Python：$pythonPath"
}

if (-not (Test-Path -LiteralPath $mainPath)) {
  throw "未找到 ComfyUI：$mainPath"
}

$listening = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "幕境本地视频服务已在运行：http://127.0.0.1:8188"
  exit 0
}

Start-Process -WindowStyle Hidden -FilePath $pythonPath -ArgumentList @(
  $mainPath,
  "--listen", "127.0.0.1",
  "--port", "8188",
  "--preview-method", "auto",
  "--disable-cuda-malloc"
) -WorkingDirectory $comfyRoot

for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -TimeoutSec 2 | Out-Null
    Write-Host "幕境本地视频服务启动成功：http://127.0.0.1:8188"
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}

throw "ComfyUI 启动超时，请检查 Kawork ComfyUI 的启动日志。"
