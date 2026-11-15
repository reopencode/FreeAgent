import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startServer, stopServer, type Connection } from './server'

let connection: Promise<Connection> | undefined
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'FreeAgent',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1a' : '#fbfaf8',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.freeagent.desktop')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    connection = startServer()
    connection.catch((err) => console.error('FreeAgent server failed to start:', err))

    ipcMain.handle('freeagent:connection', async () => {
      try {
        return { ok: true, ...(await connection!) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('freeagent:retry', async () => {
      stopServer()
      connection = startServer()
      try {
        return { ok: true, ...(await connection) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('freeagent:pick-folder', async () => {
      const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
      return res.canceled ? null : res.filePaths[0]
    })
    ipcMain.handle('freeagent:open-external', (_e, url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    })
    ipcMain.handle('freeagent:open-path', (_e, path: string) => shell.openPath(path))

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => stopServer())
}
