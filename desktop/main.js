// Desktop shell for the RAS Hatchery monitor. Serves the built web app from the install folder through a secure
// app:// address and opens it in its own window. Data still comes from the Supabase cloud project.
const { app, BrowserWindow, Menu, protocol, net, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
if (!app.requestSingleInstanceLock()) app.quit()

let win
function create() {
  const kiosk = process.argv.includes('--kiosk')
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 600, title: 'RAS Hatchery', backgroundColor: '#f2f5f4',
    autoHideMenuBar: true, kiosk, fullscreen: kiosk,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', contextIsolation: true, sandbox: true },   // lets the alarm siren sound without a click
  })
  win.maximize()
  win.loadURL('app://ras/index.html')
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(() => {
  const root = path.join(__dirname, 'app')
  protocol.handle('app', req => {
    const p = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html'
    const f = path.normalize(path.join(root, p))
    if (!f.startsWith(root)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(f).toString())
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    { label: 'Tools', submenu: [
      { label: 'Open PLC gateway folder', click: () => shell.openPath(path.join(process.resourcesPath, 'gateway')) },
      { label: 'Developer tools', role: 'toggleDevTools' },
    ] },
  ]))
  create()
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
})
app.on('window-all-closed', () => app.quit())
