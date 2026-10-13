/** Correlated window activation on the Desktop parent's private process IPC. */

/** Expected activation failure, with a stable code independent of display text. */
export class WindowActivationError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Validate the Desktop PID supplied across the process environment. */
export function desktopActivationPid(value: string | undefined): string | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid < 0xffffffff ? value : undefined
}

/** Process transport used by the Host; no network listener or renderer receives it. */
export interface WindowActivationTransport {
  readonly connected: boolean
  send(message: object, callback: (error: Error | null) => void): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/** Create one activation caller; dispose rejects outstanding requests and detaches listeners. */
export function windowActivation(transport: WindowActivationTransport, deadlineMs = 2_000): {
  activate(): Promise<void>
  dispose(): void
} {
  let nextId = 1
  let disposed = false
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>()
  const unavailable = (): Error => new WindowActivationError('unavailable', 'Desktop window activation is unavailable')
  const disconnect = (): void => {
    for (const request of pending.values()) request.reject(new WindowActivationError('disconnect', 'Desktop window activation is unavailable: disconnected'))
  }
  const message = (input: unknown): void => {
    if (typeof input !== 'object' || input === null || !('type' in input) || input.type !== 'window-activated'
      || !('requestId' in input) || typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId)
      || ('error' in input && typeof input.error !== 'string')
      || ('errorCode' in input && typeof input.errorCode !== 'string')) return
    const request = pending.get(input.requestId)
    if ('error' in input) request?.reject(new WindowActivationError('errorCode' in input ? input.errorCode : 'unavailable', input.error))
    else request?.resolve()
  }
  transport.on('message', message)
  transport.on('disconnect', disconnect)
  return {
    async activate() {
      if (disposed || !transport.connected) throw unavailable()
      const requestId = nextId++
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          pending.set(requestId, { resolve, reject })
          timer = setTimeout(() => reject(new WindowActivationError('activation-timeout', 'Desktop window activation timed out')), deadlineMs)
          try {
            transport.send({ type: 'activate-window', requestId }, (error) => { if (error !== null) reject(error) })
          } catch (error) { reject(error) }
        })
      } finally {
        clearTimeout(timer)
        pending.delete(requestId)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      transport.off('message', message)
      transport.off('disconnect', disconnect)
      disconnect()
    },
  }
}
