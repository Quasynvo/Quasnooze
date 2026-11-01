param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
# This process-only execution policy is supplied by the explicit desktop launcher.
# No machine policy, administrator rights, Python, or cloud speech service is used.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Speech, System.Web.Extensions
Add-Type -Path (Join-Path $PSScriptRoot 'Companion.cs') -ReferencedAssemblies @(
    'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
    'System.Speech.dll', 'System.Web.Extensions.dll'
)
if ($CheckOnly) { [PinchCompanion]::SelfTest(); exit 0 }
[PinchCompanion]::Run()
