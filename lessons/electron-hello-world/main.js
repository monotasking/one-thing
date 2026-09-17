const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

// 页面通过 preload 喊 'ask-main' 时，在主进程里执行这个函数，把返回值送回去。
ipcMain.handle('ask-main', () => {
  return '这句字写在 main.js 里。页面没有 Node，自己编不出来。'
})

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
})
