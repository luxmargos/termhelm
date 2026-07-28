param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string] $Architecture
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $nativeRoot "win32-$Architecture"
$outputPath = Join-Path $outputDirectory 'termhelm-controller.exe'
$objectPath = Join-Path $outputDirectory 'termhelm-controller.obj'
$sourcePath = Join-Path $PSScriptRoot 'termhelm-controller.cpp'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  throw 'vswhere.exe was not found; install Visual Studio Build Tools with MSVC.'
}

$requiredComponent = if ($Architecture -eq 'arm64') {
  'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
} else {
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
}
$installationPath = & $vswhere -latest -products '*' -requires $requiredComponent -property installationPath
if (-not $installationPath) {
  throw "Visual Studio with $requiredComponent was not found."
}

$vcvarsall = Join-Path $installationPath 'VC/Auxiliary/Build/vcvarsall.bat'
if (-not (Test-Path -LiteralPath $vcvarsall -PathType Leaf)) {
  throw "vcvarsall.bat was not found under $installationPath."
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$vcTarget = if ($Architecture -eq 'arm64') { 'x64_arm64' } else { 'x64' }
$compileCommand = 'call "{0}" {1} >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /MT /W4 /DUNICODE /D_UNICODE /permissive- /Fo:"{2}" /Fe:"{3}" "{4}" /link /OPT:REF /OPT:ICF' -f `
  $vcvarsall, $vcTarget, $objectPath, $outputPath, $sourcePath

& $env:ComSpec /d /s /c $compileCommand
if ($LASTEXITCODE -ne 0) {
  throw "MSVC failed to build the $Architecture Windows controller (exit $LASTEXITCODE)."
}
Remove-Item -LiteralPath $objectPath -Force -ErrorAction SilentlyContinue

$bytes = [IO.File]::ReadAllBytes($outputPath)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
  throw "The $Architecture controller is not a valid PE executable."
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length -or
    $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45) {
  throw "The $Architecture controller has an invalid PE header."
}
$actualMachine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$expectedMachine = if ($Architecture -eq 'arm64') { 0xaa64 } else { 0x8664 }
if ($actualMachine -ne $expectedMachine) {
  throw ('Expected PE machine 0x{0:x4}, found 0x{1:x4}.' -f $expectedMachine, $actualMachine)
}

Write-Host "Built $outputPath with MSVC ($Architecture)."
