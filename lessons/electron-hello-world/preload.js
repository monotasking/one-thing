const { contextBridge, ipcRenderer } = require('electron')

// 这份脚本在「页面自己的 JS」之前跑。
// 它碰得到 Node / Electron；页面碰不到。
// 它只往页面上挂一个很小的对象，页面只能调这里公开的方法。
contextBridge.exposeInMainWorld('bridge', {
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
  askMain: () => ipcRenderer.invoke('ask-main'),
})
