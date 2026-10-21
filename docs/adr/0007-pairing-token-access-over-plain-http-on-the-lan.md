# 0007. Pair devices with a short-lived token over plain HTTP on the LAN

- Status: Proposed
- Date: 2026-10-21
- Deciders: adricasi

## Context
The phone reaches the laptop over home Wi-Fi. Without access control anyone on the network could see home photos and place bets. Local HTTPS needs certificates on the phone or a tunnel. See REQ-001, NFR-001.

## Options considered
1. **No auth on the LAN.** Pros: simplest. Cons: exposes household data to every device on the Wi-Fi.
2. **Pairing token over plain HTTP, hardened.** Pros: one QR scan; blocks other devices; no certificates. Cons: a device already on the Wi-Fi could sniff the cookie.
3. **HTTPS only (Tailscale Serve or a local CA).** Pros: encrypted. Cons: extra setup for every user; a dependency for the default path.

## Decision
We will use option 2 and offer Tailscale Serve as the documented HTTPS option. At each start (or `sib pair`) the server generates a ≥ 128-bit CSPRNG token valid for 10 minutes, prints a QR/URL, and exchanges it for an HttpOnly, SameSite=Strict session cookie (any number of devices within the 10 minutes; existing sessions stay valid), then redirects to a token-free URL. Sessions expire after 30 days. Every route except `/pair` requires a session; state-changing requests must carry a matching Origin; a Host allowlist (active interfaces + `config.allowedHosts`) blocks DNS rebinding; failed attempts are rate-limited; "Forget devices" revokes all sessions and tokens. Token and sessions are stored only as SHA-256 hashes and never logged.

## Consequences
- Positive: other LAN devices get 401; no certificates to install.
- Negative / risks: cookie sniffing on plain HTTP by someone already on the Wi-Fi; documented in the README with the Tailscale Serve option.
- Follow-ups: `security-auditor` review of the auth module.
