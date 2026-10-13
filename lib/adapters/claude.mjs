// Claude Code targets for the neutral desired state: owned items in <configDir>/settings.json and
// the managed block in <configDir>/CLAUDE.md.
import { join } from 'node:path'

export const BLOCK_HEADER =
  '<!-- Managed by tiller apply from personal/<user>/instructions.md; an edit inside this block is reported as drift. -->'

const KINDS = { read: ['Read'], search: ['Grep', 'Glob'], write: ['Edit', 'Write', 'NotebookEdit'], shell: ['Bash'] }

export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const escapePointer = s => s.replace(/~/g, '~0').replace(/\//g, '~1')
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function leaves(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const pointer = `${prefix}/${escapePointer(k)}`
    if (isPlain(v)) out.push(...leaves(v, pointer))
    else out.push({ id: pointer, value: v })
  }
  return out
}

function hookItem(hook) {
  const event = hook.event[0].toUpperCase() + hook.event.slice(1)
  const matcher = hook.kinds.map(k => {
    if (!KINDS[k]) throw new Error(`hook ${hook.id}: unknown kind "${k}"`)
    return KINDS[k].join('|')
  }).join('|')
  // Claude hook entries have no id field; the command prefix is how tiller finds its own entry again.
  const command = `TILLER_HOOK=${hook.id} ${shQuote(hook.command)}`
  return { id: `hook:${event}:${hook.id}`, value: { matcher, hooks: [{ type: 'command', command }] } }
}

export function claudeTargets(desired, { configDir }) {
  const items = [
    ...Object.entries(desired.env ?? {}).map(([k, v]) => ({ id: `/env/${escapePointer(k)}`, value: v })),
    ...(desired.hooks ?? []).map(hookItem),
    ...leaves(desired.native?.claude ?? {}),
  ]
  const body = desired.instructions?.body ? `${BLOCK_HEADER}\n${desired.instructions.body}` : BLOCK_HEADER
  return [
    { path: join(configDir, 'settings.json'), kind: 'json', items },
    { path: join(configDir, 'CLAUDE.md'), kind: 'block', body },
  ]
}

// Entries left by the old hand merge (`TILLER_HOME=… private-access.sh`): a user hook to tiller,
// but it runs the same check a second time.
export function legacyHooks(settings) {
  const doc = typeof settings === 'string' ? JSON.parse(settings) : settings
  const groups = isPlain(doc?.hooks) && Array.isArray(doc.hooks.PreToolUse) ? doc.hooks.PreToolUse : []
  return groups.flatMap(g => (Array.isArray(g?.hooks) ? g.hooks : []))
    .map(h => h?.command)
    .filter(c => typeof c === 'string' && /private-access\.sh/.test(c) && !c.startsWith('TILLER_HOOK='))
}
