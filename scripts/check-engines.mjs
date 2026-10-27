/**
 * Assert that this bundle's `engines.dsh` accepts one DSH version.
 *
 * The check reuses DSH's own predicate (`evaluatePluginCompatibility`) so the
 * answer matches what the launcher would decide, including prerelease
 * semantics. Requires `npm install` (devDependencies).
 *
 * Usage: node scripts/check-engines.mjs [dsh-version]
 *   without an argument, checks the runtime version of the installed packages.
 */
import { readFileSync } from 'node:fs'

import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const range = manifest.engines?.dsh
const version = process.argv[2] ?? getDshRuntimeVersion()

if (typeof range !== 'string') {
  console.error('package.json declares no engines.dsh; every DSH version is accepted')
  process.exit(1)
}

const issue = evaluatePluginCompatibility(manifest, {}, version)
if (issue !== undefined) {
  console.error(`engines.dsh "${range}" rejects DSH ${version} (unmet: ${JSON.stringify(issue.requirements)})`)
  process.exit(1)
}

console.log(`engines.dsh "${range}" accepts DSH ${version}`)
