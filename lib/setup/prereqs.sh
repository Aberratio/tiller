#!/usr/bin/env bash
# The harness's prerequisites on this machine: which OS this is, what is missing, how to install it.
#
#   prereqs.sh os               macos | linux | windows | unknown   (windows means Git Bash / MSYS)
#   prereqs.sh check            one line per requirement: ok|missing|warn <name> <detail>
#                               exit 0 when every required tool is present, 2 otherwise
#   prereqs.sh plan             the commands that would install what is missing, one per line, in order
#                               exit 3 when something has no automatic path (named on stderr as `manual:`)
#   prereqs.sh install [--yes]  run the plan, then check again; asks first on a terminal, --yes or
#                               TILLER_YES=1 skips the question, no terminal and no --yes is exit 4
#
# Required: node (>= the floor below), git, bash, jq. Optional: gh (PR phases), claude (lanes), a
# keep-awake tool (caffeinate or systemd-inhibit; never installed, only reported). bin/doctor is the
# richer check once Node is there; this script is the one that works before it is.
set -euo pipefail

NODE_FLOOR="20.11"   # the same floor lib/doctor/doctor.mjs applies

have() { command -v "$1" >/dev/null 2>&1; }

os() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) echo macos ;;
    Linux) echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

# version_at_least <have> <floor>: dotted numeric compare, missing parts count as 0.
version_at_least() {
  local -a a b
  local i x y
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    (( x > y )) && return 0
    (( x < y )) && return 1
  done
  return 0
}

node_version() { node --version 2>/dev/null | head -1 || true; }
node_ok() { have node && version_at_least "$(node_version | tr -d v)" "$NODE_FLOOR"; }

line() { printf '%-8s %-11s %s\n' "$1" "$2" "$3"; }

# check: the report. Sets the exit code from the required rows only.
check() {
  local rc=0
  if node_ok; then line ok node "$(node_version)"
  elif have node; then line missing node "$(node_version) is older than the floor $NODE_FLOOR"; rc=2
  else line missing node "not found; the floor is $NODE_FLOOR"; rc=2
  fi
  for t in git bash jq; do
    if have "$t"; then line ok "$t" "$(command -v "$t")"; else line missing "$t" "not found"; rc=2; fi
  done
  if have gh; then line ok gh "$(command -v gh)"; else line warn gh "not found; needed only for PR phases (open, CI, review, merge)"; fi
  if have claude; then line ok claude "$(command -v claude)"; else line warn claude "not found; lanes cannot run, dry-run only"; fi
  if have caffeinate; then line ok keep-awake caffeinate
  elif have systemd-inhibit; then line ok keep-awake systemd-inhibit
  else line warn keep-awake "neither caffeinate nor systemd-inhibit; an unattended run may stall when the machine sleeps"
  fi
  if [ "$(os)" = windows ]; then
    if symlinks_work; then line ok symlinks "native symlinks allowed"
    else line warn symlinks "ln -s cannot create native links; enable Developer Mode (Settings > System > For developers) or install.sh falls back to junctions"
    fi
  fi
  return "$rc"
}

# On Git Bash `ln -s` copies unless native links are both requested and allowed by Windows.
symlinks_work() {
  local d
  d="$(mktemp -d 2>/dev/null)" || return 1
  touch "$d/target"
  ( MSYS=winsymlinks:nativestrict ln -s "$d/target" "$d/link" ) >/dev/null 2>&1 && [ -L "$d/link" ]
  local ok=$?
  rm -rf "$d"
  return "$ok"
}

# missing: the tools to install, required and optional, in a fixed order. bash is never listed:
# this script runs inside it.
missing() {
  node_ok || echo node
  for t in git jq gh claude; do have "$t" || echo "$t"; done
}

manager() {
  case "$(os)" in
    macos) have brew && echo brew || echo none ;;
    linux)
      for m in apt-get dnf apk pacman; do have "$m" && { echo "$m"; return; }; done
      echo none ;;
    windows) have winget && echo winget || echo none ;;
    *) echo none ;;
  esac
}

# The privilege prefix a Linux package manager needs for this user.
sudo_prefix() {
  [ "$(os)" = linux ] || return 0
  [ "$(id -u 2>/dev/null || echo 0)" = 0 ] && return 0
  have sudo && printf 'sudo '
  return 0
}

manual_hint() {
  case "$(os)/$1" in
    macos/*) echo "install Homebrew first (https://brew.sh), then rerun; or install $1 by hand" ;;
    windows/*) echo "install winget (App Installer, Microsoft Store), then rerun; or download $1 by hand" ;;
    */node) echo "Node >= $NODE_FLOOR from https://nodejs.org" ;;
    */git) echo "https://git-scm.com" ;;
    */jq) echo "https://jqlang.github.io/jq" ;;
    */gh) echo "https://cli.github.com" ;;
    */claude) echo "https://code.claude.com/docs/en/setup" ;;
    *) echo "install $1 by hand" ;;
  esac
}

# plan: runnable commands on stdout, `manual:` lines on stderr. Exit 3 when anything is manual.
plan() {
  local mgr pre rc=0 want=() pkgs=() t claude_line=""
  mgr="$(manager)"
  pre="$(sudo_prefix)"
  while IFS= read -r t; do [ -n "$t" ] && want+=("$t"); done < <(missing)
  [ "${#want[@]}" -eq 0 ] && return 0

  for t in "${want[@]}"; do
    case "$mgr/$t" in
      */claude)
        # Claude Code has its own installer on every OS, so it never depends on a package manager.
        case "$(os)" in
          macos|linux) claude_line='curl -fsSL https://claude.ai/install.sh | bash' ;;
          windows) claude_line='powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"' ;;
          *) echo "manual: $t $(manual_hint "$t")" >&2; rc=3 ;;
        esac ;;
      none/*) echo "manual: $t $(manual_hint "$t")" >&2; rc=3 ;;
      brew/*) pkgs+=("$t") ;;
      apt-get/node)
        # Debian and Ubuntu ship a Node below the floor; NodeSource carries a current one.
        echo "curl -fsSL https://deb.nodesource.com/setup_22.x | ${pre:+${pre}-E }bash -"
        pkgs+=(nodejs) ;;
      apt-get/*) pkgs+=("$t") ;;
      dnf/node) pkgs+=(nodejs) ;;
      dnf/*) pkgs+=("$t") ;;
      apk/node|pacman/node) pkgs+=(nodejs npm) ;;
      apk/gh|pacman/gh) pkgs+=(github-cli) ;;
      apk/*|pacman/*) pkgs+=("$t") ;;
      winget/node) winget_line OpenJS.NodeJS.LTS ;;
      winget/git) winget_line Git.Git ;;
      winget/jq) winget_line jqlang.jq ;;
      winget/gh) winget_line GitHub.cli ;;
    esac
  done

  if [ "${#pkgs[@]}" -gt 0 ]; then
    case "$mgr" in
      brew) echo "brew install ${pkgs[*]}" ;;
      apt-get) echo "${pre}apt-get install -y ${pkgs[*]}" ;;
      dnf) echo "${pre}dnf install -y ${pkgs[*]}" ;;
      apk) echo "${pre}apk add ${pkgs[*]}" ;;
      pacman) echo "${pre}pacman -S --noconfirm --needed ${pkgs[*]}" ;;
    esac
  fi
  [ -n "$claude_line" ] && echo "$claude_line"
  return "$rc"
}

winget_line() { echo "winget install --id $1 -e --source winget --accept-package-agreements --accept-source-agreements"; }

# install: print the plan, confirm, run each line through bash, then check again.
install_plan() {
  local yes="${TILLER_YES:-0}" commands rc=0 cmd
  [ "${1:-}" = "--yes" ] && yes=1
  commands="$(plan)" || rc=$?
  if [ -z "$commands" ]; then
    [ "$rc" -eq 3 ] && { echo "prereqs: nothing can be installed automatically here; see the manual lines above" >&2; return 3; }
    check
    return
  fi
  echo "prereqs: would run, in order:" >&2
  printf '  %s\n' "$commands" | sed 's/^  \(.*\)$/  \1/' >&2
  if [ "$yes" != 1 ]; then
    if [ -t 0 ]; then
      read -r -p "Run these now? [y/N] " answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "prereqs: nothing run" >&2; return 4 ;; esac
    else
      echo "prereqs: not a terminal; rerun with --yes (or TILLER_YES=1) to run the plan above" >&2
      return 4
    fi
  fi
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    echo "prereqs: $cmd" >&2
    bash -c "$cmd" || { echo "prereqs: failed: $cmd" >&2; return 1; }
  done <<< "$commands"
  check
}

case "${1:-}" in
  os) os ;;
  check) check ;;
  plan) plan ;;
  install) shift; install_plan "$@" ;;
  *) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
