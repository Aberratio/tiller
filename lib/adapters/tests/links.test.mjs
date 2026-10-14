import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeLinks } from '../claude.mjs'
import { copilotLinks, renderCopilotAgent } from '../copilot.mjs'
import { desiredSkills } from '../skills.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, 'fixtures', 'core')
const DESIRED = { agents: ['flow-demo'] }

function personal() {
  const dir = mkdtempSync(join(tmpdir(), 'personal-skills-'))
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(dir, 'skills', name), { recursive: true })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: personal ${name}\n---\n`)
  }
  return dir
}

// The prompt names the core path, which differs per checkout.
const golden = (text, name) =>
  assert.equal(text.split(CORE).join('<core>'), readFileSync(join(HERE, 'golden', name), 'utf8'), name)

test('desired skills: tracked dirs with a SKILL.md, personal ones added, personal wins a name clash', () => {
  const p = personal()
  assert.deepEqual(desiredSkills({ tillerHome: CORE, personalDir: p }), [
    { name: 'alpha', source: join(p, 'skills', 'alpha') },
    { name: 'beta', source: join(p, 'skills', 'beta') },
    { name: 'flow-demo', source: join(CORE, 'skills', 'flow-demo') },
  ])
  assert.deepEqual(desiredSkills({ tillerHome: CORE, personalDir: null }).map(s => s.name), ['alpha', 'flow-demo'])
  assert.deepEqual(desiredSkills({ tillerHome: CORE, personalDir: join(p, 'missing') }).map(s => s.name), ['alpha', 'flow-demo'])
})

test('Claude Code: skill links in <dir>/skills, role agents rendered into <dir>/agents/<name>.md', () => {
  const links = claudeLinks(DESIRED, { configDir: '/h/.claude', tillerHome: CORE, personalDir: null })
  assert.deepEqual(links.filter(l => l.kind === 'skill'), [
    { kind: 'skill', mode: 'symlink', name: 'alpha', dest: '/h/.claude/skills/alpha', source: join(CORE, 'skills', 'alpha') },
    { kind: 'skill', mode: 'symlink', name: 'flow-demo', dest: '/h/.claude/skills/flow-demo', source: join(CORE, 'skills', 'flow-demo') },
  ])
  const [agent] = links.filter(l => l.kind === 'agent')
  assert.equal(agent.mode, 'rendered')
  assert.equal(agent.dest, '/h/.claude/agents/flow-demo.md')
  golden(agent.text, 'claude/flow-demo.md')
})

test('Copilot CLI: skill links in ~/.agents/skills, role agents rendered into <dir>/agents/<name>.agent.md', () => {
  const links = copilotLinks(DESIRED, { configDir: '/h/.copilot', home: '/h', tillerHome: CORE, personalDir: null })
  assert.deepEqual(links.filter(l => l.kind === 'skill').map(l => l.dest), ['/h/.agents/skills/alpha', '/h/.agents/skills/flow-demo'])
  const [agent] = links.filter(l => l.kind === 'agent')
  assert.equal(agent.mode, 'rendered')
  assert.equal(agent.dest, '/h/.copilot/agents/flow-demo.agent.md')
  golden(agent.text, 'copilot/flow-demo.agent.md')
})

test('no desired agents: only skill links', () => {
  assert.deepEqual(claudeLinks({}, { configDir: '/h/.claude', tillerHome: CORE }).map(l => l.kind), ['skill', 'skill'])
})

test('an unknown role refuses, naming it', () => {
  assert.throws(() => claudeLinks({ agents: ['flow-nope'] }, { configDir: '/h/.claude', tillerHome: CORE }), /flow-nope/)
  assert.throws(() => renderCopilotAgent('flow-nope', CORE), /flow-nope/)
})

test('a Copilot agent body over 30,000 characters refuses', () => {
  const core = mkdtempSync(join(tmpdir(), 'core-'))
  mkdirSync(join(core, 'config'))
  mkdirSync(join(core, 'skills', 'flow-big'), { recursive: true })
  writeFileSync(join(core, 'config', 'agents.json'), JSON.stringify({ 'flow-big': { tools: ['read'] } }))
  writeFileSync(join(core, 'skills', 'flow-big', 'SKILL.md'), `---\nname: flow-big\ndescription: big\n---\n${'x'.repeat(30001)}\n`)
  assert.throws(() => renderCopilotAgent('flow-big', core), /30,000/)
})

test('the real roles render for Copilot under the size limit', () => {
  const core = join(HERE, '..', '..', '..')
  for (const name of ['flow-resolver', 'flow-owner-proxy', 'flow-pm']) assert.match(renderCopilotAgent(name, core), /^---\nname: /)
})
