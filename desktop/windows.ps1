param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
# This process-only execution policy is supplied by the explicit desktop launcher.
# No machine policy, administrator rights, Python, or cloud speech service is used.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Speech, System.Web.Extensions
# CodeDOM does not reliably resolve a bare System.Speech.dll from the GAC.
# Resolve the actual installed framework assemblies instead of guessing paths.
$references = @(
    [System.Uri].Assembly.Location
    [System.Linq.Enumerable].Assembly.Location
    [System.Drawing.Bitmap].Assembly.Location
    [System.Windows.Forms.Form].Assembly.Location
    [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location
    [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
)
Add-Type -Path (Join-Path $PSScriptRoot 'Companion.cs') -ReferencedAssemblies $references
if ($CheckOnly) { [PinchCompanion]::SelfTest(); exit 0 }
[PinchCompanion]::Run()
