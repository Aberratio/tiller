// L13, optional and separate from lint(): do the request's links resolve? A 404/410 blocks; offline, a timeout,
// a rate limit or a server error only warns. A private forge answers 404 to an anonymous HEAD, so the caller
// passes an authenticated fetch (or a forge API client) as opts.fetch for those URLs.

const DEAD = new Set([404, 410])

export async function checkLinks(request, { fetch: get = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const urls = new Map()
  ;(request.links || []).forEach((l, i) => l && l.url && !urls.has(l.url) && urls.set(l.url, `$.links[${i}].url`))
  for (const f of ['runUrl', 'prUrl']) { const u = request.run && request.run[f]; if (u && !urls.has(u)) urls.set(u, `$.run.${f}`) }
  const violations = [], warnings = []
  await Promise.all([...urls].map(async ([url, path]) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const { status } = await get(url, { method: 'HEAD', redirect: 'manual', signal: ctl.signal })
      if (DEAD.has(status)) violations.push({ rule: 'L13', path, text: `${url} answers ${status}` })
      else if (status >= 400) warnings.push({ rule: 'L13', path, text: `${url} answers ${status}; not checked` })
    } catch (e) {
      warnings.push({ rule: 'L13', path, text: `${url} not reachable (${e && e.message}); not checked` })
    } finally { clearTimeout(timer) }
  }))
  const order = (a, b) => a.path.localeCompare(b.path)
  return { ok: violations.length === 0, violations: violations.sort(order), warnings: warnings.sort(order) }
}
