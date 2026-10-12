// One matcher for a secret written in clear. The hitl linter refuses what it finds; lane inputs redact it.

const KEYWORD = '(?:access[ _-]?code|password|passwd|secret|token|api[ _-]?key|apikey)'
const VALUE = `("[^"]*"|'[^']*'|[^\\s,;]+)`
const source = `(?<![A-Za-z])(${KEYWORD})(\\s*[:=]\\s*)(?!<REDACTED>)${VALUE}`

const ONE = new RegExp(source, 'i')
const ALL = () => new RegExp(source, 'gi')

export const hasSecret = text => ONE.test(String(text ?? ''))

export const hasLiteral = (text, literals = []) => literals.some(x => x && String(text ?? '').includes(x))

export function redactSecrets(text, literals = []) {
  let s = String(text ?? '').replace(ALL(), '$1$2<REDACTED>')
  for (const x of literals) if (x) s = s.split(x).join('<REDACTED>')
  return s
}
