import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deleteSession,
  findSessionDirectories,
  isDeletableSessionId,
} from '../lib/delete-session.js'

const TARGET = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const project = join(root, '--tmp-project--')
  const targetDir = join(project, TARGET)
  const otherDir = join(project, OTHER)
  await mkdir(targetDir, { recursive: true })
  await mkdir(otherDir, { recursive: true })
  await writeFile(join(targetDir, 'session.v4.jsonl.zstd'), 'target-log')
  await writeFile(join(otherDir, 'session.v4.jsonl.zstd'), 'other-log')
  return { root, targetDir, otherDir }
}

function harness({
  root,
  live = false,
  closable = false,
  disposeFails = false,
  accounted = true,
} = {}) {
  const calls = {
    unarchive: [],
    unpin: [],
    detach: [],
    stop: [],
    disposed: 0,
    events: [],
    warnings: [],
  }
  const liveSessions = new Map()
  const liveAgents = new Map()
  if (live) {
    liveSessions.set(TARGET, { id: TARGET })
    if (closable) {
      liveAgents.set(TARGET, {
        id: TARGET,
        status: 'idle',
        async whenIdle() {},
        scope: {
          async dispose() {
            if (disposeFails) throw new Error('scope dispose failed')
            calls.disposed += 1
          },
        },
      })
    }
  }
  const liveSessionStore = {
    store: liveSessions,
    get: (id) => liveSessions.get(id),
    detachEntered(entry) {
      liveSessions.delete(entry.id)
    },
  }
  const liveAgentStore = {
    store: liveAgents,
    get: (id) => liveAgents.get(id),
    detachEntered(entry) {
      liveAgents.delete(entry.id)
    },
  }
  const cache = new Map([
    [TARGET, { title: TARGET }],
    [OTHER, { title: OTHER }],
  ])
  const workspace = {
    id: 'workspace-1',
    record: { sessionIds: accounted ? [TARGET, OTHER] : [OTHER] },
    async detachSession(sessionId) {
      calls.detach.push(sessionId)
      this.record.sessionIds = this.record.sessionIds.filter((id) => id !== sessionId)
    },
  }
  const workspaceRegistry = {
    list: () => [workspace],
    async unarchiveSession(sessionId) {
      calls.unarchive.push(sessionId)
    },
    async unpinSession(sessionId) {
      calls.unpin.push(sessionId)
    },
  }
  const storageDomain = {
    get(name) {
      if (name !== 'session_projcache') return undefined
      return {
        table(table) {
          if (table !== 'sessions') return undefined
          return {
            get: (key) => cache.get(key),
            async delete(key) {
              cache.delete(key)
            },
          }
        },
      }
    },
  }
  const persistence = {
    root,
    async stat(sessionId) {
      if (sessionId !== TARGET) return undefined
      return { header: { id: TARGET } }
    },
  }
  return {
    calls,
    cache,
    workspace,
    options: {
      sessionId: TARGET,
      sessions: liveSessionStore,
      agents: liveAgentStore,
      persistence,
      workspaceRegistry,
      storageDomain,
      stopSessionActivity: async (id) => {
        calls.stop.push(id)
      },
      emit: (event, payload) => calls.events.push([event, payload]),
      logger: { warn: (message) => calls.warnings.push(message) },
    },
  }
}

test('deletes the log, projection cache, workspace account, and notifies clients', async () => {
  const { root, targetDir, otherDir } = await fixture()
  try {
    const { calls, cache, workspace, options } = harness({ root })

    const result = await deleteSession(options)

    assert.equal(result.deleted, true)
    assert.equal(result.sessionId, TARGET)
    assert.equal(result.artifacts, 1)
    assert.equal(result.projectionCacheRemoved, true)
    assert.equal(result.detachedWorkspaces, 1)

    await assert.rejects(stat(targetDir), { code: 'ENOENT' })
    assert.equal(await readFile(join(otherDir, 'session.v4.jsonl.zstd'), 'utf8'), 'other-log')
    assert.equal(cache.has(TARGET), false)
    assert.equal(cache.has(OTHER), true)
    assert.deepEqual(calls.unarchive, [TARGET])
    assert.deepEqual(calls.unpin, [TARGET])
    assert.deepEqual(calls.detach, [TARGET])
    assert.deepEqual(calls.events, [['api-session/removed', TARGET]])
    assert.equal(workspace.record.sessionIds.includes(TARGET), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a live session without touching its log', async () => {
  const { root, targetDir } = await fixture()
  try {
    const { calls, options } = harness({ root, live: true })
    await assert.rejects(deleteSession(options), { code: 'session-delete/live' })
    assert.equal((await stat(targetDir)).isDirectory(), true)
    assert.deepEqual(calls.events, [])
    assert.deepEqual(calls.detach, [])
    assert.deepEqual(calls.stop, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('closes a resident session before deleting its log', async () => {
  const { root, targetDir } = await fixture()
  try {
    const { calls, options } = harness({ root, live: true, closable: true })
    const result = await deleteSession(options)

    assert.equal(result.deleted, true)
    assert.equal(result.closedLiveSession, true)
    assert.equal(result.artifacts, 1)
    assert.deepEqual(calls.stop, [TARGET])
    assert.equal(calls.disposed, 1)
    await assert.rejects(stat(targetDir), { code: 'ENOENT' })
    assert.deepEqual(calls.events, [['api-session/removed', TARGET]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the log when the resident session cannot be closed', async () => {
  const { root, targetDir } = await fixture()
  try {
    const { calls, options } = harness({
      root,
      live: true,
      closable: true,
      disposeFails: true,
    })
    await assert.rejects(deleteSession(options), { code: 'session-delete/stop-failed' })
    assert.equal((await stat(targetDir)).isDirectory(), true)
    assert.deepEqual(calls.events, [])
    assert.deepEqual(calls.detach, [])
    assert.equal(calls.disposed, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports an unknown session instead of silently succeeding', async () => {
  const { root } = await fixture()
  try {
    const { options } = harness({ root, accounted: false })
    await assert.rejects(
      deleteSession({
        ...options,
        sessionId: 'session-99999999-0000-0000-0000-000000000000',
      }),
      { code: 'session-delete/not-found' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects ids that could escape the session root', async () => {
  const { root } = await fixture()
  try {
    const { options } = harness({ root })
    for (const sessionId of ['../escape', 'session-../escape', 'session-', 42, '']) {
      assert.equal(isDeletableSessionId(sessionId), false)
      await assert.rejects(deleteSession({ ...options, sessionId }), {
        code: 'session-delete/invalid-id',
      })
    }
    assert.equal((await stat(join(root, '--tmp-project--', TARGET))).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deletes an accounted but never materialized session', async () => {
  const { root } = await fixture()
  try {
    const { calls, options } = harness({ root })
    await rm(join(root, '--tmp-project--', TARGET), { recursive: true, force: true })
    const result = await deleteSession(options)
    assert.equal(result.artifacts, 0)
    assert.equal(result.detachedWorkspaces, 1)
    assert.deepEqual(calls.detach, [TARGET])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires a configured persistence root', async () => {
  const { root } = await fixture()
  try {
    const { options } = harness({ root })
    await assert.rejects(
      deleteSession({ ...options, persistence: { ...options.persistence, root: undefined } }),
      { code: 'session-delete/storage-unavailable' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('finds one artifact per project directory', async () => {
  const { root } = await fixture()
  try {
    const second = join(root, '--second-project--', TARGET)
    await mkdir(second, { recursive: true })
    const found = await findSessionDirectories(root, TARGET)
    assert.equal(found.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
