// Each harness feature, what it needs, and whether this machine has it. A missing requirement
// disables the features that need it, never the onboarding; install commands are printed, not run.

const AGENT_NAMES = { claude: 'Claude Code', copilot: 'Copilot CLI' }

export const FEATURES = [
  { id: 'skills', label: 'Skills', requires: ['agent:skills'] },
  { id: 'role-agents', label: 'Harness role agents', requires: ['agent:claude|copilot'] },
  // Both v1 agents have a PreToolUse hook that can deny a call.
  { id: 'private-access', label: 'Private-access hook', requires: ['agent:claude|copilot', 'shell', 'jq'] },
  { id: 'profile-resolution', label: 'Profile resolution in skills', requires: ['shell'] },
  { id: 'unattended', label: 'Unattended runs', requires: ['agent:claude', 'shell', 'timeout', 'gh'] },
  { id: 'pull-requests', label: 'Pull requests', requires: ['gh'] },
]

// Verified 2026-10-13: Claude Code (code.claude.com/docs/en/setup), Copilot CLI
// (docs.github.com install-copilot-cli), winget ids against microsoft/winget-pkgs.
const INSTALL = {
  node: { darwin: 'brew install node', linux: 'sudo apt install nodejs', win32: 'winget install OpenJS.NodeJS.LTS' },
  git: { darwin: 'brew install git', linux: 'sudo apt install git', win32: 'winget install Git.Git' },
  gh: { darwin: 'brew install gh', linux: 'sudo apt install gh', win32: 'winget install GitHub.cli' },
  jq: { darwin: 'brew install jq', linux: 'sudo apt install jq', win32: 'winget install jqlang.jq' },
  // Git for Windows ships coreutils timeout next to its bash.
  timeout: { darwin: 'brew install coreutils', linux: 'sudo apt install coreutils', win32: 'winget install Git.Git' },
  shell: { darwin: 'brew install bash', linux: 'sudo apt install bash', win32: 'winget install Git.Git' },
  claude: { darwin: 'curl -fsSL https://claude.ai/install.sh | bash', linux: 'curl -fsSL https://claude.ai/install.sh | bash', win32: 'winget install Anthropic.ClaudeCode' },
  copilot: { darwin: 'brew install --cask copilot-cli', linux: 'npm install -g @github/copilot', win32: 'winget install GitHub.Copilot' },
}

export function installCommand(tool, platform) {
  return INSTALL[tool]?.[platform] ?? null
}

const shellName = platform => (platform === 'win32' ? 'Git Bash' : 'a POSIX shell')

// One requirement -> { ok, degraded?, missing: [tool], reason }
function check(req, m) {
  const present = Object.keys(AGENT_NAMES).filter(a => m.agents[a]?.bin)
  if (req === 'agent:skills') {
    if (present.length) return { ok: true }
    return { ok: true, degraded: true, missing: [], reason: 'no supported agent; the files fallback writes skills to a directory you name' }
  }
  if (req.startsWith('agent:')) {
    const wanted = req.slice(6).split('|')
    if (wanted.some(a => present.includes(a))) return { ok: true }
    return { ok: false, missing: wanted, reason: `needs ${wanted.map(a => AGENT_NAMES[a]).join(' or ')}` }
  }
  if (req === 'shell') return m.shell ? { ok: true } : { ok: false, missing: ['shell'], reason: `needs ${shellName(m.platform)}` }
  return m.tools[req] ? { ok: true } : { ok: false, missing: [req], reason: `needs ${req}` }
}

export function capabilities(m) {
  return FEATURES.map(({ id, label, requires }) => {
    const results = requires.map(r => check(r, m))
    const failed = results.filter(r => !r.ok)
    const missing = [...new Set(failed.flatMap(r => r.missing))]
    if (failed.length) {
      return { id, label, status: 'unavailable', reason: failed.map(r => r.reason).join('; '), missing,
        install: [...new Set(missing.map(t => installCommand(t, m.platform)).filter(Boolean))] }
    }
    const degraded = results.filter(r => r.degraded)
    if (degraded.length) return { id, label, status: 'degraded', reason: degraded.map(r => r.reason).join('; '), missing: [], install: [] }
    return { id, label, status: 'ready', reason: null, missing: [], install: [] }
  })
}
