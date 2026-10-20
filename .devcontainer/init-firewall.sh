#!/usr/bin/env bash
# Dev container egress firewall: default-deny outbound traffic, allow only the domains in
# .devcontainer/firewall-allowlist.txt plus GitHub's published IP ranges.
# Runs as root on every container start (postStartCommand). Disable: set
# DEVCONTAINER_FIREWALL=off in devcontainer.json "containerEnv", then rebuild.
# Approach inspired by Anthropic's reference Claude Code dev container.
set -euo pipefail
IFS=$'\n\t'

if [[ "${DEVCONTAINER_FIREWALL:-on}" == "off" ]]; then
  echo "firewall: disabled (DEVCONTAINER_FIREWALL=off)"; exit 0
fi
for cmd in iptables ipset dig curl jq ip; do
  command -v "$cmd" >/dev/null || { echo "firewall: missing $cmd (installed by post-create.sh); skipping"; exit 0; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST="$HERE/firewall-allowlist.txt"
SET=devcontainer-allowed

# Keep Docker's embedded DNS (127.0.0.11) working across the flush.
docker_dns="$(iptables-save -t nat | grep '127\.0\.0\.11' || true)"
iptables -F; iptables -X; iptables -t nat -F; iptables -t nat -X; iptables -t mangle -F; iptables -t mangle -X
ipset destroy "$SET" 2>/dev/null || true
if [[ -n "$docker_dns" ]]; then
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  while IFS= read -r rule; do [[ -n "$rule" ]] && eval "iptables -t nat $rule"; done <<<"$docker_dns"
fi

# Before the policy switches to DROP: DNS, loopback, established flows.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

ipset create "$SET" hash:net

echo "firewall: adding GitHub ranges"
meta="$(curl -fsS --max-time 20 https://api.github.com/meta)" || { echo "firewall: cannot reach api.github.com"; exit 1; }
while IFS= read -r cidr; do
  [[ "$cidr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] && ipset add -exist "$SET" "$cidr"
done < <(jq -r '(.web + .api + .git + .packages)[]?' <<<"$meta")

echo "firewall: resolving allowlist"
while IFS= read -r line; do
  domain="${line%%#*}"; domain="$(tr -d '[:space:]' <<<"$domain")"
  [[ -n "$domain" ]] || continue
  ips="$(dig +short A "$domain" | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true)"
  if [[ -z "$ips" ]]; then echo "firewall: warning: $domain did not resolve"; continue; fi
  while IFS= read -r ip; do ipset add -exist "$SET" "$ip"; done <<<"$ips"
done < "$ALLOWLIST"

# The Docker host network (VS Code server, port forwarding).
host_ip="$(ip route | awk '/default/ {print $3; exit}')"
if [[ -n "$host_ip" ]]; then
  host_net="$(sed -E 's/\.[0-9]+$/.0\/24/' <<<"$host_ip")"
  iptables -A INPUT  -s "$host_net" -j ACCEPT
  iptables -A OUTPUT -d "$host_net" -j ACCEPT
fi

iptables -A OUTPUT -m set --match-set "$SET" dst -j ACCEPT
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# IPv6: deny outbound entirely (the allowlist is IPv4).
if command -v ip6tables >/dev/null; then
  ip6tables -F || true
  ip6tables -A OUTPUT -o lo -j ACCEPT || true
  ip6tables -P OUTPUT DROP || true
fi

echo "firewall: verifying"
if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
  echo "firewall: ERROR — example.com is reachable, rules not effective"; exit 1
fi
curl -fsS --max-time 10 https://api.github.com/zen >/dev/null || { echo "firewall: ERROR — GitHub not reachable"; exit 1; }
echo "firewall: active ($(ipset list "$SET" | grep -c '^[0-9]') allowed networks/IPs)"
