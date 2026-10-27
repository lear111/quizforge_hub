param([Parameter(Mandatory=$true)][string]$DataDir,[Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskJar = Join-Path $taskRoot 'java-hub/target/quizforge-hub-0.1.0-java-preview.jar'
if (-not (Test-Path -LiteralPath $taskJar)) { throw 'Build the Java Hub first.' }
$taskJava = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { 'java' }
$taskData = [IO.Path]::GetFullPath($DataDir)
& $taskJava '-Dloader.main=cloud.treenewbee.quizforge.hub.maintenance.HubAdminCli' '-cp' $taskJar 'org.springframework.boot.loader.launch.PropertiesLauncher' @CommandArgs "--data-dir=$taskData"
exit $LASTEXITCODE
