#!/usr/bin/env bash
# One-time setup for a fresh Oracle Ampere A1 instance running Ubuntu 24.04.
# Run as the default `ubuntu` user:  ALLOW_SSH_FROM=<your-ip> bash oracle-bootstrap.sh
set -euo pipefail

NEW_USER="${NEW_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
ALLOW_SSH_FROM="${ALLOW_SSH_FROM:?Set ALLOW_SSH_FROM to your public IP, e.g. 203.0.113.4}"
SWAP_GB="${SWAP_GB:-2}"

sudo apt-get update
sudo apt-get install -y ufw unattended-upgrades fail2ban age curl ca-certificates

# --- non-root user, same authorised key as the default account -----------------
sudo adduser --disabled-password --gecos "" "$NEW_USER"
sudo usermod -aG sudo "$NEW_USER"
sudo install -d -m 700 -o "$NEW_USER" -g "$NEW_USER" "/home/$NEW_USER/.ssh"
sudo cp ~/.ssh/authorized_keys "/home/$NEW_USER/.ssh/authorized_keys"
sudo chown "$NEW_USER:$NEW_USER" "/home/$NEW_USER/.ssh/authorized_keys"
sudo chmod 600 "/home/$NEW_USER/.ssh/authorized_keys"

# --- SSH: keys only, no root login -------------------------------------------
sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
sudo sed -i "s/^#*Port.*/Port $SSH_PORT/" /etc/ssh/sshd_config
sudo sshd -t
sudo systemctl reload ssh

# --- firewall: SSH from one address, nothing else -----------------------------
# 80/443 stay closed: the app is on Cloudflare and this box serves no traffic.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from "$ALLOW_SSH_FROM" to any port "$SSH_PORT" proto tcp
sudo ufw --force enable

# --- swap (counts toward the 200 GB block-storage allowance) -----------------
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l "${SWAP_GB}G" /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024))
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

sudo systemctl enable --now unattended-upgrades fail2ban

echo "Done. Log in as $NEW_USER from $ALLOW_SSH_FROM on port $SSH_PORT."
echo "Next: install the backup scripts and the systemd timers from ops/README.md."
