#!/usr/bin/env bash
# Create profiles/<name>/ from profiles/_template/.
#
#   new-profile.sh <name>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="${1:-}"
case "$name" in
  ""|_*|*/*|.*) echo "usage: new-profile.sh <name>  (no slash, not starting with _ or .)" >&2; exit 2 ;;
esac
dest="$ROOT/profiles/$name"
[ -e "$dest" ] && { echo "new-profile: $dest already exists" >&2; exit 1; }

cp -R "$ROOT/profiles/_template" "$dest"
rm -f "$dest/README.md"
for f in "$dest"/*.example; do
  [ -e "$f" ] && mv "$f" "${f%.example}"
done
sed -i.bak "s/^profile: <name>$/profile: $name/" "$dest/profile.md" && rm -f "$dest/profile.md.bak"
chmod 600 "$dest/secrets.env"
# Seed the guard with the profile's own name so it cannot reach a tracked file from day one.
printf '%s\n' "\\b$name\\b" >> "$dest/leak-terms.txt"
echo "$dest"
echo "next: fill $dest/profile.md, add the project's names to $dest/leak-terms.txt, then run" >&2
echo "      lib/profile-facts.sh --check --profile $dest/profile.md" >&2
