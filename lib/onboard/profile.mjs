// Turn detected repo facts plus human answers into a profile, and list what is still unanswered.
//
// Pure: no fs, no network. The CLI (onboard.mjs) reads and writes the files. Every fact a script
// can read comes from the detection; every decision comes from an answer. An unanswered decision
// renders as TODO, which profile-facts.sh refuses — the profile cannot launch on a guess.

const HOME = process.env.HOME || ''
const tick = (s) => '`' + s + '`'
const tilde = (p) => (HOME && p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)
const botName = (login) => login.replace(/\[bot\]$/, '')

// Values other profiles already use, offered as options so a second project on the same Jira
// site costs a click, not a lookup.
export function siblingValues(profileTexts) {
  const pick = (text, label) => {
    const line = text.split('\n').find(l => new RegExp(`^- *${label}:`).test(l)) || ''
    return (/`([^`]+)`/.exec(line) || [])[1] || null
  }
  const out = { site: new Set(), startStatus: new Set(), mergedStatus: new Set(), human: new Set() }
  for (const t of profileTexts) {
    for (const [k, label] of [['site', 'Site'], ['startStatus', 'Start status'], ['mergedStatus', 'Merged status'], ['human', 'Human']]) {
      const v = pick(t, label)
      if (v && !/TODO|</.test(v)) out[k].add(v)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]))
}

function gateCandidates(dets) {
  const out = [{ value: 'check: *', label: 'every check on the PR head', description: 'Waits for every check run, whatever its name.' }]
  const seen = new Set()
  for (const d of dets) {
    for (const c of d.forge?.requiredChecks?.value || []) {
      if (seen.has(`check: ${c}`)) continue
      seen.add(`check: ${c}`)
      out.push({ value: `check: ${c}`, label: `check ${c}`, description: `Required on ${d.name}/${d.mainBranch.value} (${d.forge.requiredChecks.source}).` })
    }
    for (const b of d.forge?.reviewBots?.value || []) {
      const v = `bot: ${botName(b.login)}`
      if (seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: `review bot ${botName(b.login)}`, description: `Reviewed or commented on ${b.prs} of the last closed PRs in ${d.name}.` })
    }
  }
  return out
}

const evidence = (f) => (f?.value != null ? `${f.value} — ${f.source}` : `not detected: ${f?.reason || 'no data'}`)

// Every decision the profile needs, with options built from the detection. `required` ones block
// a launch while unanswered; the rest render as TODO in sections no launch reads.
export function questions(dets, answers = {}, siblings = {}) {
  const keys = [...new Set(dets.flatMap(d => (d.ticketKeys?.value || []).map(k => k.key)))]
  const qs = [
    { id: 'tracker.kind', required: true, question: 'Which tracker does this project use?',
      options: [
        { value: 'jira', label: 'Jira', description: keys.length ? `Keys seen in branches and commits: ${keys.join(', ')}.` : 'No ticket keys seen in branches or commits.' },
        { value: 'none', label: 'No tracker', description: 'Every run takes --spec <path> instead of a ticket.' }] },
    { id: 'identity.jiraKey', required: true, when: a => a['tracker.kind'] === 'jira', question: 'Which Jira project key do tickets carry?',
      options: keys.map(k => ({ value: k, label: k, description: 'Seen in branch names and commit subjects.' })) },
    { id: 'tracker.site', required: true, when: a => a['tracker.kind'] === 'jira', question: 'Which Jira site (cloudId or host)?',
      options: (siblings.site || []).map(s => ({ value: s, label: s, description: 'Used by another profile.' })) },
    { id: 'tracker.startStatus', required: true, when: a => a['tracker.kind'] === 'jira', question: 'Which status does a started ticket move to?',
      options: (siblings.startStatus || []).map(s => ({ value: s, label: s, description: 'Used by another profile.' })) },
    { id: 'tracker.mergedStatus', required: false, when: a => a['tracker.kind'] === 'jira', question: 'Which status does a ticket move to after merge? (`none` if it stays)',
      options: [...(siblings.mergedStatus || []).map(s => ({ value: s, label: s, description: 'Used by another profile.' })), { value: 'none', label: 'none', description: 'Merge moves nothing.' }] },
    { id: 'branching.integrateMain', required: true, question: 'How does a work branch take main in? Read the written rule (CONTRIBUTING.md) over history.',
      options: [
        { value: 'rebase', label: 'rebase', description: dets.map(d => `${d.name}: ${evidence(d.integrateMain)}`).join('; ') },
        { value: 'merge', label: 'merge commit', description: 'git merge origin/main into the branch.' }] },
    { id: 'gates', required: true, multi: true, question: 'Which gates must be green before a merge? Nothing is waited for unless listed.',
      options: gateCandidates(dets) },
    { id: 'mergeAuthority', required: true, question: 'Who may click merge? Paths can be split later by editing the table.',
      options: [
        { value: 'unconfirmed', label: 'unconfirmed (Recommended)', description: 'Every merge parks with the PR open until someone fills the table. Reversal: none needed.' },
        { value: 'human', label: 'a human, everywhere', description: 'Every merge waits for a person to sign. Reversal: edit one row.' },
        { value: 'agent', label: 'the agent, everywhere', description: 'Merges once gates are green. Wrong here means a merge that cannot be cleanly undone.' }] },
    { id: 'inviolables', required: true, multi: 'text', question: 'Hard stops the resolver may never trade, each with "Source: <where written>". `none` if there are none.', options: [{ value: 'none', label: 'none', description: 'No hard stop.' }] },
    { id: 'escalation.human', required: true, question: 'Which role answers parked decisions and signs?', options: (siblings.human || []).map(h => ({ value: h, label: h, description: 'Used by another profile.' })) },
    { id: 'escalation.doubtLog', required: true, question: 'Where are parked decisions written?',
      options: [{ value: '~/.local/state/tiller/decisions-<date>.md', label: 'daily decisions file', description: 'One file per day, shared with the other profiles.' }] },
    { id: 'runPolicy.dayCeiling', required: true, question: 'Open decisions per day before an unattended day stops?',
      options: [{ value: '10', label: '10', description: 'Conservative start for a new project.' }, { value: '50', label: '50', description: 'What a mature profile runs with.' }] },
    { id: 'runPolicy.maxParallel', required: true, question: 'Tickets at once?',
      options: [{ value: '1', label: '1', description: 'One at a time until the profile has run clean.' }, { value: '2', label: '2', description: 'Needs two local stacks.' }] },
    { id: 'branching.convention', required: !dets.some(d => d.branchConvention?.value), question: 'Which shape do work branch names follow?',
      options: ['<KEY>-<number>-<details>', '<KEY>-<number>', '<type>/<KEY>-<number>-<details>', '<type>/<details>'].map(v => ({ value: v, label: v,
        description: `Detected: ${dets.map(d => `${d.name}: ${evidence(d.branchConvention)}`).join('; ')}` })) },
    { id: 'commits', required: !measuredCommits(dets), question: 'Which commit subject shape do commits on main follow? Any other shape: write `## commits` by hand.',
      options: [
        { value: 'conventional', label: 'Conventional Commits', description: `\`<type>(<scope>): <subject>\`, no ticket. Measured: ${dets.map(d => `${d.name}: ${evidence(d.commitStyle)}`).join('; ')}` },
        { value: 'ticket-bracket', label: '[ticket] Conventional', description: '`[<ticket>] <type>(<scope>): <subject>`, ticket read from the branch name.' }] },
  ]
  for (const d of dets) {
    const deploys = d.workflows.filter(w => w.deploys).map(w => w.file.replace('.github/workflows/', ''))
    qs.push({ id: `repos.${d.name}.mergingMeans`, required: false, question: `What does merging to ${d.mainBranch.value || 'main'} in ${d.name} mean?`,
      options: [
        ...(deploys.length ? [{ value: `triggers ${deploys.join(', ')}`, label: 'deploy workflow runs', description: `Workflows named deploy/publish/release: ${deploys.join(', ')}.` }] : []),
        { value: 'nothing deploys automatically', label: 'nothing deploys', description: 'Release is a separate step.' }] })
  }
  return qs.filter(q => !q.when || q.when(answers)).map(({ when, ...q }) => ({ ...q, answered: answers[q.id] !== undefined }))
}

function table(head, rows) {
  if (!rows.length) return null
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

function gatePredicate(src) {
  if (src === 'check: *') return 'every check run on the PR head has completed with success; none pending'
  if (src.startsWith('check: ')) return `the check ${tick(src.slice(7))} completed with success on the PR head`
  if (src.startsWith('bot: ')) return 'a review by the bot whose commit_id is the PR head, every bot thread answered by a fix or a reasoned rebuttal'
  return 'exit 0'
}

// Check names must be one word and unique per table, or profile-facts.sh refuses the profile with
// `check names repeat` and no answer can repair it. Two packages in one repo share a repo name, so
// the suffix widens: bare, then repo, then repo and package dir, then a counter.
function uniqueChecks(rows) {
  const slug = (s) => String(s).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  const ladder = (r) => {
    const dir = r.p && r.p.dir && r.p.dir !== '.' ? slug(r.p.dir) : ''
    return [r.check, `${r.check}-${slug(r.repo)}`, ...(dir ? [`${r.check}-${slug(r.repo)}-${dir}`] : [])]
  }
  const count = {}
  for (const r of rows) for (const c of ladder(r)) count[c] = (count[c] || 0) + 1
  const taken = new Set()
  return rows.map((r, i) => {
    let name = ladder(r).find(c => count[c] === 1 && !taken.has(c))
    if (!name) {
      const last = ladder(r)[ladder(r).length - 1]
      name = `${last}-${i + 1}`
      while (taken.has(name)) name = `${name}x`
    }
    taken.add(name)
    return { ...r, check: name }
  })
}

// Roles of config/tool-kinds.json other than the tracker, whose kind `## tracker` sets. The CLI
// passes the list it reads from the config; this is the fallback for a caller that does not.
const TOOL_ROLES = ['chat', 'docs', 'calendar', 'email']

// The commit style every measured repo agrees on, when `## commits` can express it.
function measuredCommits(dets) {
  const kinds = [...new Set(dets.map(d => d.commitStyle?.kind).filter(Boolean))]
  return kinds.length === 1 && dets.every(d => d.commitStyle?.kind) && ['conventional', 'ticket-bracket'].includes(kinds[0]) ? kinds[0] : null
}

// Headings of the template, in order. A generated section the template does not carry (worktree
// setup) goes after the section it follows in `rendered`; a template heading this file has no
// renderer for is an error, so a schema change surfaces here instead of as a silently dropped section.
function sectionOrder(template, rendered) {
  if (!template) return rendered
  const order = (template.match(/^## .*$/gm) || []).map(h => h.slice(3).trim())
  const unknown = order.filter(h => !rendered.includes(h))
  if (unknown.length) throw new Error(`the template has ${unknown.map(h => `\`## ${h}\``).join(', ')}, which lib/onboard/profile.mjs does not render`)
  rendered.forEach((h, i) => {
    if (order.includes(h)) return
    const prev = rendered.slice(0, i).reverse().find(x => order.includes(x))
    order.splice(prev ? order.indexOf(prev) + 1 : order.length, 0, h)
  })
  return order
}

export function render({ name, project, globs, dets, answers = {}, today, template, toolRoles = TOOL_ROLES }) {
  const a = (k) => answers[k]
  const todo = (k, hint) => (a(k) !== undefined ? a(k) : `TODO${hint ? ` — ${hint}` : ''}`)
  const m = dets.map(d => d.measured).sort()[0] || today
  const repoCell = (d, dir) => tick(d.name) + (dir && dir !== '.' ? ' ' + tick(dir) : '')
  const sections = new Map()
  const sec = (h, ...body) => sections.set(h, body.filter(x => x != null).join('\n'))

  const kind = a('tracker.kind')
  sec('identity', `- Project: ${project || name}`,
    `- Jira project key: ${kind === 'none' ? 'none' : a('identity.jiraKey') ? tick(a('identity.jiraKey')) : 'TODO'}`,
    '- Board: not recorded')
  sec('tracker', kind === 'none' ? '- Kind: `none`' : [
    `- Kind: ${kind ? tick(kind) : 'TODO'}`,
    `- Site: ${a('tracker.site') ? tick(a('tracker.site')) : 'TODO'}`,
    `- Start status: ${a('tracker.startStatus') ? tick(a('tracker.startStatus')) : 'TODO'}`,
    `- Merged status: ${a('tracker.mergedStatus') ? (a('tracker.mergedStatus') === 'none' ? 'none' : tick(a('tracker.mergedStatus'))) : 'TODO'}`,
    '- QA statuses: TODO — backticked statuses in which a ticket waits for verification, or none',
  ].join('\n'))
  sec('tools', 'Defaults from `config/tool-kinds.json`; change a row when the project uses another tool. The tracker\'s kind is set above.', '',
    table(['Role', 'Kind', 'Server'], toolRoles.map(r => [r, 'default', 'default'])))
  sec('ticket conventions', 'none — the tracker\'s own required fields are the whole convention until a written guide is copied here.')
  sec('board', 'none — flow-pm audits and writes nothing.')

  sec('repos', table(['Repo', 'Local path', 'Role', 'Main', 'Merging to main means'], dets.map(d => [
    tick(d.name), tick(tilde(d.path)), cell(d.forge?.description) || '—',
    d.mainBranch.value ? tick(d.mainBranch.value) : 'TODO', a(`repos.${d.name}.mergingMeans`) || 'TODO'])),
  '', `Main branches read from each clone's \`origin/HEAD\` (measured ${m}).`)

  const conv = dets.find(d => d.branchConvention?.value)?.branchConvention
  const integ = a('branching.integrateMain')
  const workspace = [...new Set(dets.flatMap(d => d.workspaceInstructions?.value || []))]
  sec('branching',
    `- Convention: ${a('branching.convention') ? `${tick(a('branching.convention'))} — answered at onboarding` : conv ?`${conv.value} — ${conv.source} (measured ${m})` : 'TODO — no branch shape covers half of the work branches'}`,
    '- Worktrees: `none`',
    `- Integrating main: ${integ === 'rebase' ? 'rebase onto an up-to-date main' : integ === 'merge' ? 'merge commit of main into the branch' : `TODO — history says ${dets.map(d => evidence(d.integrateMain)).join('; ')}`}`,
    `- Workspace-level git restrictions: ${workspace.length ? workspace.map(p => tick(tilde(p))).join(', ') + ' — read before any git operation' : '`none`'}`)

  const convLines = dets.flatMap(d => (d.conventions?.value || []).map(doc => `- ${tick(d.name + '/' + doc)}`))
  sec('conventions', convLines.length ? convLines.join('\n') : 'none found in the repos (measured ' + m + ')')
  sec('decision ledger', '`docs/superpowers/decisions/<TICKET>.md` unless this project says otherwise.')

  const who = a('mergeAuthority') || 'unconfirmed'
  sec('merge authority',
    who === 'unconfirmed' ? '`unconfirmed` — every merge parks with the PR open on the ready-to-sign list until this table is\nfilled. Do not delete this line to make a run go through; fill the table instead.\n' : null,
    table(['Path', 'Who merges'], [['`**` everything', tick(who)]]))

  const envs = [...new Set(dets.flatMap(d => d.forge?.environments?.value || []))]
  const deployWf = dets.flatMap(d => d.workflows.filter(w => w.deploys).map(w => `${d.name}/${w.file.replace('.github/workflows/', '')}`))
  sec('environments',
    `- Hosts: TODO${envs.length ? ` — GitHub environments: ${envs.map(tick).join(', ')}` : ''}`,
    `- Surface map: ${deployWf.length ? `TODO — deploy workflows: ${deployWf.map(tick).join(', ')}` : 'TODO'}`,
    '- Deployed SHA: TODO', '- Test users: TODO — where credentials live, never their values', '- QA browser: `none`')

  const pkgs = dets.flatMap(d => d.toolchain.packages.map(p => ({ d, p })))
  const multi = dets.length > 1
  // The path is run by bash later; one outside this set is left for a human to write.
  const inRepo = (d, cmd) => (!multi ? cmd : /^[\w./ -]+$/.test(d.path) ? `cd "${tilde(d.path).replace(/^~/, '$HOME')}" && ${cmd}` : 'TODO')
  const testRows = pkgs.flatMap(({ d, p }) => p.test.map(([lane, cmd]) => [`${lane} (${d.name}${p.dir !== '.' ? '/' + p.dir : ''})`, p.ecosystem, tick(inRepo(d, cmd)), `${tick(p.install)} exited 0 first`]))
  const e2e = pkgs.flatMap(({ d, p }) => p.e2e.map(c => `${d.name}: ${tick(c)}`))
  const unlocked = dets.flatMap(d => (d.toolchain.unlocked || []).map(f => `${d.name}/${f}`))
  sec('test toolchain', table(['Lane', 'Runner', 'Command', 'Proof gate before judging'], testRows)
    || (unlocked.length ? `TODO — no lockfile beside ${unlocked.map(tick).join(', ')}, so no command could be read from the clone` : 'none — no test script detected'),
    e2e.length ? `\n- Environment-bound suites, not run until \`## environments\` names a host: ${e2e.join(', ')}.` : null)

  const setup = uniqueChecks(pkgs.map(({ d, p }) => ({ repo: d.name, d, p, check: 'install', cmd: p.install })))
  sec('worktree setup', table(['Repo', 'Check', 'Command'], setup.map(r => [repoCell(r.d, r.p.dir), r.check, tick(r.cmd)])) || 'none')
  const stat = uniqueChecks(pkgs.flatMap(({ d, p }) => p.static.map(([check, cmd]) => ({ repo: d.name, d, p, check, cmd }))))
  sec('static checks', table(['Repo', 'Check', 'Command'], stat.map(r => [repoCell(r.d, r.p.dir), r.check, tick(r.cmd)])) || 'none')

  const gen = dets.flatMap(d => d.toolchain.generated.map(([glob, cmd]) => [tick(d.name), tick(glob), tick(cmd)]))
  const derived = dets.flatMap(d => d.toolchain.derivedUnknown.map(f => tick(`${d.name}/${f}`)))
  sec('generated files', table(['Repo', 'Glob', 'Command'], gen) || 'none',
    derived.length ? `\n- Derived-looking, regenerate command unknown, so unlisted — a conflict in one is a question: ${derived.join(', ')}.` : null)

  const gates = a('gates')
  sec('gates', 'Declared here, never inferred from CI. Rows confirmed by a human at onboarding.', '',
    table(['Gate', 'Source', 'Pass predicate'], gates?.length
      ? gates.map(src => [src === 'check: *' ? 'ci' : src.startsWith('bot: ') ? `review-${src.slice(5).replace(/\[bot\]$/, '').replace(/[^\w-]/g, '')}` : src.replace(/^check: /, ''), tick(src), gatePredicate(src)])
      : [['TODO', 'TODO', 'TODO']]),
    gates?.length ? null : `\n- Candidates detected: ${gateCandidates(dets).map(c => tick(c.value)).join(', ')}.`)

  sec('run policy',
    `- Day ceiling: ${todo('runPolicy.dayCeiling')}`, `- Max parallel: ${todo('runPolicy.maxParallel')}`,
    '- Fix rounds: 2', '- CI fix rounds: 2', '- Ceiling exclusions: none', '- Stop hour: none',
    '- Force-push after rebase: never', '- Locked artefacts: none')

  const inv = a('inviolables')
  sec('inviolables', inv === undefined ? 'TODO' : (inv === 'none' || (Array.isArray(inv) && inv.join('') === 'none')) ? 'none'
    : (Array.isArray(inv) ? inv : [inv]).map((x, i) => `${i + 1}. ${x}`).join('\n'))
  sec('owner proxy', 'none — no unattended day run until someone grants a mandate here by hand.')
  const doubt = a('escalation.doubtLog')
  sec('escalation', `- Doubt log: ${doubt ? tick(doubt) : 'TODO'}`, `- Human: ${todo('escalation.human')}`)
  sec('model routing', 'none')
  sec('release', deployWf.length ? `- TODO — deploy workflows detected: ${deployWf.map(tick).join(', ')}` : '- TODO')
  sec('known issues', '- TODO')
  sec('verification register', 'none')
  sec('wayfinding', 'none')

  const style = a('commits') || measuredCommits(dets)
  const styleSource = dets.filter(d => d.commitStyle).map(d => (dets.length > 1 ? `${d.name}: ` : '') + (d.commitStyle.value ? d.commitStyle.source : `not read: ${d.commitStyle.reason}`)).join('; ')
  const key = a('identity.jiraKey') || dets.flatMap(d => d.ticketKeys?.value || [])[0]?.key
  sec('commits', style === 'conventional'
    ? `none — plain Conventional Commits${a('commits') ? ', answered at onboarding' : `, ${styleSource} (measured ${m})`}`
    : style === 'ticket-bracket'
      ? [`- Format: ${tick('[<ticket>] <type>(<scope>): <subject>')}`,
        `- Ticket from branch: ${tick(key ? `${key}-[0-9]+` : '[A-Z][A-Z0-9]+-[0-9]+')}`,
        `- Without ticket: ${tick('<type>(<scope>): <subject>')}`,
        '', a('commits') ? 'Answered at onboarding.' : `Measured on main: ${styleSource} (measured ${m}).`].join('\n')
      : ['- Format: TODO — answer the commits question', '', `Measured on main: ${styleSource || 'nothing read'} (measured ${m}).`].join('\n'))

  const out = ['---', `profile: ${name}`, 'schema_version: 2',
    `onboarding: generated — lib/onboard/onboard.mjs render ${name} rewrites this file; delete this line to edit by hand`,
    'repo_globs:', ...globs.map(g => `  - "${g}"`), '---', '',
    `# Profile — ${project || name}`, '',
    `Facts only, never procedure. Detected facts come from \`detected.json\` next to this file (measured ${m}),`,
    'decisions from `answers.json`. Re-render instead of editing while the line above stands.',
    'No secret values here: tokens and access codes go in `secrets.env` next to this file.', '']
  for (const h of sectionOrder(template, [...sections.keys()])) out.push(`## ${h}`, '', sections.get(h), '')
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

// Refuse anything that looks like a credential before it lands in a profile meant to be shared.
// Best effort: known token formats only, so a plain password still gets through.
const SECRETS = [
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['API key', /\bsk[-_][A-Za-z0-9_-]{20,}/],
  ['Atlassian token', /ATATT[A-Za-z0-9_=-]{20,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['GitLab token', /glpat-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
]
// Names the kind only: echoing characters of the value would put part of it in a transcript.
export function secretIn(text) { return (SECRETS.find(([, re]) => re.test(text)) || [])[0] || null }

// Free text read from the forge goes into a table cell: one line, no column or code-span breaks.
const cell = (s) => (s ? String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[|`]/g, '').trim() : '')
