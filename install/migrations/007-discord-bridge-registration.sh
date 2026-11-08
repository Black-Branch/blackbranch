#!/usr/bin/env bash
# 007 — the Discord bridge's registration: its two app service tokens (random, never printed, made
# once: a re-run keeps them), and the Discord application's client secret, empty (optional).
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_secret OOYE_AS_TOKEN 32
envm_secret OOYE_HS_TOKEN 32
envm_add DISCORD_CLIENT_SECRET ""
