const { app, BrowserWindow, ipcMain, globalShortcut, nativeImage } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 900,
        height: 600,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        
    });

    // Remove the menu bar
    win.setMenu(null);

    // Notify renderer of maximize state changes
    win.on('maximize', () => {
        win.webContents.send('window-maximized-state', true);
    });
    win.on('unmaximize', () => {
        win.webContents.send('window-maximized-state', false);
    });

    // Load the index.html of the app.
    win.loadFile('index.html');

    // Register a 'CommandOrControl+Alt+D' shortcut listener.
    globalShortcut.register('CommandOrControl+Alt+D', () => {
        win.webContents.send('toggle-connection');
    });

    // Register a dev tools toggle shortcut
    globalShortcut.register('CommandOrControl+Shift+S', () => {
        win.webContents.toggleDevTools();
    });
}

// Handle custom window controls IPC
ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
});

ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

// Handle connection badge requests from renderer
ipcMain.on('set-connection-badge', (event, connected) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && process.platform === 'win32') {
        if (connected) {
            // Simple 16x16 green square for "Connected" state
            const img = nativeImage.createFromPath(path.join(__dirname, 'assets/images/connected.png'));
            win.setOverlayIcon(img, 'Connected');
        } else {
            // Simple 16x16 red square for "Disconnected" state
            win.setOverlayIcon(null, '');
        }
    }
});

app.whenReady().then(createWindow);

app.on('will-quit', () => {
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
});