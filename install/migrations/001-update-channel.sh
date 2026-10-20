#!/usr/bin/env bash
# 001 — the update channel. An install made before it has no feed, channel or
# release tag in .env; these are the defaults a new install writes. (BB_RELEASE_KEY is install.sh's:
# a box trusts the key it was installed with, which a migration cannot choose for it.)
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_add BB_UPDATE_FEED https://blackbranch.app/releases
envm_add BB_UPDATE_CHANNEL stable
envm_add BB_RELEASE local
envm_add SETUP_TOKEN_HASH ""
