import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('rpc', (method: string, ...args: unknown[]) => ipcRenderer.invoke('rpc', method, args))

/** Pushes from the main process (AI approvals, activity, repo changes). Returns an unsubscribe function. */
contextBridge.exposeInMainWorld('onEvent', (cb: (channel: string, payload: unknown) => void) => {
  const fn = (_e: unknown, channel: string, payload: unknown) => cb(channel, payload)
  ipcRenderer.on('event', fn)
  return () => ipcRenderer.removeListener('event', fn)
})
