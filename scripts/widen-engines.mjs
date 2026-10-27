/**
 * Widen `engines.dsh` so it accepts one newer DSH version, and move the
 * development dependency to that version.
 *
 * The rule is deliberately conservative: keep the existing lower bound, raise
 * the exclusive upper bound to the next minor after the target (`0.4.0-rc.1`
 * gives `<0.5.0`). Nothing is published by this script; the compat workflow
 * opens a draft pull request so the resident-session path can be smoke-tested
 * before the new range ships.
 *
 * Usage: node scripts/widen-engines.mjs <dsh-version>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/widen-engines.mjs <dsh-version>')
  process.exit(1)
}

const match = /^(\d+)\.(\d+)\.(\d+)/.exec(target)
if (match === null) {
  console.error(`not a semantic version: ${JSON.stringify(target)}`)
  process.exit(1)
}

const [, major, minor] = match
const upper = `${major}.${Number(minor) + 1}.0`
const filename = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(filename, 'utf8'))
const previous = manifest.engines?.dsh
const lower = typeof previous === 'string' ? previous.split('<')[0].trim() : '>=0.0.0'

manifest.engines = { ...manifest.engines, dsh: `${lower} <${upper}` }
manifest.devDependencies = { ...manifest.devDependencies, '@deepseek-ai/dsh': target }

writeFileSync(filename, `${JSON.stringify(manifest, undefined, 2)}\n`)
console.log(`engines.dsh: ${previous} -> ${manifest.engines.dsh}`)
console.log(`devDependencies["@deepseek-ai/dsh"]: ${target}`)
