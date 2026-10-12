// Harness roles are skills, and `claude -p --agent` never sees a skill. A lane that names a role gets
// the role built from its SKILL.md and config/agents.json; each runtime adapter translates it.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeAgent } from './adapters/claude.mjs'
import { resolveTools } from './adapters/tools.mjs'

export const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// `profileTools` is the facts object's `tools`; without it every role resolves to its default kind.
export function roleSpec(name, core = CORE_ROOT, profileTools = {}) {
  const spec = JSON.parse(readFileSync(join(core, 'config', 'agents.json'), 'utf8'))[name]
  if (!spec) return null
  const path = join(core, 'skills', name, 'SKILL.md')
  if (!existsSync(path)) throw new Error(`config/agents.json names ${name} but ${path} does not exist`)
  const md = readFileSync(path, 'utf8')
  const m = md.match(/^---\n([\s\S]*?)\n---\n/)
  const description = m && (m[1].match(/^description: (.*)$/m) || [])[1]
  if (!description) throw new Error(`${path} has no frontmatter description to build an agent from`)
  return {
    name,
    description,
    // Auto permission mode refuses a Bash command that expands a variable, so the path goes in literally.
    systemPrompt: `\`$TILLER_HOME\` in the instructions below is \`${core}\`. Write that path literally in every command.\n\n` + md.slice(m[0].length),
    tools: resolveTools(spec.tools, profileTools),
    ...(spec.model ? { model: spec.model } : {}),
  }
}

export function agentDefinition(name, core = CORE_ROOT, profileTools = {}) {
  const role = roleSpec(name, core, profileTools)
  return role && claudeAgent(role)
}
