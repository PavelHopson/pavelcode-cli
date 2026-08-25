[CmdletBinding()]
param(
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\build'
}

Add-Type -AssemblyName System.Drawing

if (-not ('EclipseForge.NativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace EclipseForge {
  public static class NativeMethods {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
  }
}
'@
}

$palette = @{
  Background = [System.Drawing.ColorTranslator]::FromHtml('#050507')
  Panel = [System.Drawing.ColorTranslator]::FromHtml('#0B0D10')
  Raised = [System.Drawing.ColorTranslator]::FromHtml('#15181D')
  Line = [System.Drawing.ColorTranslator]::FromHtml('#49323A')
  Signal = [System.Drawing.ColorTranslator]::FromHtml('#FF304A')
  SignalSoft = [System.Drawing.ColorTranslator]::FromHtml('#FF7B89')
  Gold = [System.Drawing.ColorTranslator]::FromHtml('#A60D24')
  Text = [System.Drawing.ColorTranslator]::FromHtml('#F3F5F7')
  Muted = [System.Drawing.ColorTranslator]::FromHtml('#9AA1AB')
}

function New-BrandFont {
  param([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
  try {
    return [System.Drawing.Font]::new('Segoe UI', $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
  } catch {
    return [System.Drawing.Font]::new([System.Drawing.FontFamily]::GenericSansSerif, $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
  }
}

function Initialize-Graphics {
  param([System.Drawing.Bitmap]$Bitmap)
  $graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return $graphics
}

function Draw-BrandBackground {
  param(
    [System.Drawing.Graphics]$Graphics,
    [int]$Width,
    [int]$Height
  )
  $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Point]::new(0, 0),
    [System.Drawing.Point]::new($Width, $Height),
    $palette.Panel,
    $palette.Background
  )
  try {
    $Graphics.FillRectangle($gradient, 0, 0, $Width, $Height)
  } finally {
    $gradient.Dispose()
  }

  $gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(18, $palette.Signal), 1)
  try {
    for ($x = 0; $x -lt $Width; $x += 24) { $Graphics.DrawLine($gridPen, $x, 0, $x, $Height) }
    for ($y = 0; $y -lt $Height; $y += 24) { $Graphics.DrawLine($gridPen, 0, $y, $Width, $y) }
  } finally {
    $gridPen.Dispose()
  }
}

function Draw-EclipseMark {
  param(
    [System.Drawing.Graphics]$Graphics,
    [float]$CenterX,
    [float]$CenterY,
    [float]$Radius
  )
  $orbitPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(92, $palette.Signal), [Math]::Max(1, $Radius / 22))
  $innerPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(48, $palette.Signal), [Math]::Max(1, $Radius / 28))
  $axisPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(145, $palette.Signal), [Math]::Max(1, $Radius / 28))
  $goldPen = [System.Drawing.Pen]::new($palette.Gold, [Math]::Max(1.5, $Radius / 14))
  $coreBrush = [System.Drawing.SolidBrush]::new($palette.SignalSoft)
  $signalBrush = [System.Drawing.SolidBrush]::new($palette.Gold)
  try {
    $Graphics.DrawEllipse($orbitPen, $CenterX - $Radius, $CenterY - $Radius, $Radius * 2, $Radius * 2)
    $innerRadius = $Radius * 0.62
    $Graphics.DrawEllipse($innerPen, $CenterX - $innerRadius, $CenterY - $innerRadius, $innerRadius * 2, $innerRadius * 2)
    $Graphics.DrawArc($goldPen, $CenterX - $Radius * 0.82, $CenterY - $Radius * 0.82, $Radius * 1.64, $Radius * 1.64, 58, 244)
    $axisGap = $Radius * 1.16
    $axisEnd = $Radius * 1.38
    $Graphics.DrawLine($axisPen, $CenterX - $axisEnd, $CenterY, $CenterX - $axisGap, $CenterY)
    $Graphics.DrawLine($axisPen, $CenterX + $axisGap, $CenterY, $CenterX + $axisEnd, $CenterY)
    $Graphics.DrawLine($axisPen, $CenterX, $CenterY - $axisEnd, $CenterX, $CenterY - $axisGap)
    $Graphics.DrawLine($axisPen, $CenterX, $CenterY + $axisGap, $CenterX, $CenterY + $axisEnd)
    $coreRadius = [Math]::Max(2.5, $Radius * 0.14)
    $Graphics.FillEllipse($coreBrush, $CenterX - $coreRadius, $CenterY - $coreRadius, $coreRadius * 2, $coreRadius * 2)
    $signalRadius = [Math]::Max(1.8, $Radius * 0.07)
    $Graphics.FillEllipse($signalBrush, $CenterX + $Radius * 0.76 - $signalRadius, $CenterY - $Radius * 0.52 - $signalRadius, $signalRadius * 2, $signalRadius * 2)
  } finally {
    $orbitPen.Dispose()
    $innerPen.Dispose()
    $axisPen.Dispose()
    $goldPen.Dispose()
    $coreBrush.Dispose()
    $signalBrush.Dispose()
  }
}

function Save-BitmapAsset {
  param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

$sidebar = [System.Drawing.Bitmap]::new(164, 314, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$sidebarGraphics = Initialize-Graphics $sidebar
try {
  Draw-BrandBackground $sidebarGraphics 164 314
  Draw-EclipseMark $sidebarGraphics 82 84 42
  $signalPen = [System.Drawing.Pen]::new($palette.Signal, 2)
  $goldBrush = [System.Drawing.SolidBrush]::new($palette.Gold)
  $textBrush = [System.Drawing.SolidBrush]::new($palette.Text)
  $mutedBrush = [System.Drawing.SolidBrush]::new($palette.Muted)
  $brandFont = New-BrandFont 13 ([System.Drawing.FontStyle]::Bold)
  $productFont = New-BrandFont 18 ([System.Drawing.FontStyle]::Bold)
  $captionFont = New-BrandFont 9
  $center = [System.Drawing.StringFormat]::new()
  $center.Alignment = [System.Drawing.StringAlignment]::Center
  try {
    $sidebarGraphics.DrawLine($signalPen, 52, 154, 112, 154)
    $sidebarGraphics.FillEllipse($goldBrush, 79, 150.5, 7, 7)
    $sidebarGraphics.DrawString('ECLIPSE FORGE', $brandFont, $mutedBrush, [System.Drawing.RectangleF]::new(8, 178, 148, 22), $center)
    $sidebarGraphics.DrawString('ULTRON', $productFont, $textBrush, [System.Drawing.RectangleF]::new(8, 201, 148, 34), $center)
    $sidebarGraphics.DrawString('LOCAL AI OPERATOR', $captionFont, $mutedBrush, [System.Drawing.RectangleF]::new(8, 243, 148, 20), $center)
    $sidebarGraphics.DrawString('SECURE BY DEFAULT', $captionFont, $goldBrush, [System.Drawing.RectangleF]::new(8, 275, 148, 18), $center)
  } finally {
    $signalPen.Dispose(); $goldBrush.Dispose(); $textBrush.Dispose(); $mutedBrush.Dispose()
    $brandFont.Dispose(); $productFont.Dispose(); $captionFont.Dispose(); $center.Dispose()
  }
  Save-BitmapAsset $sidebar (Join-Path $resolvedOutput 'installerSidebar.bmp')
  Save-BitmapAsset $sidebar (Join-Path $resolvedOutput 'uninstallerSidebar.bmp')
} finally {
  $sidebarGraphics.Dispose(); $sidebar.Dispose()
}

$header = [System.Drawing.Bitmap]::new(150, 57, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$headerGraphics = Initialize-Graphics $header
try {
  Draw-BrandBackground $headerGraphics 150 57
  Draw-EclipseMark $headerGraphics 114 28.5 18
  $linePen = [System.Drawing.Pen]::new($palette.Gold, 2)
  try { $headerGraphics.DrawLine($linePen, 18, 28, 76, 28) } finally { $linePen.Dispose() }
  Save-BitmapAsset $header (Join-Path $resolvedOutput 'installerHeader.bmp')
} finally {
  $headerGraphics.Dispose(); $header.Dispose()
}

$iconBitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$iconGraphics = Initialize-Graphics $iconBitmap
$iconHandle = [IntPtr]::Zero
try {
  $iconGraphics.Clear([System.Drawing.Color]::Transparent)
  $iconBackground = [System.Drawing.SolidBrush]::new($palette.Background)
  try { $iconGraphics.FillEllipse($iconBackground, 12, 12, 232, 232) } finally { $iconBackground.Dispose() }
  Draw-EclipseMark $iconGraphics 128 128 84
  $iconHandle = $iconBitmap.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  $iconPath = Join-Path $resolvedOutput 'eclipse-sentinel.ico'
  if (Test-Path -LiteralPath $iconPath) { Remove-Item -LiteralPath $iconPath -Force }
  $stream = [System.IO.FileStream]::new($iconPath, [System.IO.FileMode]::CreateNew)
  try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
} finally {
  if ($iconHandle -ne [IntPtr]::Zero) { [EclipseForge.NativeMethods]::DestroyIcon($iconHandle) | Out-Null }
  $iconGraphics.Dispose(); $iconBitmap.Dispose()
}

Write-Host "Generated Eclipse Ultron installer assets in $resolvedOutput"
