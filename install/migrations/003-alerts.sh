#!/usr/bin/env bash
# 003 — the box's alert channel: an ntfy topic address and/or a command that sends an email. Both
# start empty (alerts are then logged only); the operator fills in one or both.
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_add BB_ALERT_NTFY_URL ""
envm_add BB_ALERT_EMAIL_COMMAND ""
