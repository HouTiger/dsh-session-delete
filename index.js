/**
 * Host half of the Session deletion plugin.
 *
 * The operation is exposed to the Web Client as the Typert Gateway endpoint
 * `sessionDelete/delete`. This plugin intentionally imports nothing from the
 * dsh package tree: a profile-installed bundle resolves only its own files, so
 * the small Gateway contract it needs is installed directly:
 *
 * - a service registered with `ctx.provide()`, so Gateway source-mode discovery
 *   can find it through `ctx.reflect.props`;
 * - a `typertRemote` binding on the service;
 * - the `@Remote` marker descriptor on the service prototype.
 *
 * The marker key is the one `@deepseek-ai/dsh-typert-protocol` uses for its
 * public `Remote` decorator. Keeping the operation in source mode means no
 * generated codec/artifact is required for this single string argument.
 *
 * @module @local/dsh-session-delete
 */

import { deleteSession, SessionDeleteError } from './lib/delete-session.js'

/** Stable descriptor key read by `remoteMethods()` in dsh-typert-protocol. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const SERVICE_KEY = 'sessionDelete'

/** The one direct, unary Remote method this service exports. */
const REMOTE_METHODS = Object.freeze({
  version: 1,
  methods: Object.freeze([
    Object.freeze({
      method: 'delete',
      invocation: Object.freeze({ kind: 'direct' }),
    }),
  ]),
})

/**
 * Permanently removes a closed Session and its derived Host state.
 *
 * This is a plain service object rather than a `Service` subclass so the
 * bundle needs no dsh package imports; `ctx.provide()` gives it the same
 * fiber-owned lifecycle.
 */
class SessionDeleteService {
  /**
   * @param ctx - owning Host context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: SERVICE_KEY,
    })
  }

  /**
   * Permanently remove one Session.
   *
   * A Session that is still resident in this Harness process is closed first:
   * every activity provider is asked to stop, then the Agent's lifecycle scope
   * is disposed (which cancels the turn, closes the log handle, and detaches
   * the Session). Only then is the artifact removed. Archived sessions are
   * supported; archiving is only a durable filter.
   *
   * @param sessionId - the Session to delete.
   * @returns the deletion receipt (`{ deleted: true, sessionId, ... }`).
   */
  async delete(sessionId) {
    try {
      return await deleteSession({
        sessionId,
        sessions: this.ctx.sessions,
        agents: this.ctx.agents,
        persistence: this.ctx.sessionPersistence,
        workspaceRegistry: this.ctx.workspaceRegistry,
        storageDomain: this.ctx.get('storageDomain'),
        stopSessionActivity: (id) =>
          this.ctx.parallel('workspace/session-stop', { sessionId: id }),
        emit: (event, payload) => this.ctx.emit(event, payload),
        logger: this.ctx.logger,
      })
    } catch (error) {
      if (error instanceof SessionDeleteError) {
        // The Gateway carries a business RemoteError to the Client as
        // `{ ok: false, error: { code, message, details } }`.
        const failure = new Error(error.message)
        failure.name = 'RemoteError'
        failure.code = error.code
        failure.details = error.details
        failure.isDSHRemoteError = true
        throw failure
      }
      throw error
    }
  }
}

Object.defineProperty(SessionDeleteService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: REMOTE_METHODS,
})

export const inject = ['sessions', 'agents', 'sessionPersistence', 'workspaceRegistry']

/**
 * Install the service as a fiber-owned Host service.
 * @param ctx - owning Host context.
 */
export function apply(ctx) {
  const service = new SessionDeleteService(ctx)
  ctx.provide(SERVICE_KEY, service)
}

export { SessionDeleteService }
