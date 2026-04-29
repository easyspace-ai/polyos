import { contextBridge, ipcRenderer } from 'electron'

export type ShellApi = {
  ping: () => Promise<string>
  platform: NodeJS.Platform
}

const api: ShellApi = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<string>,
  platform: process.platform,
}

contextBridge.exposeInMainWorld('shell', api)
