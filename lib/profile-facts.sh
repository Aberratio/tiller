#!/usr/bin/env bash
# Render the decisional facts of a project profile as a JSON object.
#
#   profile-facts.sh [--profile <file>] [dir]           -> the facts object on stdout, or exit 4
#   profile-facts.sh --check [--profile <file>] [dir]   -> a per-key report; exit 4 if a launch would be refused
#
# `--profile` skips resolution and reads that file directly.
#
# The Workflow script that consumes this has no fs, no require and no shell: facts its own
# predicates branch on have to arrive as values. Sections that exist to be read rather than
# computed stay in the profile and travel as `profilePath`.
#
# Contract (which sections are decisional, under which key, in what shape): docs/profile-schema.md,
# "The facts object". A key required there and unresolved here is a launch refusal, never a default.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KINDS="$REPO_DIR/lib/contract/kinds.json"
ROUTING="$REPO_DIR/config/routing.json"

# Profile schema versions this renderer reads. Anything else is refused, never guessed at.
SCHEMA_MIN=2
SCHEMA_MAX=2

# What an owner proxy may be given. Closed: a mandate outside this list is a malformed profile.
MANDATES='approve-day-queue start-next-ticket approve-peer-step resume-run lift-cap-once undraft-pr'

mode=render
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check; shift ;;
    --profile) profile="$2"; shift 2 ;;
    *) break ;;
  esac
done
target="${1:-$PWD}"

if [ -z "$profile" ]; then
  profile="$("$REPO_DIR/lib/resolve-profile.sh" "$target")" || exit $?
fi
[ -f "$profile" ] || { echo "profile-facts: no such profile $profile" >&2; exit 4; }
profile="$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")"

section() { awk -v want="## $1" '$0==want{f=1;next} /^## /{f=0} f' "$profile"; }
has_section() { grep -qx "## $1" "$profile"; }
headings() { grep '^## ' "$profile" | sed 's/^## //' | tr '\n' ',' | sed 's/,$//;s/,/, /g'; }
# A section whose content is `none`, optionally followed by a dash and a reason on the same
# line, is an explicit decision, not an empty one.
is_none() {
  local body
  body="$(section "$1" | awk 'NF' | tr -d '`*' | tr '[:upper:]' '[:lower:]' | sed 's/^ *//;s/ *$//')"
  [ "$(printf '%s\n' "$body" | wc -l | tr -d ' ')" = 1 ] && printf '%s' "$body" | grep -Eq '^none\.?( +(—|–|-) .*)?$'
}

# Table rows of a section: data rows only, header and separator dropped, cells trimmed, TSV out.
# keep=1 keeps backticks, which is how a path cell marks its globs.
rows() {
  section "$1" | awk -F'|' -v keep="${2:-0}" '
    /^\|/ {
      if ($0 ~ /^\|[ -]*-[ -|]*\|$/) next
      if (++n == 1) next
      out = ""
      for (i = 2; i < NF; i++) {
        c = $i; gsub(/^[ \t]+|[ \t]+$/, "", c); if (!keep) gsub(/`/, "", c)
        out = out (i > 2 ? "\t" : "") c
      }
      if (out ~ /[^ \t]/) print out
    }'
}

# One `- Label: value` line from a section, value only.
field() { section "$1" | sed -n "s/^- *${2}[^:]*: *//p" | head -1 | sed 's/[`*]//g;s/ *$//'; }
# Backticked tokens on the lines of a section that mention a label.
ticked() { section "$1" | grep -i "$2" | grep -o '`[^`]*`' | tr -d '`'; }
ticked_field() { section "$1" | grep -i "^- *$2" | head -1 | grep -o '`[^`]*`' | tr -d '`'; }
# The first backticked token of a field when it has one (the rest of the line is commentary).
token_field() { local t; t="$(ticked_field "$1" "$2" | head -1)"; [ -n "$t" ] && echo "$t" || field "$1" "$2"; }
to_json_list() { jq -R . | jq -s 'map(select(length > 0))'; }

labels=()
missing=()
note() { printf '%s\n' "$1" >&2; }
# Every check is registered in order so --check prints them all, passing or not.
# A `TODO` in a required field is an unfilled profile, not a fact.
require() {
  labels+=("$1")
  # A template slot is `<two or more words>`. Held in a variable so the brackets reach the regex
  # engine as themselves, whatever the bash build.
  local slot='<[^<>]*[[:space:]][^<>]*>'
  case "$2" in
    "") missing+=("$1") ;;
    *TODO*) missing+=("$1 (reads TODO)") ;;
    !*) missing+=("$1 (${2#!})") ;;
    # `<TICKET>` in a path is a value, and so is prose like `run if a < b and c > d`.
    *) if [[ "$2" =~ $slot ]]; then missing+=("$1 (reads a template placeholder)"); fi ;;
  esac
}

# ---- schema version -------------------------------------------------------------------------
schema_version="$(awk -F': *' '/^schema_version:/{print $2; exit}' "$profile" | tr -d '"[:space:]')"
[ -z "$schema_version" ] && schema_version=1
case "$schema_version" in
  *[!0-9]*) sv_ok="!unreadable schema_version '$schema_version'" ;;
  *) if [ "$schema_version" -lt "$SCHEMA_MIN" ]; then
       sv_ok="!version $schema_version is older than this renderer reads ($SCHEMA_MIN-$SCHEMA_MAX)"
     elif [ "$schema_version" -gt "$SCHEMA_MAX" ]; then
       sv_ok="!version $schema_version is newer than this renderer reads ($SCHEMA_MIN-$SCHEMA_MAX)"
     else sv_ok=x; fi ;;
esac
require 'schema version' "$sv_ok"
[ "$sv_ok" = x ] || schema_version=0

# ---- identity -------------------------------------------------------------------------------
name="$(awk -F': *' '/^profile:/{print $2; exit}' "$profile")"
jira="$(ticked identity 'Jira project key' | grep -vix none | to_json_list)"

# ---- tracker --------------------------------------------------------------------------------
tracker_kind="$(token_field tracker 'Kind' | awk '{print tolower($1)}' | tr -d '.,')"
tracker_site="$(token_field tracker 'Site')"
tracker_start="$(token_field tracker 'Start status')"
tracker_merged="$(token_field tracker 'Merged status')"
case "$tracker_kind" in
  jira)
    require 'tracker — kind' x
    require 'tracker — site' "$tracker_site"
    require 'tracker — start status' "$tracker_start"
    require 'identity — Jira project key' "$( [ "$jira" = '[]' ] || echo x )" ;;
  none) require 'tracker — kind' x ;;
  "") require 'tracker — kind' "" ;;
  *) require 'tracker — kind' "!unknown kind '$tracker_kind'; jira or none" ;;
esac
tracker="$(jq -n --arg kind "$tracker_kind" --arg site "$tracker_site" --arg start "$tracker_start" \
  --arg merged "$tracker_merged" --argjson keys "$jira" '
  if $kind == "none" then {kind: "none", spec: true}
  else {kind: $kind, site: $site, keys: $keys, startStatus: $start,
        mergedStatus: (if $merged == "" then null else $merged end)} end')"

# ---- tools ----------------------------------------------------------------------------------
# Optional `Role | Kind | Server` rows over config/tool-kinds.json; a role left out keeps its default
# kind and server. The tracker's kind is `## tracker` Kind, so a tracker row only picks its server.
tool_rows="$(rows tools | jq -R -s 'split("\n") | map(select(length > 0) | split("\t")
  | {role: (.[0] // ""), kind: ((.[1] // "") | ascii_downcase), server: (.[2] // "")}
  | .kind |= (if . == "default" or . == "-" then "" else . end)
  | .server |= (if . == "default" or . == "-" then "" else . end))')"
if ! has_section tools; then tools_err=x
elif is_none tools; then tools_err="!none is not a binding; leave the section out for the defaults"
else tools_err="$(jq -r --slurpfile k "$REPO_DIR/config/tool-kinds.json" --slurpfile s "$REPO_DIR/config/mcp-servers.json" --arg tk "$tracker_kind" '
  ($k[0].roles) as $roles | ([$s[0][] | keys[]] | unique) as $servers
  | if length == 0 then "!no rows"
    elif any(.[]; (.role + .kind + .server) | test("TODO")) then "TODO"
    elif any(.[]; $roles[.role] == null) then "!unknown role " + ([.[] | select($roles[.role] == null) | .role] | join(", ")) + "; roles: " + ($roles | keys | join(", "))
    elif (map(.role) | unique | length) != length then "!roles repeat"
    elif any(.[]; .role == "tracker" and .kind != "" and .kind != $tk) then "!the tracker kind is set in ## tracker"
    elif any(.[]; .kind != "" and .kind != "none" and $roles[.role].kinds[.kind] == null) then
      "!unknown kind " + ([.[] | select(.kind != "" and .kind != "none" and $roles[.role].kinds[.kind] == null) | .role + " " + .kind] | join(", "))
    elif any(.[]; .server != "" and (.server as $sv | $servers | any(. == $sv) | not)) then
      "!server not in config/mcp-servers.json: " + ([.[] | select(.server != "" and (.server as $sv | $servers | any(. == $sv) | not)) | .role + " " + .server] | join(", "))
    else "x" end' <<<"$tool_rows")"; fi
require 'tools — role bindings' "$tools_err"
tools="$(jq --arg tk "$tracker_kind" '
  (map({key: .role, value: ({} + (if .kind != "" then {kind: .kind} else {} end)
                                 + (if .server != "" then {server: .server} else {} end))}) | from_entries)
  | if $tk == "jira" or $tk == "none" then .tracker = ((.tracker // {}) + {kind: $tk}) else . end' <<<"$tool_rows")"

# ---- ticket conventions ---------------------------------------------------------------------
# Optional and read as prose by flow-write-ticket, so nothing is rendered. A declared section is a
# copy of a written canon, and a skill that files tickets from a TODO copy files them wrong.
if has_section 'ticket conventions' && ! is_none 'ticket conventions'; then
  if section 'ticket conventions' | grep -q TODO; then tcv_err=TODO
  elif section 'ticket conventions' | grep -Eq '^- *Source:.*[^ ]'; then tcv_err=x
  else tcv_err="!names no Source: line pointing at the canon it was copied from"; fi
  require 'ticket conventions — source' "$tcv_err"
fi

# ---- repos ----------------------------------------------------------------------------------
repos="$(rows repos | jq -R -s '
  split("\n") | map(select(length > 0) | split("\t"))
  | map(select(.[0] != null and .[0] != "")
        | {repo: .[0], path: (.[1] // "" | sub("^~"; env.HOME)), role: .[2], main: .[3], mergingMeans: .[4]})')"
require 'repos — table' "$( [ "$repos" = '[]' ] || echo x )"
require 'repos — primary repo main branch' "$(jq -r '.[0].main // ""' <<<"$repos")"

# ---- branching ------------------------------------------------------------------------------
branch_convention="$(field branching 'Convention')"
worktree="$(section branching | awk '/^- .*[Ww]orktree/{sub(/^- [^:]*: */, ""); gsub(/[`*]/, ""); print; exit}')"
# The whole line is kept first, so that "Rebase policy: TODO." is caught as unfilled rather than
# answering "rebase" on the strength of the label.
integrate_line="$(section branching | awk '/[Rr]ebase|[Ii]ntegrating main/{print; exit}')"
case "$integrate_line" in
  *TODO*) integrate="$integrate_line" ;;
  *) integrate="$(printf '%s' "$integrate_line" | grep -io 'rebase\|merge commit' | head -1)"
     [ "$integrate" = "merge commit" ] && integrate=merge ;;
esac
require 'branching — Convention'          "$branch_convention"
require 'branching — worktree procedure'  "$worktree"
require 'branching — integrating main'    "$integrate"

# ---- decision ledger ------------------------------------------------------------------------
ledger="$(section 'decision ledger' | grep -o '`[^`]*`' | head -1 | tr -d '`')"
require 'decision ledger — path' "$ledger"

# ---- merge authority ------------------------------------------------------------------------
# `who` is three-valued; `whoRaw` keeps the cell. Globs are the backticked tokens of the path
# cell that look like paths; `agent, after <x>` makes <x> a precondition the gate must see met.
merge_authority="$(rows 'merge authority' 1 | jq -R -s '
  def who: ascii_downcase
    | if test("unconfirmed") then "unconfirmed" elif test("^agent\\b") then "agent" else "human" end;
  def tokens: [scan("`([^`]*)`") | .[0]];
  split("\n") | map(select(length > 0) | split("\t"))
  | map(select(.[0] != null and .[0] != "")
        | (.[1] // "" | gsub("`"; "")) as $raw
        | (.[0] | tokens | map(select(test("[/*]")) | sub("^\\./"; ""))) as $globs
        | {paths: (.[0] | gsub("`"; "") | split(",") | map(gsub("^\\s+|\\s+$"; ""))),
           globs: (if ($globs | length) == 0 and (.[0] | ascii_downcase | test("^everything"))
                   then ["**"] else $globs end),
           who: ($raw | if . == "" then "unconfirmed" else who end),
           whoRaw: $raw,
           precondition: ($raw | capture("^agent\\s*,\\s*(?<p>after\\b.*)$"; "i").p // null)})')"
ma_err="$(jq -r '
  if length == 0 then "!no rows"
  elif any(.[]; (.globs | length) == 0) then "!a row names no path glob: " + ([.[] | select((.globs | length) == 0) | .paths | join(", ")] | join("; "))
  elif any(.[]; any(.globs[]; startswith("..."))) then "!an abbreviated glob (\"...\") cannot be matched; write the full path"
  elif any(.[]; (.whoRaw | test("TODO"))) then "TODO"
  else "x" end' <<<"$merge_authority")"
require 'merge authority — table' "$ma_err"

# ---- gates ----------------------------------------------------------------------------------
# A declared list: name, source (`check: <name>` / `command: <cmd>` / `bot: <login>`), pass predicate.
gates="$(rows gates | jq -R -s '
  split("\n") | map(select(length > 0) | split("\t"))
  | map(select(.[0] != null and .[0] != "")
        | (.[1] // "") as $src
        | {name: .[0],
           source: ($src | capture("^(?<type>check|command|bot):\\s*(?<ref>.+)$") // null),
           pass: (.[2] // ""), raw: ($src + " " + (.[2] // ""))})')"
if ! has_section gates; then gates_err=""
elif is_none gates; then gates_err="!none declared; a project declares at least one gate"
else gates_err="$(jq -r '
  if length == 0 then "!no rows"
  elif any(.[]; (.name + .raw) | test("TODO")) then "TODO"
  elif any(.[]; .source == null) then "!a source is not check:, command: or bot:"
  elif any(.[]; .pass == "") then "!a gate has no pass predicate"
  elif (map(.name) | unique | length) != length then "!gate names repeat"
  else "x" end' <<<"$gates")"; fi
require 'gates — declared list' "$gates_err"
gates="$(jq 'map(del(.raw))' <<<"$gates")"

# ---- test toolchain, static checks -----------------------------------------------------------
# verify-claim runs the Command cell under sh -c, so each one is a single code span or `n/a`.
command_cells_err() {
  section "$1" | awk -F'|' '
    /^\|/ {
      if ($0 ~ /^\|[ :-]*-[ :|-]*\|$/) next
      if (++n == 1) { for (i = 2; i < NF; i++) { h = $i; gsub(/^[ \t]+|[ \t]+$/, "", h); if (tolower(h) == "command") col = i }; next }
      row = $0; gsub(/[| \t]/, "", row); if (row == "") next
      if (!col) { print "!the table has no Command column"; exit }
      c = $col; gsub(/^[ \t]+|[ \t]+$/, "", c)
      if (c ~ /TODO/) { print "TODO"; exit }
      if (c != "n/a" && c !~ /^`[^`]+`$/) { print "!not a runnable command (one code span or n/a): " c; exit }
    }'
}
if has_section 'test toolchain' && ! is_none 'test toolchain'; then
  tc_err="$(command_cells_err 'test toolchain')"
  # A section that is neither `none` nor a table says in prose why it is empty. A TODO there is a
  # fact nobody measured - `none` would be a claim, and this is the absence of one.
  if [[ -z "$tc_err" ]] && grep -q 'TODO' <<<"$(section 'test toolchain')"; then tc_err='TODO'; fi
  require 'test toolchain — commands' "${tc_err:-x}"
fi

# Rows of a `Check | Command` (column order not fixed) table: `check<TAB>command` per runnable
# row, `n/a`/blank Command cells left out. A leading `!<msg>` line is a structural error instead.
check_command_rows() {
  section "$1" | awk -F'|' '
    /^\|/ {
      if ($0 ~ /^\|[ :-]*-[ :|-]*\|$/) next
      if (++n == 1) { for (i = 2; i < NF; i++) { h = $i; gsub(/^[ \t]+|[ \t]+$/, "", h); h = tolower(h); if (h == "command") cc = i; if (h == "check") kc = i }
                      if (!kc) { print "!\tthe table has no Check column"; exit }; next }
      c = $cc; gsub(/^[ \t]+|[ \t]+$/, "", c); if (c !~ /^`[^`]+`$/) next
      k = $kc; gsub(/`/, "", k); split(k, w, " "); gsub(/`/, "", c)
      print w[1] "\t" c
    }'
}

# The runner re-runs each check by its name before the review axes; `n/a` rows are not run.
static_checks='[]'
if has_section 'static checks' && ! is_none 'static checks'; then
  sc_err="$(command_cells_err 'static checks')"
  sc_rows="$(check_command_rows 'static checks')"
  case "$sc_rows" in '!'*) sc_err="!${sc_rows#*	}"; sc_rows="" ;; esac
  static_checks="$(jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {check: .[0], command: .[1]})' <<<"$sc_rows")"
  [ -z "$sc_err" ] && [ "$(jq '[.[].check] | length != (unique | length)' <<<"$static_checks")" = true ] && sc_err="!check names repeat"
  require 'static checks — commands' "${sc_err:-x}"
fi

# A fresh `git worktree` starts with no `node_modules` (nothing under it is checked into git);
# without this the runner's first static check or test-toolchain command is not a code problem
# reported as red, it is a missing binary reported as `blocked, kind toolchain` — three or four
# times over, once per command that resolves it from a package's own `node_modules/.bin/`. The
# runner runs each of these once, right after the worktree is created, before anything else reads
# it. Optional: a project whose worktree needs no setup (a symlinked `node_modules`, a vendored
# toolchain) declares `none` or leaves the section out.
# The repo's own worktree command, when plain `git worktree add` misses what the repo scaffolds
# (compose env, ports, seeded data). The runner substitutes `<branch>` and `<base>` and runs it
# under `sh -c` from the primary repo's checkout; absent or `none`, it uses lib/git/worktree.mjs.
worktree_create=""
if has_section 'worktree' && ! is_none 'worktree'; then
  wc_line="$(section worktree | grep -i '^- *create' | head -1 | sed 's/^- *[Cc]reate[^:]*: *//')"
  wc_span="$(printf '%s' "$wc_line" | grep -o '^`[^`]*`' | tr -d '`')"
  wc_err=x
  if [ -z "$wc_line" ]; then wc_err=""
  elif [ -z "$wc_span" ]; then wc_err="!not a runnable command (one code span): $wc_line"
  else
    case "$wc_span" in *TODO*) wc_err=TODO ;; *'<branch>'*) ;; *) wc_err="!the command must name <branch>" ;; esac
    wc_bad="$(printf '%s' "$wc_span" | grep -o '<[A-Za-z_-]*>' | grep -vx '<branch>' | grep -vx '<base>' | head -1)"
    [ "$wc_err" = x ] && [ -n "$wc_bad" ] && wc_err="!unknown placeholder $wc_bad (only <branch> and <base>)"
  fi
  require 'worktree — create' "$wc_err"
  worktree_create="$wc_span"
fi

worktree_setup='[]'
if has_section 'worktree setup' && ! is_none 'worktree setup'; then
  ws_err="$(command_cells_err 'worktree setup')"
  ws_rows="$(check_command_rows 'worktree setup')"
  case "$ws_rows" in '!'*) ws_err="!${ws_rows#*	}"; ws_rows="" ;; esac
  worktree_setup="$(jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {check: .[0], command: .[1]})' <<<"$ws_rows")"
  [ -z "$ws_err" ] && [ "$(jq '[.[].check] | length != (unique | length)' <<<"$worktree_setup")" = true ] && ws_err="!check names repeat"
  require 'worktree setup — commands' "${ws_err:-x}"
fi

# Read by the conflict-resolution skill, not rendered. A conflicted file matching a Glob is
# regenerated with its Command rather than hand-merged, so a prose command or a glob nothing can
# match would be trusted at exactly the moment nobody is checking it. Optional: absent or `none`
# declares no generated files.
if has_section 'generated files' && ! is_none 'generated files'; then
  gf_err="$(section 'generated files' | awk -F'|' '
    /^\|/ {
      if ($0 ~ /^\|[ :-]*-[ :|-]*\|$/) next
      if (++n == 1) { for (i = 2; i < NF; i++) { h = $i; gsub(/^[ \t]+|[ \t]+$/, "", h); if (tolower(h) == "glob") gc = i }
                      if (!gc) { print "!the table has no Glob column"; exit }; next }
      row = $0; gsub(/[| \t]/, "", row); if (row == "") next
      g = $gc; gsub(/^[ \t]+|[ \t]+$/, "", g)
      if (g ~ /TODO/) { print "TODO"; exit }
      if (g !~ /`[^`]+`/) { print "!a Glob cell names no backticked glob: " g; exit }
      if (g ~ /`\.\.\./) { print "!an abbreviated glob (\"...\") cannot be matched; write the full path"; exit }
    }')"
  [ -z "$gf_err" ] && gf_err="$(command_cells_err 'generated files')"
  require 'generated files — table' "${gf_err:-x}"
fi

# ---- run policy -----------------------------------------------------------------------------
int_or() { case "$1" in ''|*[!0-9]*) echo "$2" ;; *) echo "$1" ;; esac; }
day_ceiling="$(field 'run policy' 'Day ceiling' | awk '{print $1}')"
max_parallel="$(field 'run policy' 'Max parallel' | awk '{print $1}')"
fix_rounds_raw="$(field 'run policy' 'Fix rounds' | awk '{print $1}')"
ci_fix_raw="$(field 'run policy' 'CI fix rounds' | awk '{print $1}')"
stop_hour="$(field 'run policy' 'Stop hour' | awk '{print $1}')"
force_push_raw="$(field 'run policy' 'Force-push after rebase' | awk '{print $1}' | tr -d '`')"
fix_default="$(jq '.caps.fixRounds.default' "$KINDS")"; fix_max="$(jq '.caps.fixRounds.max' "$KINDS")"
ci_default="$(jq '.caps.ciFix.default' "$KINDS")"
fix_rounds="$(int_or "$fix_rounds_raw" "$fix_default")"
ci_fix="$(int_or "$ci_fix_raw" "$ci_default")"
exclusions="$(ticked_field 'run policy' 'Ceiling exclusions' | to_json_list)"
locked="$(ticked_field 'run policy' 'Locked artefacts' | to_json_list)"
posint() { case "$1" in ''|*TODO*) echo "$1" ;; *[!0-9]*|0) echo "!not a positive integer: $1" ;; *) echo x ;; esac; }
if has_section 'run policy'; then
  require 'run policy — day ceiling'  "$(posint "$day_ceiling")"
  require 'run policy — max parallel' "$(posint "$max_parallel")"
  if [ -n "$fix_rounds_raw" ] && { [ "$fix_rounds_raw" != "$fix_rounds" ] || [ "$fix_rounds" -gt "$fix_max" ]; }; then
    require 'run policy — fix rounds' "!must be an integer no higher than $fix_max"
  fi
  bad_kinds="$(jq -r --slurpfile k "$KINDS" '[.[] | select(($k[0].kinds | has(.)) | not)] | join(", ")' <<<"$exclusions")"
  [ -n "$bad_kinds" ] && require 'run policy — ceiling exclusions' "!unknown kinds: $bad_kinds"
  case "$stop_hour" in ''|none|[0-2][0-9]:[0-5][0-9]) ;; *) require 'run policy — stop hour' "!none or HH:MM" ;; esac
  case "$force_push_raw" in ''|never|with-lease) ;; *) require 'run policy — force-push after rebase' "!never or with-lease" ;; esac
else
  require 'run policy — section' ""
fi
[ "$stop_hour" = none ] && stop_hour=""
# Absent means never: a rebased branch that needs a force-push parks instead of rewriting the remote.
force_push="${force_push_raw:-never}"
run_policy="$(jq -n --arg d "$day_ceiling" --arg m "$max_parallel" --argjson f "$fix_rounds" \
  --argjson c "$ci_fix" --argjson e "$exclusions" --arg s "$stop_hour" --argjson l "$locked" --arg fp "$force_push" '
  {dayCeiling: ($d | tonumber? // null), maxParallel: ($m | tonumber? // null), fixRounds: $f, ciFix: $c,
   ceilingExclusions: $e, stopHour: (if $s == "" then null else $s end), lockedArtefacts: $l,
   forcePushAfterRebase: $fp}')"

# ---- inviolables ----------------------------------------------------------------------------
# Top-level list items, continuation lines folded in. Each names its canonical source.
inviolables="$(section inviolables | awk '
  /^(- |[0-9]+\. )/ { if (item != "") print item; item = $0; sub(/^(- |[0-9]+\. )/, "", item); next }
  /^[ \t]+[^ \t]/ && item != "" { l = $0; sub(/^[ \t]+/, "", l); item = item " " l; next }
  /^[ \t]*$/ { if (item != "") print item; item = "" }
  END { if (item != "") print item }' | to_json_list)"
if ! has_section inviolables; then inv_err=""
elif is_none inviolables; then inv_err=x; inviolables='[]'
elif section inviolables | grep -q TODO && [ "$inviolables" = '[]' ]; then inv_err=TODO
else inv_err="$(jq -r '
  if length == 0 then "!no items; write none if there are none"
  elif any(.[]; test("TODO")) then "TODO"
  elif any(.[]; test("source:"; "i") | not) then "!an item names no Source:"
  else "x" end' <<<"$inviolables")"; fi
require 'inviolables — list' "$inv_err"

# ---- owner proxy ----------------------------------------------------------------------------
# Absent or `none`: no proxy. Ticket runs still launch; an unattended day run does not.
owner_proxy=null
if has_section 'owner proxy' && ! is_none 'owner proxy'; then
  proxy_role="$(token_field 'owner proxy' 'Proxy')"
  mandate="$(ticked_field 'owner proxy' 'Mandate' | to_json_list)"
  channels="$(field 'owner proxy' 'Hard-stop channels')"
  bad_mandate="$(jq -r --arg m "$MANDATES" '[.[] | select(. as $x | ($m | split(" ") | index($x)) | not)] | join(", ")' <<<"$mandate")"
  require 'owner proxy — role' "$proxy_role"
  if [ "$mandate" = '[]' ]; then require 'owner proxy — mandate' "!empty; write none for no proxy"
  elif [ -n "$bad_mandate" ]; then require 'owner proxy — mandate' "!outside the closed list: $bad_mandate"
  else require 'owner proxy — mandate' x; fi
  owner_proxy="$(jq -n --arg r "$proxy_role" --argjson m "$mandate" --arg c "$channels" '
    {role: $r, mandate: $m, hardStopChannels: (if $c == "" then "every outward channel" else $c end),
     hardStopPaths: "every merge-authority row whose who is not agent"}')"
fi
day_run=false; [ "$owner_proxy" != null ] && day_run=true

# ---- board ----------------------------------------------------------------------------------
# Optional, read by flow-pm and not rendered. Absent or `none`: flow-pm audits and writes nothing.
# Present, the write mandate is a closed list, so a malformed one fails here rather than mid-sweep.
BOARD_WRITES='transition assignee priority comment'
if has_section board && ! is_none board; then
  [ "$tracker_kind" = none ] && require 'board — tracker' "!a board needs a tracker; write none"
  require 'board — acts on' "$(field board 'Acts on')"
  writes_raw="$(field board 'Writes')"
  writes="$(ticked_field board 'Writes' | to_json_list)"
  bad_writes="$(jq -r --arg w "$BOARD_WRITES" '[.[] | select(. as $x | ($w | split(" ") | index($x)) | not)] | join(", ")' <<<"$writes")"
  if [ -z "$writes_raw" ]; then require 'board — writes' "!empty; write none for a read-only board"
  elif [ -n "$bad_writes" ]; then require 'board — writes' "!outside the closed list: $bad_writes"
  elif [ "$writes" = '[]' ] && ! printf '%s' "$writes_raw" | grep -Eqi '^none\b'; then require 'board — writes' "$writes_raw"
  else require 'board — writes' x; fi
  if jq -e 'index("transition")' <<<"$writes" >/dev/null; then
    require 'board — verified status' "$(token_field board 'Verified status')"
  fi
  canary="$(token_field board 'Canary')"
  case "$canary" in
    ''|*TODO*) require 'board — canary' "$canary" ;;
    *) printf '%s' "$canary" | grep -Eq '^[A-Z][A-Z0-9]*-[0-9]+$' \
         && require 'board — canary' x || require 'board — canary' "!not a ticket key: $canary" ;;
  esac
  require 'board — wip limit' "$(posint "$(field board 'WIP limit' | awk '{print $1}')")"
  require 'board — state dir' "$(token_field board 'State dir')"
fi

# ---- escalation -----------------------------------------------------------------------------
# Optional field; the resolver supplies $TILLER_DOUBT_LOG or the in-profile default. Only a field
# that is written but unfinished is refused.
doubt_log="$(token_field escalation 'Doubt log')"
human_role="$(field escalation 'Human')"
require 'escalation — doubt log' "${doubt_log:-x}"
case "$doubt_log" in
  *TODO*) ;;
  *) doubt_log="$("$REPO_DIR/lib/doubt-log.sh" resolve --profile "$profile" "$doubt_log")" ;;
esac
require 'escalation — human'     "$human_role"
escalation="$(jq -n --arg d "$doubt_log" --arg h "$human_role" '{doubtLog: $d, human: $h}')"

# ---- verification register ------------------------------------------------------------------
# Optional. Absent or `none`: no cross-ticket register, rendered as null. Present, it names exactly
# one file: a register that forks across paths is not a register.
verification_register=null
if has_section 'verification register' && ! is_none 'verification register'; then
  vr_line="$(section 'verification register' | grep -i '^- *path' | head -1)"
  vr_path="$(printf '%s' "$vr_line" | grep -o '`[^`]*`' | head -1 | tr -d '`')"
  case "$vr_line" in
    *TODO*) vr_err=TODO ;;
    "") vr_err="!no '- Path:' line" ;;
    *) if [ -n "$vr_path" ]; then vr_err=x; else vr_err="!no backticked path"; fi ;;
  esac
  require 'verification register — path' "$vr_err"
  [ "$vr_err" = x ] && verification_register="$(jq -n --arg p "$vr_path" '$p')"
fi

# ---- commits --------------------------------------------------------------------------------
# Optional. Absent or `none`: plain Conventional Commits with no ticket prefix.
COMMIT_DEFAULT='<type>(<scope>): <subject>'
commits="$(jq -n --arg f "$COMMIT_DEFAULT" '{format: $f, ticketFromBranch: null, withoutTicket: $f}')"
if has_section commits && ! is_none commits; then
  cm_format="$(token_field commits 'Format')"
  cm_branch="$(token_field commits 'Ticket from branch')"
  cm_without="$(token_field commits 'Without ticket')"
  cm_err=x
  case "$cm_format$cm_branch$cm_without" in *TODO*) cm_err=TODO ;; esac
  if [ "$cm_err" = x ]; then
    if [ -z "$cm_format" ]; then cm_err="!no '- Format:' line"
    else
      cm_bad="$(printf '%s\n%s\n' "$cm_format" "$cm_without" | grep -o '<[A-Za-z_-]*>' | grep -vxE '<(ticket|type|scope|subject)>' | head -1)"
      if [ -n "$cm_bad" ]; then cm_err="!unknown placeholder $cm_bad (only <ticket> <type> <scope> <subject>)"
      else
        case "$cm_format" in *'<type>'*'<subject>'*) ;; *) cm_err="!the format must name <type> and <subject>" ;; esac
        case "$cm_without" in *'<ticket>'*) cm_err="!Without ticket cannot name <ticket>" ;; esac
        case "$cm_format" in *'<ticket>'*) [ -z "$cm_branch" ] && cm_err="!a format naming <ticket> needs a '- Ticket from branch:' regex" ;; esac
      fi
    fi
  fi
  require 'commits — format' "$cm_err"
  commits="$(jq -n --arg f "$cm_format" --arg b "$cm_branch" --arg w "$cm_without" '
    {format: $f, ticketFromBranch: (if $b == "" then null else $b end),
     withoutTicket: (if $w == "" then ($f | gsub("\\[?<ticket>\\]? *"; "")) else $w end)}')"
fi

# ---- model routing --------------------------------------------------------------------------
routing="$(rows 'model routing' | jq -R -s '
  split("\n") | map(select(length > 0) | split("\t") | select(.[0] != null and .[0] != ""))
  | map({(.[0]): (.[1] // "")}) | add // {}')"
routing_err="$(jq -r --slurpfile k "$KINDS" '
  [to_entries[] | . as $e | select(($k[0].lanes | index($e.key)) == null or ($k[0].tiers | index($e.value)) == null)
   | "\(.key) → \(.value)"] | join(", ")' <<<"$routing")"
if [ -n "$routing_err" ]; then require 'model routing — overrides' "!unknown lane or tier: $routing_err"
elif [ -f "$ROUTING" ]; then
  # A lane that feeds a gate is never routed below the top tier.
  floor_err="$(jq -r --slurpfile r "$ROUTING" '
    [to_entries[] | select(($r[0].lanes[.key].gate // false) and .value != "T3") | .key] | join(", ")' <<<"$routing")"
  [ -n "$floor_err" ] && require 'model routing — overrides' "!gate lanes below T3: $floor_err"
fi

# ---- output ---------------------------------------------------------------------------------
if [ "$mode" = check ]; then
  printf 'profile      %s\n' "$profile"
  printf 'schema       %s (reads %s-%s)\n' "$(awk -F': *' '/^schema_version:/{print $2; exit}' "$profile" | tr -d '"')" "$SCHEMA_MIN" "$SCHEMA_MAX"
  printf 'headings     %s\n' "$(headings)"
  printf '\nrequired keys\n'
  for k in "${labels[@]}"; do
    status=ok; detail=""
    for m in ${missing+"${missing[@]}"}; do
      case "$m" in "$k"*) status=MISSING; detail="${m#"$k"}" ;; esac
    done
    printf '  %-8s %s%s\n' "$status" "$k" "$detail"
  done
  if [ "$day_run" = true ]; then printf '\nday run      allowed (owner proxy declared)\n'
  else printf '\nday run      not allowed (no owner proxy)\n'; fi
  if [ ${#missing[@]} -gt 0 ]; then
    printf '\nA launch against this profile would be refused.\n'
    exit 4
  fi
  printf '\nLaunch-safe.\n'
  exit 0
fi

if [ ${#missing[@]} -gt 0 ]; then
  note "profile-facts: $profile cannot produce a facts object."
  for m in "${missing[@]}"; do note "  missing or unreadable: $m"; done
  note "  headings present: $(headings)"
  note ""
  note "Fill the section in the profile. A missing fact is not a permission: nothing downstream"
  note "defaults it, and no phase infers it from the repository. See docs/profile-schema.md."
  exit 4
fi

jq -n \
  --argjson schemaVersion "$schema_version" \
  --arg profile "$name" --arg profilePath "$profile" \
  --argjson jiraKeys "$jira" --argjson tracker "$tracker" --argjson tools "$tools" --argjson repos "$repos" \
  --arg branchConvention "$branch_convention" --arg worktree "$worktree" \
  --arg integrateMain "$integrate" --arg ledgerPath "$ledger" \
  --argjson mergeAuthority "$merge_authority" --argjson gates "$gates" \
  --argjson runPolicy "$run_policy" --argjson inviolables "$inviolables" \
  --argjson ownerProxy "$owner_proxy" --argjson dayRunAllowed "$day_run" \
  --argjson escalation "$escalation" --argjson modelRouting "$routing" \
  --argjson staticChecks "$static_checks" --argjson worktreeSetup "$worktree_setup" \
  --argjson verificationRegister "$verification_register" \
  --arg worktreeCreate "$worktree_create" --argjson commits "$commits" \
  '{schemaVersion: $schemaVersion, profile: $profile, profilePath: $profilePath,
    jiraKeys: $jiraKeys, tracker: $tracker, tools: $tools, repos: $repos,
    branchConvention: $branchConvention, worktree: $worktree, integrateMain: $integrateMain,
    ledgerPath: $ledgerPath, mergeAuthority: $mergeAuthority, gates: $gates,
    runPolicy: $runPolicy, inviolables: $inviolables, ownerProxy: $ownerProxy,
    dayRunAllowed: $dayRunAllowed, escalation: $escalation, modelRouting: $modelRouting,
    staticChecks: $staticChecks, worktreeSetup: $worktreeSetup,
    verificationRegister: $verificationRegister,
    worktreeCreate: (if $worktreeCreate == "" then null else $worktreeCreate end),
    commits: $commits}'
