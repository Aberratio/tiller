// Copilot CLI targets for the neutral desired state: tiller's own hooks file, owned items in the
// JSON-with-comments settings.json, and the managed block in copilot-instructions.md.
import { join } from 'node:path'
import { BLOCK_HEADER, leaves, shQuote } from './claude.mjs'

// PascalCase hooks match on Claude tool names, which Copilot maps from its own tools.
const KINDS = { read: ['Read'], search: ['Grep', 'Glob'], write: ['Edit', 'Write'], shell: ['Bash'] }

function hookEntry(hook, env, tillerHome) {
  const matcher = hook.kinds.map(k => {
    if (!KINDS[k]) throw new Error(`hook ${hook.id}: unknown kind "${k}"`)
    return KINDS[k].join('|')
  }).join('|')
  const event = hook.event[0].toUpperCase() + hook.event.slice(1)
  // Copilot reads a PreToolUse decision at the top level, so a Claude-format hook runs behind a translator.
  const bash = event === 'PreToolUse'
    ? `${shQuote(join(tillerHome, 'lib', 'hooks', 'copilot-pretooluse.sh'))} ${shQuote(hook.command)}`
    : shQuote(hook.command)
  const entry = { type: 'command', matcher, bash }
  if (Object.keys(env).length) entry.env = { ...env }
  return { event, entry }
}

export function copilotTargets(desired, { configDir, tillerHome }) {
  const env = desired.env ?? {}
  const byEvent = new Map()
  for (const hook of desired.hooks ?? []) {
    const { event, entry } = hookEntry(hook, env, tillerHome)
    byEvent.set(event, [...(byEvent.get(event) ?? []), entry])
  }
  const hookItems = byEvent.size
    ? [{ id: '/version', value: 1 }, ...[...byEvent].map(([event, entries]) => ({ id: `/hooks/${event}`, value: entries }))]
    : []
  const body = desired.instructions?.body ? `${BLOCK_HEADER}\n${desired.instructions.body}` : BLOCK_HEADER
  return [
    { path: join(configDir, 'hooks', 'tiller.json'), kind: 'json', items: hookItems },
    { path: join(configDir, 'settings.json'), kind: 'jsonc', items: leaves(desired.native?.copilot ?? {}) },
    { path: join(configDir, 'copilot-instructions.md'), kind: 'block', body },
  ]
}

// Copilot has no global env setting; hooks get env per entry and the shell gets these lines.
export const copilotEnvLines = desired => Object.entries(desired.env ?? {}).map(([k, v]) => `export ${k}=${shQuote(v)}`)
