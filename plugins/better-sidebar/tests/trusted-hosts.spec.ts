/** Every plugin route delegates admission to the live Host Connection. */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import type { SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

function request(method: string, url: string): SidebarHttpRequest {
  return {
    method, url,
    headers: { host: '127.0.0.1:3080', cookie: 'host-owned-cookie', origin: 'http://127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield '{"sessionId":"test-session"}' },
  }
}

function response() {
  return {
    statusCode: 0, body: '',
    writeHead(status: number) { this.statusCode = status },
    end(body?: string | Uint8Array) { this.body = body === undefined ? '' : body.toString() },
  } satisfies SidebarHttpResponse & { body: string }
}

function mount() {
  let refused: 401 | 403 | undefined
  const requestRejection = vi.fn((_request: Pick<SidebarHttpRequest, 'headers'>): 401 | 403 | undefined => refused)
  const routes: SidebarWebRoute[] = []
  const upgrades: SidebarWebUpgradeRoute[] = []
  const cleanups: Array<() => void> = []
  const ctx = {
    connection: { requestRejection },
    webServer: {
      register(route: SidebarWebRoute) { routes.push(route); return () => {} },
      registerUpgrade(route: SidebarWebUpgradeRoute) { upgrades.push(route); return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect(fn: () => void | (() => void)) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    inject: () => () => {}, on: () => () => {}, get: () => undefined,
  }
  apply(ctx as never)
  return { routes, upgrades, requestRejection, refuse(value: 401 | 403 | undefined) { refused = value }, cleanup() { for (const dispose of cleanups.reverse()) dispose() } }
}

const httpRoutes = ['/sidebar/api', '/sidebar/upload', '/sidebar/bundle', '/sidebar/archive', '/sidebar/file', '/sidebar/html']

describe('Host Connection admission', () => {
  it('requires Connection rather than the removed webRuntime service', () => {
    expect(inject).toEqual(['webServer', 'sessions', 'connection', 'tools'])
  })

  it.each([401, 403] as const)('returns %s on every HTTP route before reading any body', async status => {
    const host = mount()
    try {
      host.refuse(status)
      expect(host.routes.map(route => route.path)).toEqual(httpRoutes)
      for (const route of host.routes) {
        const req = request(route.path === '/sidebar/api' || route.path === '/sidebar/upload' ? 'POST' : 'GET', `${route.path}/missing`)
        const bodyRead = vi.fn()
        req[Symbol.asyncIterator] = async function* () { bodyRead(); throw new Error('refused request body was consumed') }
        const res = response()
        await route.handler(req, res)
        expect(res.statusCode, route.path).toBe(status)
        expect(res.body).toContain(status === 401 ? 'unauthorized' : 'forbidden')
        expect(bodyRead).not.toHaveBeenCalled()
        expect(host.requestRejection).toHaveBeenLastCalledWith(req)
      }
    } finally { host.cleanup() }
  })

  it('reads admission anew for each request and preserves headers', async () => {
    const host = mount()
    try {
      const route = host.routes.find(route => route.path === '/sidebar/api')!
      const req = request('POST', '/sidebar/api/session.cwd')
      host.refuse(401)
      const denied = response()
      await route.handler(req, denied)
      expect(denied.statusCode).toBe(401)
      host.refuse(undefined)
      const allowed = response()
      await route.handler(req, allowed)
      expect(allowed.statusCode).toBe(200)
      expect(host.requestRejection).toHaveBeenLastCalledWith(req)
      expect(req.headers.cookie).toBe('host-owned-cookie')
    } finally { host.cleanup() }
  })

  it.each([401, 403] as const)('destroys refused %s WebSocket handshakes before upgrade', async status => {
    const host = mount()
    try {
      host.refuse(status)
      expect(host.upgrades.map(route => route.path)).toEqual(['/sidebar/ws/agent-opens', '/sidebar/ws/fs-watch'])
      for (const route of host.upgrades) {
        const req = request('GET', `${route.path}?sessionId=test-session`)
        const socket = { destroy: vi.fn() }
        await route.handler(req, socket, new Uint8Array())
        expect(socket.destroy).toHaveBeenCalledOnce()
        expect(host.requestRejection).toHaveBeenLastCalledWith(req)
      }
    } finally { host.cleanup() }
  })
})
