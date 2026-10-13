# A brain

A brain is a local knowledge vault under `brains/<name>/`, with its own git history. It is
git-ignored here and closed to every project until granted.

1. `git clone <vault> brains/<name>` or move an existing vault in, keeping its `.git`.
2. `lib/brain-access.sh <profile|_none>` to grant `read` or `write`.
3. `lib/resolve-brains.sh` from a project prints what that project may use.

The private-access hook (`install.sh --hooks`) denies the rest.
