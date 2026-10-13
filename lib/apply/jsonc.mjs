// JSON with comments, edited in place: a parse keeps each value's span in the text, so an edit
// touches only the bytes of the member it changes and every comment elsewhere survives.

export class JsoncError extends Error {}

export function parseJsonc(text) {
  let i = 0
  const fail = why => { throw new JsoncError(`${why} at offset ${i}`) }

  function skip() {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i)
        i = nl < 0 ? text.length : nl + 1
      } else if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2)
        if (close < 0) fail('unterminated comment')
        i = close + 2
      } else return
    }
  }

  function string() {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail('unterminated string')
    i++
    try { return JSON.parse(text.slice(start, i)) } catch { fail('invalid string') }
  }

  function value() {
    skip()
    const start = i
    const c = text[i]
    if (c === '{' || c === '[') {
      const isObject = c === '{'
      const close = isObject ? '}' : ']'
      const members = [], items = []
      i++
      skip()
      if (text[i] === close) {
        i++
        return { type: isObject ? 'object' : 'array', start, end: i, members, value: isObject ? {} : [] }
      }
      for (;;) {
        skip()
        if (isObject) {
          if (text[i] !== '"') fail('expected a key')
          const keyStart = i
          const key = string()
          skip()
          if (text[i] !== ':') fail('expected ":"')
          i++
          members.push({ key, keyStart, node: value() })
        } else items.push(value())
        skip()
        if (text[i] === ',') { i++; continue }
        if (text[i] === close) { i++; break }
        fail(`expected "," or "${close}"`)
      }
      const v = isObject ? {} : items.map(n => n.value)
      if (isObject) for (const m of members) v[m.key] = m.node.value
      return { type: isObject ? 'object' : 'array', start, end: i, members, value: v }
    }
    if (c === '"') return { type: 'value', start, value: string(), end: i }
    const m = /-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null/y
    m.lastIndex = i
    const hit = m.exec(text)
    if (!hit) fail('unexpected token')
    i = m.lastIndex
    return { type: 'value', start, end: i, value: JSON.parse(hit[0]) }
  }

  const root = value()
  skip()
  if (i !== text.length) fail('unexpected text after the value')
  return root
}
