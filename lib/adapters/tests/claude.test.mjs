import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_HEADER, claudeTargets, legacyHooks } from '../claude.mjs'
import { readLayers, resolve } from '../../apply/layers.mjs'
import { InvalidNativeFile, plan } from '../../apply/merge.mjs'
import { cleanEnv, makeHome } from '../../testing/private-access.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolvePath(HERE, '..', '..', '..')
const CONFIG = '/home/user/.claude'

function desiredFor(personalDir, vars = { TILLER_HOME: '/opt/tiller', HOME: '/home/user' }) {
  const stateHome = join(mkdtempSync(join(tmpdir(), 'claude-adapter-')), 'state')
  return resolve(readLayers({ tillerHome: REPO, personalDir, stateHome }), { vars })
}

const render = (target, current = null, entry = null) => plan(target, current, entry, [])

test('golden: base plus a personal layer renders settings.json and CLAUDE.md', () => {
  const [settings, block] = claudeTargets(desiredFor(join(HERE, 'fixtures', 'personal')), { configDir: CONFIG })
  assert.equal(settings.path, join(CONFIG, 'settings.json'))
  assert.equal(block.path, join(CONFIG, 'CLAUDE.md'))
  assert.equal(render(settings).next.text, readFileSync(join(HERE, 'golden', 'claude', 'settings.json'), 'utf8'))
  assert.equal(render(block).next.text, readFileSync(join(HERE, 'golden', 'claude', 'CLAUDE.md'), 'utf8'))
})

test('an empty personal layer leaves only the tracked header in the block', () => {
  const [, block] = claudeTargets(desiredFor(null), { configDir: CONFIG })
  assert.equal(block.body, BLOCK_HEADER)
  assert.equal(render(block).next.text, `<!-- tiller:begin -->\n${BLOCK_HEADER}\n<!-- tiller:end -->\n`)
})

test('the rendered hook command runs under sh with a TILLER_HOME that contains a space', () => {
  const { base, home, cwd } = makeHome()
  symlinkSync(join(REPO, 'lib'), join(home, 'lib'))
  const desired = { env: {}, hooks: [{ id: 'private-access', event: 'preToolUse', kinds: ['read'], command: `${home}/lib/hooks/private-access.sh` }], native: {}, instructions: { body: '' } }
  const group = claudeTargets(desired, { configDir: CONFIG })[0].items.find(i => i.id === 'hook:PreToolUse:private-access').value
  const command = group.hooks[0].command
  assert.match(command, /^TILLER_HOOK=private-access '/)
  const env = cleanEnv({
    HOME: base, TILLER_HOME: home, PATH: `/usr/bin:/bin:/opt/homebrew/bin:${dirname(process.execPath)}`,
    CLAUDE_CONFIG_DIR: undefined, COPILOT_HOME: undefined,
  })
  const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/srv/x' }, cwd: cwd.none })
  const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', input: payload, env })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /not found|No such file/)
  assert.equal(r.stdout, '')
})

test('a user hook and a user env key survive, byte-identical in their JSON', () => {
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook --flag' }] }
  const current = JSON.stringify({ env: { MINE: 'x' }, hooks: { PreToolUse: [userHook] } }, null, 2) + '\n'
  const [settings] = claudeTargets(desiredFor(null), { configDir: CONFIG })
  const out = JSON.parse(render(settings, current).next.text)
  assert.equal(JSON.stringify(out.hooks.PreToolUse[0]), JSON.stringify(userHook))
  assert.equal(out.env.MINE, 'x')
  assert.equal(out.hooks.PreToolUse.length, 2)
})

test('native.claude contributes one item per leaf pointer', () => {
  const desired = { env: {}, hooks: [], native: { claude: { a: { b: 1, c: [1] }, 'x/y': true } }, instructions: { body: '' } }
  const [settings] = claudeTargets(desired, { configDir: CONFIG })
  assert.deepEqual(settings.items.map(i => i.id), ['/a/b', '/a/c', '/x~1y'])
})

test('text outside the markers is kept byte for byte and a CRLF file stays CRLF', () => {
  const [, block] = claudeTargets(desiredFor(null), { configDir: CONFIG })
  const before = '# Mine\r\nkeep  this \r\n'
  const after = '\r\ntail\r\n'
  const first = render(block, before + after)
  assert.ok(first.next.text.startsWith(before + after), 'appended after the existing text')
  assert.ok(!/[^\r]\n/.test(first.next.text), 'every line ending is CRLF')
  const edited = before + `<!-- tiller:begin -->\r\nold\r\n<!-- tiller:end -->\r\n` + after
  const r = render(block, edited, { kind: 'block', items: {} })
  assert.equal(r.drift[0]?.reason, 'unowned-differs')
  const overwritten = plan(block, edited, { kind: 'block', items: {} }, [], { block: 'overwrite' }).next.text
  assert.equal(overwritten, before + `<!-- tiller:begin -->\r\n${BLOCK_HEADER}\r\n<!-- tiller:end -->\r\n` + after)
})

test('the block is appended after one blank line and a re-plan changes nothing', () => {
  const [, block] = claudeTargets(desiredFor(null), { configDir: CONFIG })
  const first = render(block, '# Mine\n')
  assert.equal(first.next.text, `# Mine\n\n<!-- tiller:begin -->\n${BLOCK_HEADER}\n<!-- tiller:end -->\n`)
  const again = plan(block, first.next.text, { kind: 'block', items: first.next.items }, [])
  assert.deepEqual([again.changes, again.drift, again.write], [[], [], false])
})

test('malformed markers are refused', () => {
  const [, block] = claudeTargets(desiredFor(null), { configDir: CONFIG })
  const B = '<!-- tiller:begin -->', E = '<!-- tiller:end -->'
  for (const text of [`${B}\nx\n`, `${B}\n${B}\n${E}\n`, `${E}\n${B}\n`, `x\n${E}\n`]) {
    assert.throws(() => render(block, text), InvalidNativeFile, text)
  }
})

test('legacyHooks finds a hand-merged private-access hook and ignores tiller\'s own', () => {
  const legacy = "TILLER_HOME=/a\\ b/tiller /a\\ b/tiller/lib/hooks/private-access.sh"
  const settings = {
    hooks: { PreToolUse: [
      { matcher: 'Read', hooks: [{ type: 'command', command: legacy }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: "TILLER_HOOK=private-access '/t/lib/hooks/private-access.sh'" }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] },
    ] },
  }
  assert.deepEqual(legacyHooks(settings), [legacy])
  assert.deepEqual(legacyHooks(JSON.stringify(settings)), [legacy])
  assert.deepEqual(legacyHooks({}), [])
})
