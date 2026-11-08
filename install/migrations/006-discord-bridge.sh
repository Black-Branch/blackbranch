#!/usr/bin/env bash
# 006 — the Discord bridge's bot token: empty, so the bridge stays off until it is set.
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_add DISCORD_BOT_TOKEN ""
