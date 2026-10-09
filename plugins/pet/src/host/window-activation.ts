/** Correlated window activation on the Desktop parent's private process IPC. */

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
  const unavailable = (): Error => new Error('Desktop window activation is unavailable')
  const disconnect = (): void => {
    for (const request of pending.values()) request.reject(unavailable())
  }
  const message = (input: unknown): void => {
    if (typeof input !== 'object' || input === null || !('type' in input) || input.type !== 'window-activated'
      || !('requestId' in input) || typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId)
      || ('error' in input && typeof input.error !== 'string')) return
    const request = pending.get(input.requestId)
    if ('error' in input) request?.reject(new Error(input.error))
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
          timer = setTimeout(() => reject(new Error('Desktop window activation timed out')), deadlineMs)
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
