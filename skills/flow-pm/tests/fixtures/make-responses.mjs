// Writes the tracker responses the blocker-check tests read, in the shape searchJiraIssuesUsingJql spills.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2] || dirname(fileURLToPath(import.meta.url))
const n = (key, name, cat) => ({ key, fields: { status: { name, statusCategory: { key: cat } } } })
const write = (file, nodes) => writeFileSync(join(out, file), JSON.stringify({ issues: { nodes } }))

const ok = [n('FIX-1', 'Done', 'done'), n('FIX-2', 'In Progress', 'indeterminate'), n('FIX-3', "Won't Do", 'done'), n('FIX-4', 'Done', 'done')]
write('resp-ok.json', ok)
write('resp-no-canary.json', ok.slice(1))
write('resp-canary-open.json', [n('FIX-1', 'In Progress', 'indeterminate'), ...ok.slice(1)])
write('resp-extra.json', [...ok, n('FIX-99', 'Done', 'done')])
write('resp-null-category.json', [ok[0], ok[1], { key: 'FIX-3', fields: { status: { name: "Won't Do" } } }, ok[3]])
write('resp-all-open.json', [ok[0], ok[1], n('FIX-3', 'In QA', 'indeterminate'), n('FIX-4', 'In QA', 'indeterminate')])
