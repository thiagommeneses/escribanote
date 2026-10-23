# Instala o ajudante de áudio do Escribanote para o usuário atual (sem precisar de administrador):
# copia os arquivos para %LOCALAPPDATA%\Escribanote\Audio e registra o "native messaging host"
# no Chrome, no Edge e no Brave. Rode pelo Instalar.cmd.
$ErrorActionPreference = "Stop"
$dest = Join-Path $env:LOCALAPPDATA "Escribanote\Audio"
New-Item -Force -ItemType Directory $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot "EscribanoteAudio.exe") $dest -Force
Copy-Item (Join-Path $PSScriptRoot "NAudio.dll") $dest -Force
$exe = Join-Path $dest "EscribanoteAudio.exe"
$manifestPath = Join-Path $dest "com.escribanote.audio.json"
$manifest = @{
  name = "com.escribanote.audio"
  description = "Escribanote: audio do computador para a extensao (transcricao local)"
  path = $exe
  type = "stdio"
  allowed_origins = @("chrome-extension://ohbnmfogdcbgegnpcaphidkjinplednd/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))
$keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts"
)
foreach ($k in $keys) {
  $full = "$k\com.escribanote.audio"
  New-Item -Force -Path $full | Out-Null
  Set-ItemProperty -Path $full -Name "(default)" -Value $manifestPath
}
Write-Host ""
Write-Host "Ajudante do Escribanote instalado em $dest"
Write-Host "Agora abra o Escribanote > Gravador do computador e clique em 'Ativar o ajudante'."
