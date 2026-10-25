param([int]$Port = 4338, [string]$DataDir = '', [string]$CookieName = '', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $taskRoot 'java-hub/data-java' }
if ([string]::IsNullOrWhiteSpace($CookieName)) { $CookieName = if ($env:HUB_COOKIE_NAME) { $env:HUB_COOKIE_NAME } else { 'qfh_java_preview' } }
if ($CookieName -notmatch '^[a-z][a-z0-9_]{0,40}$') { throw 'Invalid session cookie name.' }
if (-not $SkipBuild) {
    & mvn -B -ntp -f (Join-Path $taskRoot 'java-hub/pom.xml') package
    if ($LASTEXITCODE -ne 0) { throw 'Java Hub build or tests failed.' }
}
$taskJar = Join-Path $taskRoot 'java-hub/target/quizforge-hub-0.1.0-java-preview.jar'
if (-not (Test-Path -LiteralPath $taskJar)) { throw 'Build the Java Hub first.' }
$taskJava = if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { 'java' }
Write-Host "Java Hub preview: http://127.0.0.1:$Port/ (Ctrl+C to stop)"
& $taskJava -jar $taskJar "--server.port=$Port" "--hub.data-dir=$([IO.Path]::GetFullPath($DataDir))" "--hub.cookie-name=$CookieName"
exit $LASTEXITCODE
