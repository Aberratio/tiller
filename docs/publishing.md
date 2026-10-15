# Publishing checklist

Steps for the owner before the repository goes public. Do them in order; (a) is the only
irreversible one once the history is pushed.

## a. History carries one identity with a company e-mail

Every commit (229 on `main` when this was written) has the same author identity. Publish either a
rewritten history or a fresh one.

Option 1, rewrite, keep the commits (work in a fresh clone, never in the working copy):

```bash
git clone --no-local . ../tiller-public && cd ../tiller-public
pip install git-filter-repo
printf 'Public Name <public-id@users.noreply.github.com> <old-email@company.example>\n' > ../mailmap
git filter-repo --mailmap ../mailmap
git log --format='%an <%ae> | %cn <%ce>' | sort -u      # must show only the public identity
```

Option 2, one commit, no history:

```bash
git clone --no-local . ../tiller-public && cd ../tiller-public
git checkout --orphan public && git add -A
git commit -m "feat: initial public release"
git branch -M main
```

Old commit messages and file versions can still hold facts the leak guard never saw; the second
option removes that risk, the first keeps blame and review history.

## b. License

`LICENSE` is MIT with the holder line "tiller contributors". Change the holder, or the license,
before the first push if that is not what is wanted. Update `package.json` and the README to match.

## c. Local clutter stays local

```bash
git worktree list
git branch --list 'worktree-agent-*' 'backup/*'         # delete these in the clone, never publish them
git worktree prune
git remote add origin <public-url>
git push origin main --tags                              # only main and tags, never --all or --mirror
```

`.claude/`, `profiles/*`, `personal/*`, `brains/*` and `helm/` are git-ignored; confirm with
`git status --ignored` that nothing from them is tracked.

## d. Verify from a fresh clone on a machine without profiles

```bash
git clone <public-url> /tmp/tiller-check && cd /tmp/tiller-check
bash lib/leak-guard.sh
npm test
```

Expect a clean leak guard (it then checks credential shapes only) and no red suite other than any
that needs a pseudo-terminal, which sandboxes and CI runners lack.

## e. Repository settings

- Protect `main`: require pull requests and a passing `npm test` check, block force pushes.
- Enable private vulnerability reporting (Settings, Security); `SECURITY.md` points there.
- Dependabot is not needed: the repository has no dependencies.
- Fill the contact placeholder in `CODE_OF_CONDUCT.md`.

## f. First release

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Move the `Unreleased` entries in `CHANGELOG.md` under `0.1.0` with the date, in the same commit
as the tag's parent.
