#!/usr/bin/env bash
# 004 — the Forums tab's reader: its sign-in, which `blackbranch up` makes (empty until then).
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
envm_add MATRIX_READER_TOKEN ""
