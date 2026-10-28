import type { Handlers } from '../../main/handlers'

declare global {
  interface Window {
    rpc: (method: string, ...args: unknown[]) => Promise<unknown>
    onEvent: (cb: (channel: string, payload: unknown) => void) => () => void
  }
}

type Api = { [K in keyof Handlers]: (...args: Parameters<Handlers[K]>) => Promise<Awaited<ReturnType<Handlers[K]>>> }

/** Typed proxy: api.status(id) -> ipc 'rpc' -> handlers.status(id) in the main process. */
export const api = new Proxy({} as Api, {
  get: (_t, method: string) => async (...args: unknown[]) => {
    try {
      return await window.rpc(method, ...args)
    } catch (e) {
      throw new Error(String((e as Error).message).replace(/^Error invoking remote method 'rpc': (Error: )?/, ''))
    }
  }
})

/** Subscribes to pushes from the main process; returns an unsubscribe function. */
export const onEvent = <T,>(channel: string, cb: (payload: T) => void): (() => void) =>
  window.onEvent((c, p) => c === channel && cb(p as T))
