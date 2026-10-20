#!/usr/bin/env bash
# 002 — caddy's fixed address on the bundle network (BB_CADDY_IP): stream-api believes the viewer's
# address caddy sends from it alone (WS_TRUSTED_PROXIES). A box from before gets the address beside
# cloudflared's in ITS subnet — .249 next to BB_CLOUDFLARED_IP's .250 — so a box that moved its subnet
# keeps one that fits.
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cf=$(envm_get BB_CLOUDFLARED_IP); cf="${cf//\"/}"
if [[ "$cf" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}$ ]]; then envm_add BB_CADDY_IP "${BASH_REMATCH[1]}.249"
else envm_add BB_CADDY_IP 172.29.83.249; fi
