// The skills every agent gets linked: tiller's tracked skills plus the person's own. Profile skills
// stay with `install.sh --profile`.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const skillsIn = dir => (existsSync(dir) ? readdirSync(dir) : [])
  .filter(name => existsSync(join(dir, name, 'SKILL.md')))
  .map(name => ({ name, source: join(dir, name) }))

export function desiredSkills({ tillerHome, personalDir }) {
  const byName = new Map()
  for (const s of [...skillsIn(join(tillerHome, 'skills')), ...(personalDir ? skillsIn(join(personalDir, 'skills')) : [])]) {
    byName.set(s.name, s)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

// Where each agent looks for skills on this machine; `apply --adopt` reads them for foreign skills.
export function skillRoots(agent, { configDir, home }) {
  return agent === 'copilot' ? [join(home, '.agents', 'skills'), join(configDir, 'skills')] : [join(configDir, 'skills')]
}
