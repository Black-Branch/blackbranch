#!/usr/bin/env bash
# 005 — the community service account: its name, its two appservice tokens (random, never printed),
# and the community keeper's switch, off on an install made before it (its rooms stay as they are).
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_add COMMUNITY_LOCALPART blackbranch
envm_secret COMMUNITY_AS_TOKEN 32
envm_secret COMMUNITY_HS_TOKEN 32
envm_add COMMUNITY_RECONCILER false
