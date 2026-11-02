param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$Launcher,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Pinch.lnk'
if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    exit 0
}
$node = (Resolve-Path -LiteralPath $NodePath).Path
$script = (Resolve-Path -LiteralPath $Launcher).Path
if ([IO.Path]::GetFileName($node) -ne 'node.exe' -or [IO.Path]::GetFileName($script) -ne 'desktop.js') {
    throw 'Only the installed Node executable and Quasnooze desktop launcher are accepted.'
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = $node
$link.Arguments = '"' + $script + '"'
$link.WorkingDirectory = Split-Path (Split-Path $script -Parent) -Parent
$link.WindowStyle = 7
$link.Description = 'Quasnooze resident assistant. Microphone starts muted.'
$link.Save()
