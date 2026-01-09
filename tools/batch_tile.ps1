$projectRoot = Split-Path -Parent $PSScriptRoot
$gen = Join-Path $PSScriptRoot "generate.py"
$inputDir = Join-Path $projectRoot "in"
$outRoot = Join-Path $projectRoot "scenes"

# Update if needed:
$nona = "C:\Program Files\Hugin\bin\nona.exe"

# Settings
$tileSize = 512
$jpegQuality = 75

if (!(Test-Path $gen)) { throw "Missing generate.py at: $gen" }
if (!(Test-Path $nona)) { throw "Missing nona.exe at: $nona" }

New-Item -ItemType Directory -Force -Path $inputDir | Out-Null
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

# Grab all JPG/JPEG/PNG (in case)
$images = Get-ChildItem $inputDir -File | Where-Object {
  $_.Extension -match '\.(jpg|jpeg|png)$'
}

foreach ($img in $images) {
  $sceneId = [System.IO.Path]::GetFileNameWithoutExtension($img.Name)
  $dest = Join-Path $outRoot $sceneId

  if (Test-Path $dest) {
    Write-Host "SKIP (already tiled): $sceneId" -ForegroundColor Cyan
    continue
  }

  Write-Host "TILING: $sceneId" -ForegroundColor Green

  python $gen `
    -n $nona `
    -o $dest `
    -s $tileSize `
    -q $jpegQuality `
    $img.FullName

  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $sceneId" -ForegroundColor Red
  }
}

Write-Host "Done. Output in: $outRoot" -ForegroundColor Green
