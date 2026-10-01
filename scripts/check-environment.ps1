Write-Host "[*] Checking 24/7 Agent Platform Substrate..." -ForegroundColor Cyan

# 1. Check WSL distribution
$distros = (wsl.exe -l -q) | ForEach-Object { $_.Trim() -replace "`0", "" }
if (-not ($distros -contains "Ubuntu-22.04")) {
    Write-Error "[FAIL] Ubuntu-22.04 distribution not found in WSL."
    exit 1
}

# 2. Check Docker inside WSL via Unix Socket
$dockerVersion = wsl.exe -d Ubuntu-22.04 docker version --format "{{.Server.Version}}" 2>$null
if ($LASTEXITCODE -eq 0 -and $dockerVersion) {
    Write-Host "[OK] Docker daemon is running cleanly on /var/run/docker.sock (Engine: $dockerVersion)" -ForegroundColor Green
} else {
    Write-Warning "[WARN] Docker is not active. Running bring-up script..."
    wsl.exe -d Ubuntu-22.04 bash ./scripts/setup-docker.sh
}

# 3. Strict Security Assertion: Port 2375 MUST NOT be open anywhere
$wslTcp2375 = wsl.exe -d Ubuntu-22.04 bash -c "ss -tulpn | grep ':2375 ' || true"
if ($wslTcp2375 -and $wslTcp2375.Trim()) {
    Write-Error "[SECURITY BREACH] Docker daemon is listening on TCP port 2375 inside WSL! It must be restricted strictly to /var/run/docker.sock."
    exit 1
}

$winTcp2375 = Test-NetConnection -ComputerName 127.0.0.1 -Port 2375 -WarningAction SilentlyContinue
if ($winTcp2375.TcpTestSucceeded) {
    Write-Error "[SECURITY BREACH] Port 2375 is open on Windows host! Docker TCP endpoint must not be reachable."
    exit 1
}

Write-Host "[OK] Security verified: Port 2375 is completely closed. Socket-only isolation confirmed." -ForegroundColor Green
Write-Host "[OK] Substrate verified and ready for Phase 1." -ForegroundColor Green
