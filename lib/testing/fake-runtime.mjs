// Stub `claude` and `codex` binaries for tests that go through the real runtime routing.
// The production probe (runtimeAvailability) only looks for the binary on PATH, so a machine without
// the CLIs installed would otherwise see every runtime as down. The stubs are never executed by
// the tests that use them; they exist only so the probe finds a file.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const STUB = '#!/bin/sh\necho "fake runtime stub: not a real CLI" >&2\nexit 127\n'

export function fakeRuntimeBin(names = ['claude', 'codex']) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-runtime-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const name of names) {
    const file = join(bin, name)
    writeFileSync(file, STUB)
    chmodSync(file, 0o755)
  }
  return bin
}

// PATH value with the stub dir first; pass an env to build from it instead of process.env.
export const fakeRuntimePath = (env = process.env, names) => [fakeRuntimeBin(names), env.PATH || ''].filter(Boolean).join(delimiter)

// Prepends the stubs to this process's PATH once; every child the test spawns inherits it.
let installed = null
export function installFakeRuntimes() {
  if (!installed) {
    installed = fakeRuntimeBin()
    process.env.PATH = [installed, process.env.PATH || ''].filter(Boolean).join(delimiter)
  }
  return installed
}
