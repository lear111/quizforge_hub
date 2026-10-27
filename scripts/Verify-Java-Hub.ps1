param([switch]$SkipBuild,[string]$PracticeRuntime,[string]$UiPackage)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $taskRoot
$taskPreviousJar = $env:HUB_JAVA_JAR
$taskPreviousRuntime = $env:QFH_TEST_RUNTIME
$taskPreviousUi = $env:QFH_TEST_UI_PACKAGE
try {
    if ($PracticeRuntime) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath $PracticeRuntime).Path }
    elseif (-not $env:QFH_TEST_RUNTIME -and (Test-Path -LiteralPath '.runtime/web-sync-20261027-network/basic-demo.qbank')) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath '.runtime/web-sync-20261027-network').Path }
    elseif (-not $env:QFH_TEST_RUNTIME -and (Test-Path -LiteralPath '.runtime/web-sync-20261027/basic-demo.qbank')) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath '.runtime/web-sync-20261027').Path }
    elseif (-not $env:QFH_TEST_RUNTIME -and (Test-Path -LiteralPath '.runtime/web-java-migration-20261025/basic-demo.qbank')) { $env:QFH_TEST_RUNTIME = (Resolve-Path -LiteralPath '.runtime/web-java-migration-20261025').Path }
    if (-not $env:QFH_TEST_RUNTIME) { $env:QFH_TEST_RUNTIME = Join-Path $taskRoot '.runtime/web-current' }
    if (-not (Test-Path -LiteralPath (Join-Path $env:QFH_TEST_RUNTIME 'basic-demo.qbank'))) { throw 'Stage the reviewed practice runtime first; pass -PracticeRuntime with the runtime folder.' }
    if ($UiPackage) { $env:QFH_TEST_UI_PACKAGE = (Resolve-Path -LiteralPath $UiPackage).Path }
    elseif (-not $env:QFH_TEST_UI_PACKAGE -and (Test-Path -LiteralPath '../quizforge_web/core/node_modules/jsdom/package.json')) { $env:QFH_TEST_UI_PACKAGE = (Resolve-Path -LiteralPath '../quizforge_web/core/package.json').Path }
    if (-not $SkipBuild) {
        & mvn -B -ntp -f java-hub/pom.xml package
        if ($LASTEXITCODE -ne 0) { throw 'Java tests/build failed.' }
    }
    $env:HUB_JAVA_JAR = Join-Path $taskRoot 'java-hub/target/quizforge-hub-0.1.0-java-preview.jar'
    if (-not (Test-Path -LiteralPath $env:HUB_JAVA_JAR)) { throw 'Build Java Hub first.' }
    & node --test --test-concurrency=4 test/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node/Java contract comparison failed.' }
} finally {
    $env:HUB_JAVA_JAR = $taskPreviousJar
    $env:QFH_TEST_RUNTIME = $taskPreviousRuntime
    $env:QFH_TEST_UI_PACKAGE = $taskPreviousUi
    Pop-Location
}
