export function machineName(env, host) {
  return String(env.TILLER_MACHINE || host.split('.')[0] || 'machine').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}
