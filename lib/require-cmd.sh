# Sourced, not run. Presence checks for the external commands a script needs.

# have_cmd <cmd> -> 0 when <cmd> is on PATH.
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# require_cmd <cmd> [exit code, default 1] -> returns when <cmd> is on PATH; otherwise names the
# missing command and the calling script on stderr and exits.
require_cmd() {
  have_cmd "$1" && return 0
  echo "${0##*/}: '$1' not found on PATH; install it (bin/doctor lists every requirement)" >&2
  exit "${2:-1}"
}
