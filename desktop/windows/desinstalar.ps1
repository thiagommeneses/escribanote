# Remove o ajudante de áudio do Escribanote (arquivos e registro) do usuário atual.
$ErrorActionPreference = "SilentlyContinue"
foreach ($k in @("HKCU:\Software\Google\Chrome\NativeMessagingHosts", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts", "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts", "HKCU:\Software\Chromium\NativeMessagingHosts")) {
  Remove-Item -Recurse -Force "$k\com.escribanote.audio"
}
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "Escribanote\Audio")
Write-Host "Ajudante do Escribanote removido."
