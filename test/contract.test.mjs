/**
 * Contract tests against the *real* `@deepseek-ai/dsh` packages.
 *
 * The unit suite (`session-delete.test.mjs`) fakes every service, so it cannot
 * notice that a DSH release renamed, moved, or dropped an internal surface the
 * Host half calls. This suite asserts the surfaces the plugin actually touches,
 * against whichever DSH version is installed:
 *
 *   - the version gate (`engines.dsh`) accepts the running runtime;
 *   - `ctx.sessions` / `ctx.agents` still expose `store` + `detachEntered`;
 *   - the JSONL persistence backend still exposes `root`, `stat`, and
 *     `tracker.openHandles`;
 *   - the Workspace registry still exposes `list`, and its entities still
 *     detach a session;
 *   - the two Host events the plugin emits/awaits still exist.
 *
 * A failure here means the plugin must adopt the new shape *before* widening
 * `engines.dsh` — not that the plugin is broken at runtime.
 *
 * Run `npm install` first; without devDependencies the suite skips.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Resolve a package through the project's own node_modules. */
function entryUrl(name) {
  try {
    return import.meta.resolve(name)
  } catch {
    return undefined
  }
}

const dshInstalled = entryUrl('@deepseek-ai/dsh/package.json') !== undefined
const skip = dshInstalled ? false : 'install devDependencies (npm install) to run contract tests'

/** Import one package by name, through ESM resolution. */
async function load(name) {
  return import(entryUrl(name))
}

/** Let cordis mount the plugins it was handed. */
async function settle(app) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  return app
}

test('engines.dsh accepts the installed DSH runtime', { skip }, async () => {
  const appBoot = await load('@deepseek-ai/dsh-app-boot')
  const runtime = appBoot.getDshRuntimeVersion()
  const issue = appBoot.evaluatePluginCompatibility(manifest)
  assert.equal(
    issue,
    undefined,
    `this plugin declares engines.dsh "${manifest.engines.dsh}", which rejects the installed DSH ${runtime}; ` +
      'widen the range only after the contract tests below pass against that version',
  )
})

test('session and agent registries keep the detach contract', { skip }, async () => {
  const { Context } = await load('@deepseek-ai/cordis')
  const { SessionStore } = await load('@deepseek-ai/dsh-session')
  const { AgentRegistry } = await load('@deepseek-ai/dsh-agent')
  const app = await settle(new Context())
  app.plugin(SessionStore)
  app.plugin(AgentRegistry)
  await settle(app)
  try {
    // `index.js` injects exactly these service names.
    assert.equal(typeof app.sessions, 'object', 'ctx.sessions is missing')
    assert.equal(typeof app.agents, 'object', 'ctx.agents is missing')

    // `lib/delete-session.js` checks `store instanceof Map` and calls
    // `detachEntered(entry)` to publish the paired disposal events.
    assert.ok(app.sessions.store instanceof Map, 'ctx.sessions.store is no longer a Map')
    assert.equal(typeof app.sessions.detachEntered, 'function', 'SessionStore#detachEntered is gone')
    assert.equal(typeof app.sessions.get, 'function', 'SessionStore#get is gone')
    assert.ok(app.agents.store instanceof Map, 'ctx.agents.store is no longer a Map')
    assert.equal(typeof app.agents.detachEntered, 'function', 'AgentRegistry#detachEntered is gone')
    assert.equal(typeof app.agents.get, 'function', 'AgentRegistry#get is gone')
  } finally {
    await app.dispose?.()
  }
})

test('JSONL persistence keeps root, stat, and the open-handle tracker', { skip }, async () => {
  const { Context } = await load('@deepseek-ai/cordis')
  const jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-contract-'))
  const app = await settle(new Context())
  try {
    app.plugin(jsonl, { root })
    await settle(app)
    const persistence = app.sessionPersistence
    assert.equal(typeof persistence, 'object', 'ctx.sessionPersistence is missing')
    // Deletion resolves every artifact directory from this root.
    assert.equal(typeof persistence.root, 'string', 'persistence.root is no longer a string')
    // `stat()` distinguishes a never-materialized session from a corrupt one.
    assert.equal(typeof persistence.stat, 'function', 'SessionPersistence#stat is gone')
    // A resident session's write handle is closed through this set before the
    // artifact is unlinked.
    assert.ok(
      persistence.tracker?.openHandles instanceof Set,
      'persistence.tracker.openHandles is no longer a Set',
    )
  } finally {
    await app.dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace registry keeps list() and the entity detach mutation', { skip }, async () => {
  const { WorkspaceRegistry } = await load('@deepseek-ai/dsh-workspace')
  assert.equal(typeof WorkspaceRegistry, 'function', 'WorkspaceRegistry export is gone')
  assert.equal(typeof WorkspaceRegistry.prototype.list, 'function', 'WorkspaceRegistry#list is gone')

  // The entity class is module-private, so the only stable way to observe its
  // mutation without a mounted storage domain is the module source.
  const source = readFileSync(fileURLToPath(entryUrl('@deepseek-ai/dsh-workspace')), 'utf8')
  assert.match(
    source,
    /\basync detachSession\s*\(/,
    'the workspace entity no longer defines detachSession(); session deletion cannot unaccount the row',
  )
})

test('host events the plugin emits and awaits still exist', { skip }, async () => {
  const controller = readFileSync(
    fileURLToPath(entryUrl('@deepseek-ai/dsh-api-session-controller')),
    'utf8',
  )
  // The sidebar drops the row when the Client receives this frame.
  assert.match(controller, /"api-session\/removed"/, 'api-session/removed is no longer emitted')

  const workspace = readFileSync(fileURLToPath(entryUrl('@deepseek-ai/dsh-workspace')), 'utf8')
  // Every activity provider is asked to stop through this parallel event.
  assert.match(workspace, /"workspace\/session-stop"/, 'workspace/session-stop is no longer dispatched')
})
