#!/usr/bin/env node
// Detect the facts of one repository that a profile can carry, with the source of each.
//
//   detect.mjs <repo-dir> [--no-network] [--today YYYY-MM-DD]   -> JSON on stdout
//
// Deterministic and model-free. A fact the script cannot establish is `null` with a reason, never
// a guess: the renderer turns it into a TODO or a question. Network reads go through `gh` only and
// are skipped with --no-network; a 403/404 from the forge is "unknown", not "no protection".

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const NOT_KEYS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'GHSA', 'HTTP', 'TLS', 'ES', 'WCAG', 'PR', 'CI', 'V'])
const BOT_NOISE = /^(dependabot|renovate|github-actions|codecov|vercel|netlify|sonarcloud|changeset-bot)(\[bot\])?$/i

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 << 20 })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const git = (cwd, ...args) => sh('git', args, cwd)
const fact = (value, source) => ({ value, source })
const unknown = (reason) => ({ value: null, reason })

export function parseRemote(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(url || '')
  return m ? { host: 'github', slug: `${m[1]}/${m[2]}`, name: m[2] } : null
}

// A remote URL on its way into a message a human will read and into the git-tracked detected facts.
// Credentials reach a clone's origin in three shapes - `https://user:token@host/...`, the same with
// the token alone and no user, and the scp form `user:token@host:org/repo` - and each can appear
// more than once, so every userinfo goes, not just the first.
export function redactUrl(url) {
  return (url || '').replace(/(:\/\/)[^/@\s]+@/g, '$1***@').replace(/[^/@\s]+:[^/@\s]*@/g, '***@')
}

// Ticket keys seen in branch names and commit subjects, most frequent first.
export function ticketKeys(lines) {
  const counts = {}
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d+)(?![A-Za-z0-9])/g)) {
      if (!NOT_KEYS.has(m[1])) counts[m[1]] = (counts[m[1]] || 0) + 1
    }
  }
  return Object.entries(counts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
}

// The branch shape most work branches share, when at least half of them share it.
export function branchConvention(branches) {
  const work = branches.filter(b => !/^(main|master|develop|staging|production|release.*|HEAD|renovate\/.*|dependabot\/.*)$/.test(b))
  if (work.length < 4) return unknown(`only ${work.length} work branches to read`)
  const shapes = [
    [/^[A-Z][A-Z0-9]+-\d+[-_]/, '`<KEY>-<number>-<details>`'],
    [/^[A-Z][A-Z0-9]+-\d+$/, '`<KEY>-<number>`'],
    [/^[a-z]+\/[A-Z][A-Z0-9]+-\d+/, '`<type>/<KEY>-<number>-<details>`'],
    [/^[a-z]+\/[a-z0-9]/, '`<type>/<details>`'],
  ]
  let best = null
  for (const [re, shape] of shapes) {
    const hits = work.filter(b => re.test(b))
    if (!best || hits.length > best.hits.length) best = { shape, hits }
  }
  const share = best.hits.length / work.length
  if (share < 0.5) return unknown(`no shape covers half of ${work.length} work branches`)
  return fact(best.shape, `${best.hits.length} of ${work.length} remote branches, e.g. \`${best.hits[0]}\``)
}

export function commitStyle(subjects) {
  if (subjects.length < 5) return unknown('fewer than 5 commits on main')
  // `kind` is what the profile's `## commits` is rendered from; the label is for a human.
  const styles = [
    [/^\[[A-Z][A-Z0-9]+-\d+\] [a-z]+(\([^)]*\))?!?: /, '`[<KEY>-<number>] <type>(<scope>): <subject>`', 'ticket-bracket'],
    [/^[A-Z][A-Z0-9]+-\d+:? /, '`<KEY>-<number>: <subject>`', 'ticket-colon'],
    [/^[a-z]+(\([^)]*\))?!?: /, 'Conventional Commits, `<type>(<scope>): <subject>`', 'conventional'],
  ]
  const own = subjects.filter(s => !/^Merge |^Bump |^chore\(deps\)|^Update dependency/.test(s))
  for (const [re, label, kind] of styles) {
    const n = own.filter(s => re.test(s)).length
    if (n / own.length >= 0.5) return { ...fact(label, `${n} of ${own.length} recent non-bot subjects on main`), kind }
  }
  return unknown(`no style covers half of ${own.length} recent subjects`)
}

// How work branches take main in: merge commits of main into a branch, or none (rebase).
export function integrateMain(mergeSubjects, workBranchCount, mainBranch) {
  const re = new RegExp(`^Merge (remote-tracking )?branch '(origin/)?${mainBranch}'`)
  const n = mergeSubjects.filter(s => re.test(s)).length
  if (n >= 3) return fact('merge', `${n} "Merge branch '${mainBranch}'" commits on remote branches in 180 days`)
  if (n === 0 && workBranchCount >= 4) return fact('rebase', `no merge of ${mainBranch} into any of ${workBranchCount} remote branches in 180 days`)
  return unknown(`${n} merge-of-main commits, too few to call`)
}

const LOCKS = [
  ['package-lock.json', 'npm', 'npm ci', 'npm install --package-lock-only'],
  ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile', 'pnpm install --lockfile-only'],
  ['yarn.lock', 'yarn', 'yarn install --frozen-lockfile', 'yarn install'],
  ['bun.lock', 'bun', 'bun install --frozen-lockfile', 'bun install'],
  ['bun.lockb', 'bun', 'bun install --frozen-lockfile', 'bun install'],
]

function runScript(pm, name) {
  if (name === 'test') return pm === 'yarn' || pm === 'pnpm' || pm === 'bun' ? `${pm} test` : 'npm test'
  return pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`
}

// package.json scripts sorted into lanes. Scripts that need a live environment (e2e) are reported
// but never become a static check.
export function classifyScripts(scripts = {}) {
  const out = { test: [], static: [], e2e: [] }
  for (const [name, body] of Object.entries(scripts)) {
    if (/no test specified/.test(body)) continue
    // The name is run by bash and printed inside a markdown code span; anything else is dropped
    // rather than rendered, the way an unsafe package directory is.
    if (!/^[\w.:@/-]+$/.test(name)) continue
    if (/^(test|test:unit|unit)$/.test(name)) out.test.push(name)
    else if (/e2e|playwright|cypress|detox/i.test(name) || /playwright|cypress|detox/.test(body)) out.e2e.push(name)
    else if (/^(lint|eslint)$/.test(name)) out.static.push(['lint', name])
    else if (/^(typecheck|type-check|types|tsc|check-types)$/.test(name)) out.static.push(['typecheck', name])
    else if (/^(format:check|prettier:check|fmt:check)$/.test(name)) out.static.push(['format', name])
  }
  return out
}

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function readText(path) { try { return readFileSync(path, 'utf8') } catch { return '' } }

function toolchain(root, files) {
  const set = new Set(files)
  const packages = []
  const generated = []
  const derivedUnknown = []
  const unlocked = []
  const prefix = (dir) => (dir === '.' ? '' : `cd ${dir} && `)
  const manifests = files.filter(f => /(^|\/)(package\.json|Gemfile|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(f) && f.split('/').length <= 3
    // The directory lands unquoted in a `cd <dir> &&` command cell.
    && /^[\w./-]+$/.test(dirname(f)))
  for (const m of manifests) {
    const dir = dirname(m)
    const at = (f) => (dir === '.' ? f : `${dir}/${f}`)
    const kind = basename(m)
    const pkg = { dir, ecosystem: null, install: null, test: [], static: [], e2e: [] }
    if (kind === 'package.json') {
      const lock = LOCKS.find(([f]) => set.has(at(f)))
      // A workspace member without its own lockfile is installed by its root. At the root itself
      // there is no such root, so the repo is not toolchain-free - its lockfile is just not in the
      // clone, and saying `none` would be a fact nobody measured.
      if (!lock) { if (dir === '.') unlocked.push(m); continue }
      const [lockFile, pm, install, regen] = lock
      const json = readJson(join(root, m)) || {}
      const c = classifyScripts(json.scripts)
      Object.assign(pkg, { ecosystem: pm, install: prefix(dir) + install })
      pkg.test = c.test.map(s => ['unit', prefix(dir) + runScript(pm, s)])
      pkg.static = c.static.map(([check, s]) => [check, prefix(dir) + runScript(pm, s)])
      pkg.e2e = c.e2e.map(s => prefix(dir) + runScript(pm, s))
      generated.push([at(lockFile), prefix(dir) + regen])
    } else if (kind === 'Gemfile') {
      const lock = readText(join(root, at('Gemfile.lock')))
      Object.assign(pkg, { ecosystem: 'bundler', install: prefix(dir) + 'bundle install' })
      if (/^\s{4}rspec-core /m.test(lock)) pkg.test.push(['unit', prefix(dir) + 'bundle exec rspec'])
      else if (set.has(at('Rakefile')) && files.some(f => f.startsWith(at('test/')))) pkg.test.push(['unit', prefix(dir) + 'bundle exec rake test'])
      if (/^\s{4}rubocop /m.test(lock)) pkg.static.push(['lint', prefix(dir) + 'bundle exec rubocop'])
      if (lock) generated.push([at('Gemfile.lock'), prefix(dir) + 'bundle install'])
    } else if (kind === 'pyproject.toml') {
      const toml = readText(join(root, m))
      const runner = set.has(at('uv.lock')) ? 'uv' : set.has(at('poetry.lock')) ? 'poetry' : null
      if (!runner) { if (dir === '.') unlocked.push(m); continue }
      const run = runner === 'uv' ? 'uv run ' : 'poetry run '
      Object.assign(pkg, { ecosystem: runner, install: prefix(dir) + (runner === 'uv' ? 'uv sync --frozen' : 'poetry install --no-root') })
      if (/pytest/.test(toml)) pkg.test.push(['unit', prefix(dir) + run + 'pytest'])
      if (/ruff/.test(toml)) pkg.static.push(['lint', prefix(dir) + run + 'ruff check .'])
      if (/mypy/.test(toml)) pkg.static.push(['typecheck', prefix(dir) + run + 'mypy .'])
      generated.push([at(runner === 'uv' ? 'uv.lock' : 'poetry.lock'), prefix(dir) + (runner === 'uv' ? 'uv lock' : 'poetry lock')])
    } else if (kind === 'go.mod') {
      Object.assign(pkg, { ecosystem: 'go', install: prefix(dir) + 'go mod download' })
      pkg.test.push(['unit', prefix(dir) + 'go test ./...'])
      pkg.static.push(['vet', prefix(dir) + 'go vet ./...'])
      if (set.has(at('go.sum'))) generated.push([at('go.sum'), prefix(dir) + 'go mod tidy'])
    } else if (kind === 'Cargo.toml') {
      Object.assign(pkg, { ecosystem: 'cargo', install: prefix(dir) + 'cargo fetch' })
      pkg.test.push(['unit', prefix(dir) + 'cargo test'])
      pkg.static.push(['lint', prefix(dir) + 'cargo clippy -- -D warnings'])
    }
    if (pkg.ecosystem) packages.push(pkg)
  }
  for (const f of files) if (/\.(gen|generated)\.[a-z]+$/.test(f)) derivedUnknown.push(f)
  return { packages, generated, derivedUnknown: derivedUnknown.slice(0, 20), unlocked }
}

const CONVENTION_DOCS = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.github/copilot-instructions.md',
  '.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'CODEOWNERS', '.github/CODEOWNERS',
  'docs/CODEOWNERS', '.editorconfig', '.cursorrules']

function conventions(files) {
  const docs = CONVENTION_DOCS.filter(f => files.includes(f))
  for (const f of files) {
    if (/^[^/]+\/(?:[^/]+\/)?(CLAUDE|AGENTS)\.md$/.test(f)) docs.push(f)
  }
  const dirs = ['docs/adr', 'docs/decisions', 'adr', '.claude/rules', '.cursor/rules', '.github/instructions']
    .filter(d => files.some(f => f.startsWith(d + '/'))).map(d => d + '/')
  return [...new Set([...docs, ...dirs])]
}

// Top-level name, job ids/names and triggers of each workflow. Line-based, because a YAML library
// is not a dependency here and these three things sit at fixed indentation in practice.
export function parseWorkflow(text) {
  const name = (/^name:[ \t]*["']?([^"'\n]+)["']?\s*$/m.exec(text) || [])[1] || null
  const onBlock = (/^on:[ \t]*(.*)$/m.exec(text) || [])[1] || ''
  const onLines = text.split('\n')
  const onIdx = onLines.findIndex(l => /^on:/.test(l))
  let triggers = onBlock.replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
  if (onIdx >= 0 && !triggers.length) {
    for (const l of onLines.slice(onIdx + 1)) {
      if (/^\S/.test(l)) break
      const m = /^ {2}([a-z_]+):?/.exec(l)
      if (m) triggers.push(m[1])
    }
  }
  const jobs = []
  const lines = text.split('\n')
  const jobsIdx = lines.findIndex(l => /^jobs:\s*$/.test(l))
  if (jobsIdx >= 0) {
    for (const l of lines.slice(jobsIdx + 1)) {
      if (/^\S/.test(l)) break
      const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l)
      if (id) { jobs.push({ id: id[1], name: null }); continue }
      const jn = /^ {4}name:\s*["']?([^"'\n]+?)["']?\s*$/.exec(l)
      if (jn && jobs.length && !jobs.at(-1).name) jobs.at(-1).name = jn[1]
    }
  }
  return { name, triggers, jobs }
}

function workflows(root, files) {
  return files.filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map(f => {
    const w = parseWorkflow(readText(join(root, f)))
    return { file: f, ...w, onPullRequest: w.triggers.some(t => /^pull_request/.test(t)),
      deploys: /deploy|publish|release/i.test(`${f} ${w.name || ''}`) }
  })
}

function ghJson(args) {
  const r = sh('gh', args)
  if (!r.ok) return { error: (r.err.split('\n').find(Boolean) || 'gh failed').slice(0, 160) }
  try { return { data: JSON.parse(r.out) } } catch { return { error: 'unparseable gh output' } }
}

function forge(slug, mainBranch) {
  if (!sh('gh', ['auth', 'status']).ok) return { available: false, reason: 'gh is not authenticated' }
  const out = { available: true }
  const checks = new Set()
  const sources = []
  const rules = mainBranch ? ghJson(['api', `repos/${slug}/rules/branches/${mainBranch}`]) : { error: 'main unknown' }
  if (rules.data) {
    for (const r of rules.data) {
      if (r.type === 'required_status_checks') for (const c of r.parameters?.required_status_checks || []) checks.add(c.context)
      if (r.type === 'pull_request') out.requiredApprovals = r.parameters?.required_approving_review_count ?? null
    }
    sources.push(`rulesets on ${mainBranch}`)
  }
  const prot = mainBranch ? ghJson(['api', `repos/${slug}/branches/${mainBranch}/protection/required_status_checks`]) : { error: 'main unknown' }
  if (prot.data) { for (const c of prot.data.contexts || []) checks.add(c); sources.push(`branch protection on ${mainBranch}`) }
  // Classic protection answers a non-admin with 403/404 too; only "not protected" says there is none.
  const protRead = prot.data || /not protected|required status checks not enabled/i.test(prot.error || '')
  out.requiredChecks = !mainBranch ? unknown('main branch unknown, so its protection was not read')
    : rules.data && protRead ? fact([...checks], sources.join(' + ') || `no rulesets or branch protection on ${mainBranch}`)
    : unknown(`required checks not fully readable: ${[rules.error, protRead ? null : prot.error].filter(Boolean).join('; ')}`)
  const repo = ghJson(['api', `repos/${slug}`])
  if (repo.data) {
    const d = repo.data
    out.mergeMethods = fact([d.allow_merge_commit && 'merge', d.allow_squash_merge && 'squash', d.allow_rebase_merge && 'rebase'].filter(Boolean),
      `repos/${slug} settings`)
    out.visibility = d.visibility || null
    out.description = d.description || null
  }
  const env = ghJson(['api', `repos/${slug}/environments`])
  out.environments = env.data ? fact((env.data.environments || []).map(e => e.name), `repos/${slug}/environments`) : unknown(env.error)
  const pulls = ghJson(['api', `repos/${slug}/pulls?state=closed&per_page=8`])
  if (pulls.data) {
    const bots = {}
    let failed = 0
    for (const pr of pulls.data) {
      for (const path of [`pulls/${pr.number}/reviews`, `issues/${pr.number}/comments`]) {
        const r = ghJson(['api', `repos/${slug}/${path}?per_page=50`])
        if (!r.data) failed++
        for (const x of r.data || []) {
          const u = x.user || {}
          if (u.type === 'Bot' && !BOT_NOISE.test(u.login)) bots[u.login] = (bots[u.login] || new Set()).add(pr.number)
        }
      }
    }
    // A failed read would make a missing bot look absent.
    out.reviewBots = failed ? unknown(`${failed} review/comment read(s) failed on the last ${pulls.data.length} closed PRs`) : fact(Object.entries(bots).map(([login, prs]) => ({ login, prs: prs.size })).sort((a, b) => b.prs - a.prs),
      `reviews and comments on the last ${pulls.data.length} closed PRs`)
  } else out.reviewBots = unknown(pulls.error)
  return out
}

export function detect(dir, { network = true, today = new Date().toISOString().slice(0, 10) } = {}) {
  const root = git(dir, 'rev-parse', '--show-toplevel')
  if (!root.ok) throw new Error(`not a git repository: ${dir}`)
  const top = root.out
  const remoteUrl = git(top, 'remote', 'get-url', 'origin').out
  const remote = parseRemote(remoteUrl)
  const originHead = git(top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const mainBranch = originHead.ok ? fact(originHead.out.replace(/^origin\//, ''), 'origin/HEAD') : unknown('origin/HEAD is not set; run `git remote set-head origin -a`')
  const main = mainBranch.value || 'main'
  const branches = git(top, 'for-each-ref', '--sort=-committerdate', '--count=200', '--format=%(refname:short)', 'refs/remotes/origin')
    .out.split('\n').filter(Boolean).map(b => b.replace(/^origin\//, '')).filter(b => b !== 'origin' && b !== 'HEAD')
  const mainRef = originHead.ok ? originHead.out : 'HEAD'
  const subjects = git(top, 'log', '-200', '--format=%s', mainRef).out.split('\n').filter(Boolean)
  const mergeSubjects = git(top, 'log', '--remotes=origin', '--merges', '--since=180.days', '--format=%s').out.split('\n').filter(Boolean)
  const files = git(top, 'ls-files').out.split('\n').filter(Boolean)
  const conv = branchConvention(branches)
  const workBranches = branches.filter(b => b !== main).length
  // A CLAUDE.md or AGENTS.md one level above the clone binds every repo in that workspace.
  const workspace = ['CLAUDE.md', 'AGENTS.md'].map(f => join(dirname(top), f)).filter(existsSync)

  const result = {
    measured: today,
    path: top,
    name: remote?.name || basename(top),
    remote: remote ? fact(remote.slug, 'origin remote') : unknown(remoteUrl ? `origin is not a GitHub remote: ${redactUrl(remoteUrl)}` : 'no origin remote'),
    mainBranch,
    ticketKeys: fact(ticketKeys([...branches, ...subjects]), 'remote branch names + last 200 subjects on main'),
    branchConvention: conv,
    commitStyle: commitStyle(subjects),
    integrateMain: integrateMain(mergeSubjects, workBranches, main),
    squashMerges: fact(subjects.filter(s => / \(#\d+\)$/.test(s)).length, 'subjects ending "(#n)" in the last 200 on main'),
    conventions: fact(conventions(files), 'git ls-files'),
    workspaceInstructions: fact(workspace, `files in ${dirname(top)}`),
    toolchain: toolchain(top, files),
    workflows: workflows(top, files),
    forge: !network ? { available: false, reason: '--no-network' }
      : remote ? forge(remote.slug, mainBranch.value) : { available: false, reason: 'no GitHub remote' },
  }
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const network = !args.includes('--no-network')
  const ti = args.indexOf('--today')
  const today = ti >= 0 ? args[ti + 1] : undefined
  const dirs = args.filter((a, i) => !a.startsWith('--') && (ti < 0 || i !== ti + 1))
  if (dirs.length !== 1) { console.error('usage: detect.mjs <repo-dir> [--no-network] [--today YYYY-MM-DD]'); process.exit(2) }
  const dir = resolve(dirs[0])
  if (!existsSync(dir)) { console.error(`detect: no such dir ${dir}`); process.exit(2) }
  try { console.log(JSON.stringify(detect(dir, { network, today }), null, 2)) }
  catch (e) { console.error(`detect: ${e.message}`); process.exit(3) }
}
