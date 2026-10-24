#!/usr/bin/env bash
# One-time hardening and Docker setup for the hosted app's Droplet (NFR-013). Run it as root on
# a fresh Ubuntu 24.04 Droplet, after copying this folder to /opt/sib:
#
#   ssh root@<droplet-ip> 'bash /opt/sib/setup-droplet.sh'
#
# Safe to run again: every step checks the current state first. It does not touch the app's data,
# /etc/sib/sib.env or running containers. It never opens a port other than 22 (rate limited),
# 80 and 443. ufw is a second layer: the DigitalOcean Cloud Firewall is the first. Published
# Docker ports bypass ufw (Docker writes its own iptables rules), which is why the app publishes
# none and only Caddy publishes 80 and 443.
set -euo pipefail
umask 022

readonly APP_UID=10001
readonly SWAP_FILE=/swapfile
readonly SWAP_SIZE=1G
# Docker's repository signing key (Docker's install guide lists this fingerprint; the builder
# compares it with https://docs.docker.com/engine/install/ubuntu/ before the first run).
readonly DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

log() {
  printf '\n== %s\n' "$*"
}

die() {
  printf 'setup-droplet: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ -f /etc/os-release ]] || die "no /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || die "expects Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
[[ -s /root/.ssh/authorized_keys ]] || die "/root/.ssh/authorized_keys is empty: refusing to disable SSH passwords"
[[ -f /opt/sib/compose.yaml && -f /opt/sib/backup.sh ]] || die "copy deploy/digitalocean/* to /opt/sib first"

export DEBIAN_FRONTEND=noninteractive

log "Upgrading packages"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg ufw unattended-upgrades sqlite3

log "Automatic security updates (reboot at 04:30 UTC when a kernel needs it; containers restart)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52sib-unattended-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// Docker's repository too, so runc and containerd fixes arrive by themselves [verify the origin
// and label with `apt-cache policy docker-ce` after the install].
Unattended-Upgrade::Origins-Pattern {
  "origin=Docker,label=Docker CE";
};
CONF
systemctl enable --now unattended-upgrades

log "Swap file ($SWAP_SIZE)"
if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  if [[ ! -f "$SWAP_FILE" ]]; then
    fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
    chmod 0600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" > /dev/null
  fi
  swapon "$SWAP_FILE"
fi
grep -qE "^${SWAP_FILE}[[:space:]]" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-sib.conf
sysctl -q -p /etc/sysctl.d/99-sib.conf

log "Docker Engine from Docker's apt repository"
if ! command -v docker > /dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  key_tmp="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
  # Exactly one primary key, with the expected fingerprint: an extra key appended to the file
  # would otherwise be trusted by apt too.
  pubs="$(gpg --show-keys --with-colons "$key_tmp" | awk -F: '$1 == "pub"' | wc -l)"
  found="$(gpg --show-keys --with-colons "$key_tmp" | awk -F: '$1 == "fpr" { print $10; exit }')"
  [[ "$pubs" -eq 1 ]] || { rm -f "$key_tmp"; die "Docker key file holds $pubs keys, expected 1"; }
  [[ "$found" == "$DOCKER_KEY_FINGERPRINT" ]] || { rm -f "$key_tmp"; die "Docker key fingerprint is $found, expected $DOCKER_KEY_FINGERPRINT"; }
  install -m 0644 "$key_tmp" /etc/apt/keyrings/docker.asc
  rm -f "$key_tmp"
  cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker

log "Folders (owner-only)"
install -d -m 0700 -o root -g root /srv/sib /srv/sib/backups /etc/sib
install -d -m 0700 -o "$APP_UID" -g "$APP_UID" /srv/sib/data
install -d -m 0750 -o root -g root /opt/sib
chmod 0755 /opt/sib/backup.sh /opt/sib/setup-droplet.sh

log "Backup timer"
install -m 0644 /opt/sib/sib-backup.service /etc/systemd/system/sib-backup.service
install -m 0644 /opt/sib/sib-backup.timer /etc/systemd/system/sib-backup.timer
install -m 0644 /opt/sib/sib-backup-failed.service /etc/systemd/system/sib-backup-failed.service
systemctl daemon-reload
systemctl enable --now sib-backup.timer

log "Firewall (ufw): SSH rate limited, 80, 443"
ssh_port="$(sshd -T | awk '$1 == "port" { print $2; exit }')"
[[ "$ssh_port" =~ ^[0-9]+$ ]] || die "cannot read the SSH port"
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw limit "${ssh_port}/tcp" > /dev/null
ufw allow 80/tcp > /dev/null
ufw allow 443/tcp > /dev/null
ufw allow 443/udp > /dev/null
ufw --force enable > /dev/null

log "SSH: keys only"
cat > /etc/ssh/sshd_config.d/00-sib-hardening.conf <<'CONF'
# Read first: sshd uses the first value it sees, so this wins over cloud-init's drop-in.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
CONF
sshd -t
systemctl reload ssh
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '

log "Checks"
docker --version
docker compose version
swapon --show
ufw status verbose | head -n 12
systemctl list-timers sib-backup.timer --no-pager
if systemctl is-active --quiet do-agent; then
  echo "DigitalOcean metrics agent: active"
else
  echo "WARNING: do-agent is not active; the CPU, memory and disk alerts need it (guide, troubleshooting)."
fi

cat <<'NEXT'

Done. Next (docs/deploy-digitalocean.md): put the image on the Droplet, create
/etc/sib/sib.env (0600) and /opt/sib/.env, then `cd /opt/sib && docker compose up -d`.
Open a second SSH session and check that you can still log in with your key before you close this one.
NEXT
