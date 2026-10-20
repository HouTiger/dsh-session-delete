/**
 * Permanent Session removal over the running Host.
 *
 * The Session log is the source of truth, so deletion starts by removing the
 * on-disk artifact and then reconciles the derived state that names the
 * Session: the projection-cache row, the Workspace account (where the row is
 * rendered), the archived/pinned sets, and finally the Client Session list.
 *
 * This module deliberately depends only on the small service faces it uses,
 * so its behavior can be tested without booting a Host.
 *
 * @module @local/dsh-session-delete/delete-session
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Session ids are `session-<uuid>` today; keep the path segment strictly inert. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]{1,200}$/
const PROJECTION_CACHE_DOMAIN = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

/** A deletion failure with a stable code the Remote layer and UI can localize. */
export class SessionDeleteError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - human diagnostic.
   * @param details - structured context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'SessionDeleteError'
    this.code = code
    this.details = details
  }
}

/**
 * @param sessionId - untrusted Session id.
 * @returns whether the id can be used as one path segment under the Session root.
 */
export function isDeletableSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

/**
 * Find every materialized artifact directory for one Session. The persistence
 * backend groups sessions by a readable project directory, so the artifact is
 * `<root>/<project>/<id>`; scanning the first level keeps this independent of
 * the backend's private path-normalization helpers.
 *
 * @param root - configured Session persistence root.
 * @param sessionId - validated Session id.
 * @returns artifact directories, empty when the Session never materialized.
 */
export async function findSessionDirectories(root, sessionId) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) directories.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return directories
}

/** Whether any Workspace record still accounts the Session. */
function accountedInWorkspaces(workspaces, sessionId) {
  for (const workspace of workspaces) {
    const record = workspace?.record?.sessionIds ?? workspace?.sessionIds
    if (Array.isArray(record) && record.includes(sessionId)) return true
  }
  return false
}

/** Remove the derived projection-cache row through the owning storage domain. */
async function removeProjectionCache(storageDomain, sessionId) {
  const domain = storageDomain?.get?.(PROJECTION_CACHE_DOMAIN)
  if (domain === undefined) return false
  const table = domain.table?.(PROJECTION_CACHE_TABLE)
  if (table === undefined) return false
  if (table.get?.(sessionId) === undefined) return false
  await table.delete(sessionId)
  return true
}

/** Whether the projection cache still names the Session. */
function hasProjectionCache(storageDomain, sessionId) {
  const domain = storageDomain?.get?.(PROJECTION_CACHE_DOMAIN)
  const table = domain?.table?.(PROJECTION_CACHE_TABLE)
  return table?.get?.(sessionId) !== undefined
}

/**
 * Drop the Session from every Workspace account. `detachSession` is the
 * registry entity's own mutation path: it updates the durable record and the
 * registry's snapshot, and the Workspace controller turns the resulting
 * `domain/changed` event into the `upsert` frame the sidebar consumes.
 */
async function detachFromWorkspaces(workspaces, sessionId, warnings) {
  let detached = 0
  for (const workspace of workspaces) {
    const record = workspace?.record?.sessionIds ?? workspace?.sessionIds
    if (!Array.isArray(record) || !record.includes(sessionId)) continue
    if (typeof workspace.detachSession !== 'function') {
      warnings.push(
        `workspace ${JSON.stringify(workspace?.id ?? workspace?.path ?? 'unknown')} exposes no detachSession mutation`,
      )
      continue
    }
    await workspace.detachSession(sessionId)
    detached += 1
  }
  return detached
}

/**
 * Wait for a resident Agent to finish the work the stop request cancelled.
 * A turn that ignores cancellation must not let a delete hang forever.
 */
async function waitForIdle(agent, sessionId) {
  if (typeof agent.whenIdle !== 'function') {
    if (agent.status === 'running') {
      throw new SessionDeleteError(
        'session-delete/live',
        `cannot delete session "${sessionId}": its Agent cannot be awaited for idleness`,
        { sessionId },
      )
    }
    return
  }
  let timer
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new SessionDeleteError(
              'session-delete/stop-timeout',
              `cannot delete session "${sessionId}": it did not become idle within 15 seconds`,
              { sessionId },
            ),
          )
        }, 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Close the live write handle directly. The Agent loop owns the same handle,
 * but the loop's teardown closure is not exposed; closing the handle here
 * releases the file lock and flushes buffered events before the artifact is
 * unlinked. The handle's `close()` is idempotent, so later loop teardown is
 * harmless.
 */
async function closeWriteHandles(persistence, sessionId) {
  const handles = persistence?.tracker?.openHandles
  if (!(handles instanceof Set)) return 0
  let closed = 0
  for (const handle of [...handles]) {
    if (handle?.id !== sessionId || handle.access !== 'write') continue
    await handle.close()
    closed += 1
  }
  return closed
}

/**
 * Drop the Session and Agent from their live registries. This is the closure
 * the Agent loop keeps private; both registries expose their ordered detach
 * mutation, which also emits the paired disposal events.
 */
function detachLiveEntries(sessions, agents, sessionId) {
  let detached = 0
  const agentEntry = agents?.store?.get?.(sessionId)
  if (agentEntry !== undefined && typeof agents?.detachEntered === 'function') {
    agents.detachEntered(agentEntry)
    detached += 1
  }
  const sessionEntry = sessions?.store?.get?.(sessionId)
  if (sessionEntry !== undefined && typeof sessions?.detachEntered === 'function') {
    sessions.detachEntered(sessionEntry)
    detached += 1
  }
  return detached
}

/**
 * Permanently remove one Session.
 *
 * @param options - the Session id and the Host service faces it touches.
 * @param options.sessionId - Session to remove.
 * @param options.sessions - live Session store (`ctx.sessions`).
 * @param options.agents - live Agent registry (`ctx.agents`).
 * @param options.persistence - Session persistence (`ctx.sessionPersistence`).
 * @param options.workspaceRegistry - Workspace registry (`ctx.workspaceRegistry`).
 * @param options.storageDomain - storage-domain facility, when mounted.
 * @param options.stopSessionActivity - asks every activity provider to stop.
 * @param options.emit - Host event emitter used for `api-session/removed`.
 * @param options.logger - optional logger for non-fatal reconciliation failures.
 * @returns the deletion receipt.
 */
export async function deleteSession({
  sessionId,
  sessions,
  agents,
  persistence,
  workspaceRegistry,
  storageDomain,
  stopSessionActivity,
  emit,
  logger,
}) {
  if (!isDeletableSessionId(sessionId)) {
    throw new SessionDeleteError(
      'session-delete/invalid-id',
      `cannot delete session: invalid session id ${JSON.stringify(sessionId)}`,
      { sessionId: typeof sessionId === 'string' ? sessionId : undefined },
    )
  }

  const warnings = []
  let closedLiveSession = false

  // A resident Session owns an open append handle and an Agent lifecycle.
  // The Agent loop's teardown closure is private, so this closes the same
  // parts it would: ask every activity provider to stop, wait for idleness,
  // quiesce the Agent scope, close the persistence write handle, and detach
  // both live registries. Only then is the artifact removed.
  if (sessions?.get?.(sessionId) !== undefined) {
    const agent = agents?.get?.(sessionId)
    const scope = agent?.scope
    const canDetach =
      typeof sessions?.detachEntered === 'function' &&
      sessions?.store instanceof Map &&
      typeof agents?.detachEntered === 'function' &&
      agents?.store instanceof Map
    if (
      agent === undefined ||
      typeof scope?.dispose !== 'function' ||
      typeof agent.whenIdle !== 'function' ||
      !canDetach
    ) {
      throw new SessionDeleteError(
        'session-delete/live',
        `cannot delete session "${sessionId}": the session is resident but could not be closed safely`,
        { sessionId },
      )
    }
    try {
      await stopSessionActivity?.(sessionId)
    } catch (error) {
      warnings.push(`stopping session activity failed: ${String(error?.message ?? error)}`)
    }
    await waitForIdle(agent, sessionId)
    try {
      await scope.dispose()
    } catch (error) {
      throw new SessionDeleteError(
        'session-delete/stop-failed',
        `cannot close session "${sessionId}": ${String(error?.message ?? error)}`,
        { sessionId },
      )
    }
    try {
      await closeWriteHandles(persistence, sessionId)
    } catch (error) {
      throw new SessionDeleteError(
        'session-delete/stop-failed',
        `cannot close session "${sessionId}": ${String(error?.message ?? error)}`,
        { sessionId },
      )
    }
    try {
      detachLiveEntries(sessions, agents, sessionId)
    } catch (error) {
      throw new SessionDeleteError(
        'session-delete/stop-failed',
        `cannot detach session "${sessionId}" from the live registries: ${String(error?.message ?? error)}`,
        { sessionId },
      )
    }
    if (sessions.get(sessionId) !== undefined || agents?.get?.(sessionId) !== undefined) {
      throw new SessionDeleteError(
        'session-delete/live',
        `cannot delete session "${sessionId}": the session did not detach after being closed`,
        { sessionId },
      )
    }
    closedLiveSession = true
  }

  const root = persistence?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new SessionDeleteError(
      'session-delete/storage-unavailable',
      'cannot delete session: session persistence does not expose its storage root',
      { sessionId },
    )
  }

  const directories = await findSessionDirectories(root, sessionId)
  // A corrupt or half-written log is precisely what a user may need to delete;
  // a failed header read must not make the artifact undeletable.
  let snapshot
  let statFailure
  try {
    snapshot = await persistence.stat(sessionId)
  } catch (error) {
    statFailure = error
    snapshot = undefined
  }
  const workspaces = workspaceRegistry?.list?.() ?? []
  const accounted = accountedInWorkspaces(workspaces, sessionId)

  if (directories.length === 0 && snapshot === undefined && !accounted) {
    if (statFailure !== undefined) {
      throw new SessionDeleteError(
        'session-delete/storage-failed',
        `cannot delete session "${sessionId}": session storage could not be inspected`,
        { sessionId, cause: String(statFailure?.message ?? statFailure) },
      )
    }
    throw new SessionDeleteError(
      'session-delete/not-found',
      `cannot delete session "${sessionId}": no session log, pending session, or workspace account was found`,
      { sessionId },
    )
  }

  // The log is authoritative: once these directories are gone the Session
  // cannot be resumed or reopened. Do this before derived-state cleanup so a
  // failure here leaves every sidebar row and cache entry intact.
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
  }

  let projectionCacheRemoved = false
  try {
    projectionCacheRemoved = await removeProjectionCache(storageDomain, sessionId)
    // A resident Session's disposal writes one final checkpoint asynchronously,
    // possibly after the artifact is unlinked and after the first removal. Give
    // that write a short settle window and remove the late row too.
    if (closedLiveSession) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await delay(50)
        if (!hasProjectionCache(storageDomain, sessionId)) break
        projectionCacheRemoved =
          (await removeProjectionCache(storageDomain, sessionId)) || projectionCacheRemoved
      }
      if (hasProjectionCache(storageDomain, sessionId)) {
        warnings.push('projection cache row reappeared after cleanup')
      }
    }
  } catch (error) {
    warnings.push(`projection cache cleanup failed: ${String(error?.message ?? error)}`)
  }

  // Archiving and pinning are mutually exclusive; removing both set members
  // keeps an unarchive/unpin later from resurrecting an id whose log is gone.
  try {
    await workspaceRegistry?.unarchiveSession?.(sessionId)
  } catch (error) {
    warnings.push(`archive-state cleanup failed: ${String(error?.message ?? error)}`)
  }
  try {
    await workspaceRegistry?.unpinSession?.(sessionId)
  } catch (error) {
    warnings.push(`pin-state cleanup failed: ${String(error?.message ?? error)}`)
  }

  let detachedWorkspaces = 0
  try {
    detachedWorkspaces = await detachFromWorkspaces(workspaces, sessionId, warnings)
  } catch (error) {
    warnings.push(`workspace-account cleanup failed: ${String(error?.message ?? error)}`)
  }

  // The Session list is a Client projection fed by this forwarded event; the
  // Workspace upsert above removes an accounted row, and this removes an
  // ungrouped/archived row from every connected sidebar.
  try {
    emit?.('api-session/removed', sessionId)
  } catch (error) {
    warnings.push(`client notification failed: ${String(error?.message ?? error)}`)
  }

  for (const warning of warnings) logger?.warn?.(`session delete "${sessionId}": ${warning}`)

  return {
    deleted: true,
    sessionId,
    artifacts: directories.length,
    ...(closedLiveSession ? { closedLiveSession: true } : {}),
    ...(projectionCacheRemoved ? { projectionCacheRemoved: true } : {}),
    ...(detachedWorkspaces > 0 ? { detachedWorkspaces } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
