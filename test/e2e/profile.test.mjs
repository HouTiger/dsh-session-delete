/**
 * End-to-end gate test: install this bundle into a throwaway DSH home and let
 * the real CLI compose the profile.
 *
 * This is the exact path that silently dropped the plugin after a DSH upgrade:
 * a bundle whose `engines.dsh` rejects the runtime is skipped at composition
 * time, with one stderr line and no rows in the UI. The test therefore asserts
 * both directions:
 *
 *   1. this package composes and contributes its `session-delete` row;
 *   2. a bundle with an impossible range is skipped — so test 1 cannot pass
 *      vacuously.
 *
 * It needs a `dsh` binary: `npm install` provides `node_modules/.bin/dsh`.
 * Nothing here boots a Host, so no model credentials are required.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const dshBin = join(repoRoot, 'node_modules', '.bin', 'dsh')
const skip = existsSync(dshBin) ? false : 'run npm install to provide node_modules/.bin/dsh'

/** A profile that resolves its bundles from the CLI installation plus local links. */
async function makeProfile(home, packageName, target) {
  const dir = join(home, 'profiles', 'e2e')
  await mkdir(join(dir, 'node_modules', '@local'), { recursive: true })
  await symlink(target, join(dir, 'node_modules', packageName), 'dir')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-e2e',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', packageName] } },
      },
      undefined,
      2,
    ),
  )
  return dir
}

/** Compose the throwaway profile and return its dump and diagnostics. */
async function dump(home) {
  try {
    const { stdout, stderr } = await execFileAsync(dshBin, ['--profile', 'e2e', '--dump-config'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

test('the bundle composes and contributes its session-delete row', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-e2e-'))
  try {
    await makeProfile(home, '@local/dsh-session-delete', repoRoot)
    const { code, stdout, stderr } = await dump(home)
    assert.equal(code, 0, `dsh --dump-config failed:\n${stderr}`)
    assert.doesNotMatch(stderr, /skipping profile bundle/, `the bundle was skipped:\n${stderr}`)
    assert.match(stdout, /# == @local\/dsh-session-delete/, 'the bundle layer is missing from the composition')
    assert.match(stdout, /- id: session-delete\b/, 'the session-delete entry is missing from the composition')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an incompatible bundle is still skipped by the version gate', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-e2e-'))
  const bundle = join(home, 'incompatible-bundle')
  try {
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: session-delete\n      name: ./index.js\n')
    await writeFile(
      join(bundle, 'package.json'),
      JSON.stringify(
        {
          name: '@local/dsh-session-delete',
          version: '0.0.0',
          type: 'module',
          engines: { dsh: '>=99.0.0 <100.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        },
        undefined,
        2,
      ),
    )
    await makeProfile(home, '@local/dsh-session-delete', bundle)
    const { stdout, stderr } = await dump(home)
    assert.match(stderr, /skipping profile bundle "@local\/dsh-session-delete"/, `the gate did not skip the bundle:\n${stderr}`)
    assert.doesNotMatch(stdout, /- id: session-delete\b/, 'an incompatible bundle contributed rows anyway')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
