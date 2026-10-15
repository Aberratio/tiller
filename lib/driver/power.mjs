// Power state for the day driver: battery charge and whether the machine runs on mains. Every reader
// returns null when it cannot tell (a desktop, a VM, a missing tool); null never pauses a day.
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_BATTERY_MIN_PERCENT = 15

// `pmset -g batt`: "Now drawing from 'AC Power'" / "'Battery Power'", then "... 42%; discharging; ...".
export function parsePmset(text) {
  const pct = /(\d{1,3})%/.exec(String(text || ''))
  if (!pct) return null
  return { percent: Number(pct[1]), onAc: !/Now drawing from 'Battery Power'/.test(text) }
}

// /sys/class/power_supply: the first Battery supply's capacity; on mains when it is not Discharging.
export function readSysfs(dir = '/sys/class/power_supply', { read = f => readFileSync(f, 'utf8'), list = readdirSync } = {}) {
  let names
  try { names = list(dir) } catch { return null }
  for (const n of names) {
    try {
      if (read(join(dir, n, 'type')).trim() !== 'Battery') continue
      const percent = Number(read(join(dir, n, 'capacity')).trim())
      if (!Number.isFinite(percent)) continue
      let status = ''
      try { status = read(join(dir, n, 'status')).trim() } catch {}
      return { percent, onAc: status !== 'Discharging' }
    } catch {}
  }
  return null
}

export function readBattery({ platform = process.platform, run = spawnSync, sysfs = readSysfs } = {}) {
  if (platform === 'darwin') {
    const r = run('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000 })
    return r && r.status === 0 ? parsePmset(r.stdout) : null
  }
  if (platform === 'linux') return sysfs()
  return null
}

export function batteryMinPercent(env = process.env) {
  const n = Number(env.TILLER_BATTERY_MIN_PERCENT)
  return env.TILLER_BATTERY_MIN_PERCENT !== undefined && env.TILLER_BATTERY_MIN_PERCENT !== '' && Number.isFinite(n) ? n : DEFAULT_BATTERY_MIN_PERCENT
}

export const batteryLow = (b, min) => !!b && !b.onAc && b.percent < min
