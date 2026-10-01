#!/usr/bin/env bash
set -euo pipefail

echo "[*] Checking WSL2 systemd and Docker configuration..."

# 1. Ensure systemd is enabled in /etc/wsl.conf
if ! grep -q "systemd=true" /etc/wsl.conf 2>/dev/null; then
  echo "[+] Enabling systemd in /etc/wsl.conf"
  sudo bash -c 'echo -e "[boot]\nsystemd=true" >> /etc/wsl.conf'
fi

# 2. Ensure docker.io is installed
if ! command -v dockerd &>/dev/null; then
  echo "[+] Installing docker.io..."
  sudo apt-get update && sudo apt-get install -y docker.io
fi

# 3. Ensure iptables-legacy is selected (prevents WSL2 nftables hang)
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true

# 4. Ensure no TCP listeners exist (strict socket-only security policy)
if [ -f /etc/systemd/system/docker.service.d/override.conf ]; then
  echo "[+] Purging TCP override from docker.service..."
  sudo rm -f /etc/systemd/system/docker.service.d/override.conf
  sudo systemctl daemon-reload
fi

# 5. Ensure current user is in docker group
sudo usermod -aG docker "$USER" 2>/dev/null || true

# 6. Enable and start docker service via systemd
sudo systemctl enable docker
sudo systemctl start docker

# 7. Verify socket
if [ -S /var/run/docker.sock ]; then
  echo "[✓] Docker daemon is running and healthy on /var/run/docker.sock"
  docker version --format 'Engine Version: {{.Server.Version}}'
else
  echo "[!] Failed to locate /var/run/docker.sock"
  exit 1
fi
