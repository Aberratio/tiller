// render(request, target) -> string. Pure templating over one hitl-request: the same JSON gives the same bytes
// whichever agent tool produced it. Targets: 'markdown' (file, tracker or PR comment), 'terminal' (80 columns,
// no markup), 'forge-comment' (markdown with the glossary collapsed). Delivery is someone else's job.

const TARGETS = new Set(['markdown', 'terminal', 'forge-comment'])
const WIDTH = 80

const escape = s => String(s).replace(/[\\*_`[\]<>]/g, '\\$&')
const mentions = (text, term) => new RegExp(`(^|[^\\w-])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`, 'i').test(text)

function wrap(text, indent) {
  const lead = text.match(/^ */)[0]
  const lines = []
  let line = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > WIDTH) { lines.push(line); line = indent + w }
    else line = line ? `${line} ${w}` : lead + w
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

// Recommended first, the rest in key order.
const ordered = options => [...options].sort((a, b) => (b.recommended === true) - (a.recommended === true) || String(a.key).localeCompare(String(b.key)))

const orList = keys => keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} or ${keys.at(-1)}`

function noAnswer(ina) {
  const when = ina.by === 'never' ? 'no deadline' : `by ${ina.by}${ina.defaultKey ? `, then ${ina.defaultKey}` : ''}`
  return `${ina.happens} (${when})`
}

function links(r) {
  const out = (r.links || []).map(l => ({ text: l.text, url: l.url }))
  if (r.run && r.run.prUrl && !out.some(l => l.url === r.run.prUrl)) out.push({ text: 'Pull request', url: r.run.prUrl })
  if (r.run && r.run.runUrl) out.push({ text: 'Run', url: r.run.runUrl })
  return out
}

function usedTerms(r) {
  const text = [r.title, r.situation, r.ask, r.ifNoAnswer && r.ifNoAnswer.happens,
    ...(r.options || []).flatMap(o => [o.label, o.gain, o.loss, o.reversalCost && o.reversalCost.how]),
    ...(r.links || []).map(l => l.text)].filter(Boolean).join('\n')
  return Object.entries(r.glossary || {}).filter(([k]) => mentions(text, k)).sort(([a], [b]) => a.localeCompare(b))
}

function terminal(r) {
  const out = [wrap(r.title ? `${r.title} - ${r.id}` : r.id, '  '), wrap(`Situation: ${r.situation}`, '  '), wrap(`Question: ${r.ask}`, '  ')]
  ordered(r.options).forEach((o, i) => {
    out.push(wrap(`  ${i + 1}. ${o.key}${o.recommended ? ' (Recommended)' : ''} ${o.label}`, '       '))
    out.push(wrap(`     gain: ${o.gain}`, '       '), wrap(`     loss: ${o.loss}`, '       '))
    out.push(wrap(`     undo: ${o.reversalCost.level} - ${o.reversalCost.how}`, '       '))
  })
  out.push(wrap(`If nobody answers: ${noAnswer(r.ifNoAnswer)}`, '  '))
  const terms = usedTerms(r)
  if (terms.length) out.push('Terms:', ...terms.map(([k, v]) => wrap(`  ${k} = ${v}`, '    ')))
  out.push('Links:', ...links(r).map(l => `  ${l.text}: ${l.url}`))
  out.push(`Reply with: ${orList(ordered(r.options).map(o => o.key).sort())} (+ optional note)`, '')
  return out.join('\n')
}

function markdown(r, collapseTerms) {
  const out = [`${r.title ? `**${escape(r.title)}** - ` : ''}${escape(r.id)}`, '', `**Situation:** ${escape(r.situation)}`, '', `**Question:** ${escape(r.ask)}`, '']
  ordered(r.options).forEach((o, i) => {
    out.push(`${i + 1}. **${o.key}${o.recommended ? ' (Recommended)' : ''}: ${escape(o.label)}**`)
    out.push(`   - Gain: ${escape(o.gain)}`, `   - Loss: ${escape(o.loss)}`, `   - Undo: ${o.reversalCost.level} - ${escape(o.reversalCost.how)}`)
  })
  out.push('', `**If nobody answers:** ${escape(noAnswer(r.ifNoAnswer))}`, '')
  const terms = usedTerms(r).map(([k, v]) => `- **${escape(k)}**: ${escape(v)}`)
  if (terms.length && collapseTerms) out.push('<details><summary>Terms</summary>', '', ...terms, '', '</details>', '')
  else if (terms.length) out.push('**Terms:**', ...terms, '')
  out.push(`**Links:** ${links(r).map(l => `[${escape(l.text)}](${l.url})`).join(' · ')}`, '')
  out.push(`Reply with: ${orList(ordered(r.options).map(o => o.key).sort())} (+ optional note)`, '')
  return out.join('\n')
}

export function render(request, target) {
  if (!TARGETS.has(target)) throw new Error(`unknown target "${target}"; one of ${[...TARGETS].join(', ')}`)
  if (target === 'terminal') return terminal(request)
  return markdown(request, target === 'forge-comment')
}
