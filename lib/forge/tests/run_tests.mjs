// Runs every *.test.mjs in this directory as its own process (each owns its stub PATH) and
// fails loudly if any of them exit non-zero.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort()

let failed = 0
for (const f of files) {
  console.log(`== ${f}`)
  const r = spawnSync(process.execPath, [join(HERE, f)], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
console.log(failed ? `FAIL: ${failed} of ${files.length} test files failed` : `PASS: ${files.length} test files`)
process.exit(failed ? 1 : 0)
