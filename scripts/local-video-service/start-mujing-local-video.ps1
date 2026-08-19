$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"

Add-Type -AssemblyName PresentationFramework

function Show-Message([string]$message, [string]$title = "幕境本地视频服务", [string]$buttons = "OK", [string]$icon = "Information") {
  return [System.Windows.MessageBox]::Show(
    $message,
    $title,
    [System.Windows.MessageBoxButton]::$buttons,
    [System.Windows.MessageBoxImage]::$icon
  )
}

function Ensure-FreeSpace([string]$driveName, [long]$minimumBytes) {
  $drive = Get-PSDrive -Name $driveName -PSProvider FileSystem -ErrorAction SilentlyContinue
  if (-not $drive) { throw "未找到 $driveName 盘。请连接或创建该磁盘后重试。" }
  if ($drive.Free -lt $minimumBytes) {
    $required = [math]::Ceiling($minimumBytes / 1GB)
    $available = [math]::Round($drive.Free / 1GB, 1)
    throw "$driveName 盘空间不足。首次安装至少需要 $required GB，目前可用 $available GB。"
  }
}

function Download-File([string]$url, [string]$destination, [string]$label, [string]$sha256 = "") {
  if (Test-Path -LiteralPath $destination) {
    if (-not $sha256 -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $sha256) {
      Write-Host "已存在，跳过：$label" -ForegroundColor Green
      return
    }
    Remove-Item -LiteralPath $destination -Force
  }

  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$destination.download"
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue

  Write-Host "正在下载：$label" -ForegroundColor Cyan
  Start-BitsTransfer -Source $url -Destination $temporary -DisplayName "幕境：$label" -Description "可以最小化窗口，下载完成前请勿关闭。"

  if ($sha256) {
    Write-Host "正在校验：$label"
    $actual = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
    if ($actual -ne $sha256) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      throw "$label 校验失败，已删除损坏文件，请重新运行启动器。"
    }
  }
  Move-Item -LiteralPath $temporary -Destination $destination -Force
}

function Test-Service {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

$installRoot = "D:\MuJing-ComfyUI"
$portableRoot = Join-Path $installRoot "ComfyUI_windows_portable"
$comfyRoot = Join-Path $portableRoot "ComfyUI"
$pythonPath = Join-Path $portableRoot "python_embeded\python.exe"
$mainPath = Join-Path $comfyRoot "main.py"
$modelRoot = "D:\MuJing-ComfyUI-Models"
$downloadRoot = Join-Path $installRoot "downloads"
$archivePath = Join-Path $downloadRoot "ComfyUI_windows_portable_nvidia.7z"
$extraModelsPath = Join-Path $installRoot "extra_model_paths.mujing.yaml"

try {
  if (Test-Service) {
    Show-Message "本地视频服务已经在运行。`n`n服务地址：http://127.0.0.1:8188" | Out-Null
    exit 0
  }

  Ensure-FreeSpace "D" (35GB)

  $gpuNames = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  if (-not ($gpuNames -match "NVIDIA")) {
    throw "当前启动器安装的是 NVIDIA 版 ComfyUI，但没有检测到 NVIDIA 显卡。为避免下载无用的约 18GB 模型，已停止安装。"
  }

  if (-not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $mainPath)) {
    $answer = Show-Message "首次使用需要从官方来源下载 ComfyUI 运行环境和 Wan 2.2 模型。`n`n下载量约 18GB，安装后约需 35GB D 盘空间。`n安装位置：D:\MuJing-ComfyUI`n模型位置：D:\MuJing-ComfyUI-Models`n`n是否现在开始？" "幕境本地视频服务" "YesNo" "Question"
    if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { exit 0 }

    Download-File "https://github.com/Comfy-Org/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z" $archivePath "ComfyUI 官方 NVIDIA 便携版"
    Write-Host "正在解压 ComfyUI，这一步可能需要几分钟……" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    & "$env:SystemRoot\System32\tar.exe" -xf $archivePath -C $installRoot
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $mainPath)) {
      throw "ComfyUI 解压失败。请确认 Windows 已更新并支持解压 7z，然后重新运行。"
    }
  }

  New-Item -ItemType Directory -Path (Join-Path $modelRoot "diffusion_models") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $modelRoot "text_encoders") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $modelRoot "vae") -Force | Out-Null

  $models = @(
    @{
      Label = "Wan 2.2 TI2V 5B 主模型（约 10GB）"
      Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
      Path = Join-Path $modelRoot "diffusion_models\wan2.2_ti2v_5B_fp16.safetensors"
      Sha256 = "456F901338BD9EAD BDED3828B819109A9B68E8A525CA5CF8D0049A69FCFECA1E" -replace " ", ""
    },
    @{
      Label = "Wan 2.2 UMT5 文本编码器（约 6.7GB）"
      Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
      Path = Join-Path $modelRoot "text_encoders\umt5_xxl_fp8_e4m3fn_scaled.safetensors"
      Sha256 = "C3355D30191F1F066B26D93FBA017AE9809DCE6C627DDA5F6A66EAA651204F68"
    },
    @{
      Label = "Wan 2.2 VAE（约 1.4GB）"
      Url = "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors"
      Path = Join-Path $modelRoot "vae\wan2.2_vae.safetensors"
      Sha256 = "E40321BD36B9709991DAE2530EB4AC303DD168276980D3E9BC4B6E2B75FED156"
    }
  )

  foreach ($model in $models) {
    Download-File $model.Url $model.Path $model.Label $model.Sha256
  }

  @"
mujing_wan22:
  base_path: D:/MuJing-ComfyUI-Models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
"@ | Set-Content -LiteralPath $extraModelsPath -Encoding UTF8

  Write-Host "正在启动幕境本地视频服务……" -ForegroundColor Cyan
  Start-Process -WindowStyle Hidden -FilePath $pythonPath -ArgumentList @(
    $mainPath,
    "--listen", "127.0.0.1",
    "--port", "8188",
    "--preview-method", "auto",
    "--disable-cuda-malloc",
    "--extra-model-paths-config", $extraModelsPath
  ) -WorkingDirectory $comfyRoot

  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-Service) {
      Show-Message "本地视频服务启动成功。`n`n服务地址：http://127.0.0.1:8188`n现在可以回到幕境生成视频。" | Out-Null
      exit 0
    }
    Start-Sleep -Seconds 1
  }
  throw "ComfyUI 启动超时。请重新运行启动器；如果仍失败，请检查显卡驱动和 D 盘文件是否完整。"
} catch {
  Show-Message $_.Exception.Message "幕境本地视频服务启动失败" "OK" "Error" | Out-Null
  Write-Error $_
  exit 1
}
