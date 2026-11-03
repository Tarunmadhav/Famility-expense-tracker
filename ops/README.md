# Oracle Cloud runbook (backup + uptime only)

The app itself runs on Cloudflare Workers with D1 and R2. The VM never serves
traffic: it exports the database nightly and checks that the public URL answers.

## 1. Create the instance (console)

1. Compute → Instances → Create. Image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**
   (Always Free: 4 OCPU / 24 GB total per tenancy), 2 OCPU / 12 GB is plenty.
2. Networking: create/choose a VCN, public subnet, **assign a public IPv4**.
3. Add your SSH public key. Do not enable a password.
4. Boot volume 50 GB (Always Free includes 200 GB total block storage).
5. Security list / NSG: **ingress TCP 22 from your IP only**. Leave 80/443 closed.

Always Free limits to watch: 4 OCPU + 24 GB Ampere total, 200 GB block storage
(boot volumes + swap count), 10 TB egress/month, 2 AMD micro instances.

## 2. Harden it

```bash
scp ops/oracle-bootstrap.sh ubuntu@<IP>:~
ssh ubuntu@<IP> "ALLOW_SSH_FROM=<your.public.ip> bash oracle-bootstrap.sh"
ssh deploy@<IP>            # new non-root user, key auth only
```

The script disables root and password SSH, sets ufw to allow only your IP on the
SSH port, adds 2 GB swap, and enables unattended-upgrades + fail2ban.

## 3. Encrypted D1 export

On your own machine, once:

```bash
age-keygen -o age-key.txt          # keep the private key offline
grep 'public key' age-key.txt      # paste into AGE_RECIPIENT
```

Create a Cloudflare API token with **D1:Read** for the account, then on the VM:

```bash
sudo install -d -m 700 /etc/family-planner
sudo install -m 755 ops/backup-d1.sh /usr/local/bin/backup-d1.sh
sudo install -m 755 ops/uptime-probe.sh /usr/local/bin/uptime-probe.sh

sudo tee /etc/family-planner/backup.env >/dev/null <<'EOF'
CLOUDFLARE_API_TOKEN=replace
CLOUDFLARE_ACCOUNT_ID=replace
AGE_RECIPIENT=age1replace
DB_NAME=family-planner
EOF
sudo chmod 600 /etc/family-planner/backup.env
sudo -u deploy /usr/local/bin/backup-d1.sh    # first manual run
```

Cron (root crontab, `sudo crontab -e`):

```cron
17 2 * * * /usr/local/bin/backup-d1.sh >> /var/log/d1-backup.log 2>&1
```

Restore test: `age -d -i age-key.txt 20260101T021700Z.sql.age | sqlite3 /tmp/restore.db`
then `sqlite3 /tmp/restore.db 'select count(*) from records;'`.

## 4. Uptime probe (systemd timer)

```ini
# /etc/systemd/system/uptime-probe.service
[Unit]
Description=Uptime probe
[Service]
Type=oneshot
User=deploy
Environment=URL=https://site-0f6d51dc534d4dd4af419f3a4cf5f0ad.freebuff.page/api/health
ExecStart=/usr/local/bin/uptime-probe.sh

# /etc/systemd/system/uptime-probe.timer
[Unit]
Description=Probe every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

`sudo systemctl enable --now uptime-probe.timer`.
Log lines are `timestamp status`, e.g. `2026-11-03T16:40:00Z 200`.

## 5. What this VM does not do

- No Node app, no Postgres, no reverse proxy, no open 80/443.
- The age private key must not be stored on the VM; keep it offline.
- Backups are useless until you have restored one.
