/**
 * Client half of the Session deletion plugin.
 *
 * Adds one row to a Session's "..." menu and one frame-wide confirmation
 * dialog. The actual deletion is a Host Remote call; the dialog reports Host
 * refusals (for example, the Session is still open) instead of hiding them.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-delete'
    const REMOTE_ENDPOINT = 'sessionDelete/delete'

    const EN = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Permanently delete this session?',
      'dialog.runningTitle': 'Stop and delete this session?',
      'dialog.body':
        'The chat history, workspace record, and cached data for “{title}” will be deleted permanently. This cannot be undone.',
      'dialog.untitled': 'Untitled session',
      'dialog.hint': 'An open session is closed first; deletion cannot be undone.',
      'dialog.runningHint':
        'This session is still running. Deleting it stops its current work first, then removes it permanently.',
      'action.cancel': 'Cancel',
      'action.delete': 'Delete permanently',
      'action.deleting': 'Deleting…',
      'error.live':
        'This session is still resident in the Harness process and could not be closed safely. Restart Harness, then retry.',
      'error.stopFailed': 'The session could not be closed: {message}',
      'error.notFound': 'This session no longer exists.',
      'error.storageUnavailable': 'The session store could not be located, so nothing was deleted.',
      'error.invalid': 'The session id is not valid for deletion.',
      'error.transport': 'The Host could not be reached, so nothing was deleted.',
      'error.failed': 'Deletion failed: {message}',
    }

    const ZH = {
      'menu.delete': '删除会话',
      'dialog.title': '永久删除这个会话？',
      'dialog.runningTitle': '停止并删除这个会话？',
      'dialog.body': '“{title}”的聊天记录、工作区记录与本地缓存将被永久删除，且无法恢复。',
      'dialog.untitled': '未命名会话',
      'dialog.hint': '打开中的会话会先被关闭；删除后无法恢复。',
      'dialog.runningHint': '这个会话仍在运行。删除会先停止它当前的工作，然后永久删除。',
      'action.cancel': '取消',
      'action.delete': '永久删除',
      'action.deleting': '正在删除…',
      'error.live': '这个会话仍被当前 Harness 进程占用，无法安全关闭。请重启 Harness 后重试。',
      'error.stopFailed': '无法关闭会话：{message}',
      'error.notFound': '这个会话已不存在。',
      'error.storageUnavailable': '无法定位会话存储，未执行删除。',
      'error.invalid': '会话 ID 不合法，无法删除。',
      'error.transport': '无法连接到 Host，未执行删除。',
      'error.failed': '删除失败：{message}',
    }

    // One dialog at a time. The menu and the overlay are separate slot
    // registrations, so they share this module-level request instead of a
    // React context that could not cross slot boundaries.
    let pending = null
    const listeners = new Set()

    function emitPending(next) {
      pending = next
      for (const listener of [...listeners]) listener()
    }

    function subscribePending(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    function readPending() {
      return pending
    }

    function requestDelete(session) {
      emitPending({
        sessionId: session.sessionId,
        title: session.title,
        running: session.running === true,
      })
    }

    function dismissDelete() {
      if (pending !== null) emitPending(null)
    }

    /**
     * Subscribe to locale changes so the dialog and menu relabel immediately
     * when the user switches language.
     * @param ctx - Client plugin context.
     * @returns the namespace-bound translate function.
     */
    function useTranslate(ctx) {
      React.useSyncExternalStore(
        (callback) => ctx.locale.subscribe(callback),
        () => ctx.locale.getSnapshot(),
        () => ctx.locale.getSnapshot(),
      )
      return ctx.locale.bind(NS)
    }

    /**
     * The Host Remote call used by the dialog. It deliberately mirrors the
     * generated Client Remote transport: a POST on `/api`, exact endpoint, and
     * `{ args }` payload; the Host validates and returns `RemoteResult`.
     * @param ctx - Client plugin context.
     * @param sessionId - Session to delete.
     * @returns the Host deletion receipt.
     */
    async function deleteOnHost(ctx, sessionId) {
      const connection = ctx.get('connection')
      if (connection === undefined) {
        const failure = new Error('connection unavailable')
        failure.code = 'transport'
        throw failure
      }
      let result
      try {
        result = await connection.rpc.call('/api', REMOTE_ENDPOINT, {
          args: { sessionId },
        })
      } catch (cause) {
        const failure = new Error(cause instanceof Error ? cause.message : String(cause))
        failure.code = 'transport'
        throw failure
      }
      if (result?.ok !== true) {
        const failure = new Error(result?.error?.message ?? 'session deletion failed')
        failure.code = result?.error?.code ?? 'session-delete/failed'
        throw failure
      }
      if (result.value?.deleted !== true) {
        const failure = new Error('session deletion returned no receipt')
        failure.code = 'session-delete/failed'
        throw failure
      }
      return result.value
    }

    function errorText(t, error) {
      switch (error?.code) {
        case 'session-delete/live':
          return t('error.live')
        case 'session-delete/not-found':
          return t('error.notFound')
        case 'session-delete/storage-unavailable':
          return t('error.storageUnavailable')
        case 'session-delete/stop-failed':
          return t('error.stopFailed', { message: error?.message ?? String(error) })
        case 'session-delete/invalid-id':
          return t('error.invalid')
        case 'transport':
          return t('error.transport')
        default:
          return t('error.failed', { message: error?.message ?? String(error) })
      }
    }

    function IconTrash({ size = 14, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className,
        },
        h('path', { d: 'M3 4.5h10' }),
        h('path', { d: 'M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1' }),
        h('path', { d: 'M4.5 4.5l.5 7.75c.03.43.39.75.82.75h4.36c.43 0 .79-.32.82-.75l.5-7.75' }),
        h('path', { d: 'M6.75 7.25v3.5M9.25 7.25v3.5' }),
      )
    }

    const MENU_CSS = `
.dsh-session-delete-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-session-delete-item:hover,
.dsh-session-delete-item:focus-visible {
  background: var(--dsw-alias-bg-layer-2);
  outline: none;
}
.dsh-session-delete-item:focus-visible {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dsh-session-delete-item .dsh-session-delete-icon {
  flex: none;
}
`

    const OVERLAY_CSS = `
.dsh-session-delete-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);
  pointer-events: auto;
}
.dsh-session-delete-dialog {
  width: min(420px, 100%);
  box-sizing: border-box;
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 18px 50px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
  color: var(--dsw-alias-label-primary);
  animation: dsh-session-delete-in 120ms ease-out;
}
.dsh-session-delete-badge {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-bottom: 12px;
  border-radius: 10px;
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);
}
.dsh-session-delete-dialog h2 {
  margin: 0 0 8px;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dsh-session-delete-dialog p {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-session-delete-dialog .dsh-session-delete-hint {
  margin-bottom: 14px;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-session-delete-error {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
}
.dsh-session-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.dsh-session-delete-button {
  min-width: 64px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dsh-session-delete-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-session-delete-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dsh-session-delete-button:disabled {
  cursor: default;
  opacity: 0.55;
}
.dsh-session-delete-button.dsh-session-delete-danger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-state-error-primary);
}
.dsh-session-delete-button.dsh-session-delete-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, var(--dsw-alias-bg-layer-1));
}
@keyframes dsh-session-delete-in {
  from { opacity: 0; transform: translateY(4px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-session-delete-dialog { animation: none; }
}
`

    /**
     * Build the menu row component for one Session occurrence.
     * @param ctx - Client plugin context.
     */
    function createMenuItem(ctx) {
      return function DeleteSessionMenuItem(props) {
        const t = useTranslate(ctx)
        const [, setMenuOpen] = props.useMenuOpenState()
        const running = props.useSessionStatus(
          (statuses) => statuses.get(props.sessionId)?.running === true,
        )

        return h(
          React.Fragment,
          null,
          h('style', { key: 'menu-style' }, MENU_CSS),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'dsh-session-delete-item',
              onClick: () => {
                setMenuOpen(false)
                requestDelete({
                  sessionId: props.sessionId,
                  title: props.displayTitle,
                  running,
                })
              },
            },
            h(IconTrash, { size: 14, className: 'dsh-session-delete-icon' }),
            h('span', null, t('menu.delete')),
          ),
        )
      }
    }

    /** Build the frame-wide confirmation overlay component. */
    function createOverlay(ctx) {
      return function DeleteSessionOverlay() {
        const t = useTranslate(ctx)
        const request = React.useSyncExternalStore(subscribePending, readPending, readPending)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const cancelRef = React.useRef(null)
        const confirmRef = React.useRef(null)
        const inFlightRef = React.useRef(false)

        React.useEffect(() => {
          if (request === null) {
            setBusy(false)
            setError(null)
            return undefined
          }
          setError(null)
          const focusTimer = setTimeout(() => cancelRef.current?.focus(), 0)
          return () => clearTimeout(focusTimer)
        }, [request])

        React.useEffect(() => {
          if (request === null) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation()
              dismissDelete()
            }
          }
          window.addEventListener('keydown', onKeyDown, true)
          return () => {
            window.removeEventListener('keydown', onKeyDown, true)
          }
        }, [request, busy])

        if (request === null) return h('style', null, OVERLAY_CSS)

        const title = request.title || t('dialog.untitled')

        const confirm = async () => {
          if (busy || inFlightRef.current) return
          inFlightRef.current = true
          setBusy(true)
          setError(null)
          try {
            await deleteOnHost(ctx, request.sessionId)
            dismissDelete()
          } catch (failure) {
            setError(errorText(t, failure))
          } finally {
            inFlightRef.current = false
            setBusy(false)
          }
        }

        return h(
          React.Fragment,
          null,
          h('style', null, OVERLAY_CSS),
          h(
            'div',
            {
              className: 'dsh-session-delete-backdrop',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget && !busy) dismissDelete()
              },
            },
            h(
              'div',
              {
                className: 'dsh-session-delete-dialog',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'dsh-session-delete-title',
                'aria-describedby': 'dsh-session-delete-desc',
                onKeyDown: (event) => {
                  if (event.key !== 'Tab') return
                  const first = cancelRef.current
                  const last = confirmRef.current
                  if (first === null || last === null) return
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                },
              },
              h(
                'div',
                { className: 'dsh-session-delete-badge' },
                h(IconTrash, { size: 20 }),
              ),
              h('h2', { id: 'dsh-session-delete-title' },
                request.running ? t('dialog.runningTitle') : t('dialog.title')),
              h('p', { id: 'dsh-session-delete-desc' }, t('dialog.body', { title })),
              h('p', { className: 'dsh-session-delete-hint' },
                request.running ? t('dialog.runningHint') : t('dialog.hint')),
              error !== null &&
                h('div', { className: 'dsh-session-delete-error', role: 'alert' }, error),
              h(
                'div',
                { className: 'dsh-session-delete-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-session-delete-button',
                    ref: cancelRef,
                    disabled: busy,
                    onClick: dismissDelete,
                  },
                  t('action.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-session-delete-button dsh-session-delete-danger',
                    ref: confirmRef,
                    disabled: busy,
                    onClick: confirm,
                  },
                  busy ? t('action.deleting') : t('action.delete'),
                ),
              ),
            ),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, 'en', EN),
          'session-delete.locale.en',
        )
        ctx.effect(
          () => ctx.locale.register(NS, 'zh', ZH),
          'session-delete.locale.zh',
        )
        ctx.effect(
          () => () => {
            pending = null
            listeners.clear()
          },
          'session-delete.dialog-state',
        )

        const MenuItem = createMenuItem(ctx)
        const Overlay = createOverlay(ctx)

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'dsh-session-delete.delete',
              order: 500,
            },
            MenuItem,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-session-delete.confirm',
              order: 50,
            },
            Overlay,
          ),
        )
      },
    }
  },
})
