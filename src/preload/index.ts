import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('rpc', (method: string, ...args: unknown[]) => ipcRenderer.invoke('rpc', method, args))
