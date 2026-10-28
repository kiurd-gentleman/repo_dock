import type { Handlers } from '../../main/handlers'

declare global {
  interface Window {
    rpc: (method: string, ...args: unknown[]) => Promise<unknown>
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
