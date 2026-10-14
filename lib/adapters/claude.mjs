// Claude Code targets for the neutral desired state: owned items in <configDir>/settings.json, the
// managed block in <configDir>/CLAUDE.md, skill links and rendered role agents.
import { join } from 'node:path'
import { indentOf } from '../apply/merge.mjs'
import { renderAgentFile } from '../agents/install-agents.mjs'
import { desiredSkills } from './skills.mjs'

export const BLOCK_HEADER =
  '<!-- Managed by tiller apply from personal/<user>/instructions.md; an edit inside this block is reported as drift. -->'

const KINDS = { read: ['Read'], search: ['Grep', 'Glob'], write: ['Edit', 'Write', 'NotebookEdit'], shell: ['Bash'] }

export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`
export const forwardSlashes = s => String(s).replace(/\\/g, '/')

// Windows runs no script by its shebang, so a hook names Git Bash and hands it the script.
export function shellCommand(args, { platform, shell } = {}) {
  if (platform !== 'win32') return args.map(shQuote).join(' ')
  if (!shell) throw new Error('a hook on Windows needs Git Bash')
  return [shell.posixPath, ...args].map(a => shQuote(forwardSlashes(a))).join(' ')
}
const escapePointer = s => s.replace(/~/g, '~0').replace(/\//g, '~1')
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export function leaves(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const pointer = `${prefix}/${escapePointer(k)}`
    if (isPlain(v)) out.push(...leaves(v, pointer))
    else out.push({ id: pointer, value: v })
  }
  return out
}

function hookItem(hook, opts) {
  const event = hook.event[0].toUpperCase() + hook.event.slice(1)
  const matcher = hook.kinds.map(k => {
    if (!KINDS[k]) throw new Error(`hook ${hook.id}: unknown kind "${k}"`)
    return KINDS[k].join('|')
  }).join('|')
  // Claude hook entries have no id field; the command prefix is how tiller finds its own entry again.
  const command = `TILLER_HOOK=${hook.id} ${shellCommand([hook.command], opts)}`
  return { id: `hook:${event}:${hook.id}`, value: { matcher, hooks: [{ type: 'command', command }] } }
}

export function claudeTargets(desired, { configDir, platform, shell }) {
  const items = [
    ...Object.entries(desired.env ?? {}).map(([k, v]) => ({ id: `/env/${escapePointer(k)}`, value: v })),
    ...(desired.hooks ?? []).map(h => hookItem(h, { platform, shell })),
    ...leaves(desired.native?.claude ?? {}),
  ]
  const body = desired.instructions?.body ? `${BLOCK_HEADER}\n${desired.instructions.body}` : BLOCK_HEADER
  return [
    { path: join(configDir, 'settings.json'), kind: 'json', items },
    { path: join(configDir, 'CLAUDE.md'), kind: 'block', body },
  ]
}

export function claudeLinks(desired, { configDir, tillerHome, personalDir = null }) {
  return [
    ...desiredSkills({ tillerHome, personalDir }).map(({ name, source }) =>
      ({ kind: 'skill', mode: 'symlink', name, dest: join(configDir, 'skills', name), source })),
    ...(desired.agents ?? []).map(name => {
      const text = renderAgentFile(name, tillerHome)
      if (text == null) throw new Error(`role agent ${name} is not in config/agents.json`)
      return { kind: 'agent', mode: 'rendered', name, dest: join(configDir, 'agents', `${name}.md`), text }
    }),
  ]
}

// Entries left by the old hand merge (`TILLER_HOME=… private-access.sh`): a user hook to tiller,
// but it runs the same check a second time.
const isLegacy = c => typeof c === 'string' && /private-access\.sh/.test(c) && !c.startsWith('TILLER_HOOK=')

export function legacyHooks(settings) {
  const doc = typeof settings === 'string' ? JSON.parse(settings) : settings
  const groups = isPlain(doc?.hooks) && Array.isArray(doc.hooks.PreToolUse) ? doc.hooks.PreToolUse : []
  return groups.flatMap(g => (Array.isArray(g?.hooks) ? g.hooks : [])).map(h => h?.command).filter(isLegacy)
}

// Drops the legacy entries, and any group they leave empty, keeping the file's indent and newline.
export function withoutLegacyHooks(text) {
  const doc = JSON.parse(text)
  doc.hooks.PreToolUse = doc.hooks.PreToolUse
    .map(g => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter(h => !isLegacy(h?.command)) } : g))
    .filter(g => !Array.isArray(g?.hooks) || g.hooks.length)
  return JSON.stringify(doc, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '')
}
