param([switch]$SkipBuild,[string]$PracticeRuntime)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
$taskPreviousJar = $env:HUB_JAVA_JAR
$taskPreviousRuntime = $env:QFH_TEST_RUNTIME
try {
    if ($PracticeRuntime) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath $PracticeRuntime).Path }
    elseif (-not $env:QFH_TEST_RUNTIME -and (Test-Path -LiteralPath '.runtime/web-java-migration-20261025/basic-demo.qbank')) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath '.runtime/web-java-migration-20261025').Path }
    if (-not $env:QFH_TEST_RUNTIME) { $env:QFH_TEST_RUNTIME = Join-Path $PSScriptRoot '.runtime/web-current' }
    if (-not (Test-Path -LiteralPath (Join-Path $env:QFH_TEST_RUNTIME 'basic-demo.qbank'))) { throw 'Stage the reviewed practice runtime first; pass -PracticeRuntime with the runtime folder.' }
    if (-not $SkipBuild) {
        & mvn -B -ntp -f java-hub/pom.xml package
        if ($LASTEXITCODE -ne 0) { throw 'Java tests/build failed.' }
    }
    $env:HUB_JAVA_JAR = Join-Path $PSScriptRoot 'java-hub/target/quizforge-hub-0.1.0-java-preview.jar'
    if (-not (Test-Path -LiteralPath $env:HUB_JAVA_JAR)) { throw 'Build Java Hub first.' }
    & node --test --test-concurrency=4 test/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node/Java contract comparison failed.' }
} finally {
    $env:HUB_JAVA_JAR = $taskPreviousJar
    $env:QFH_TEST_RUNTIME = $taskPreviousRuntime
    Pop-Location
}
