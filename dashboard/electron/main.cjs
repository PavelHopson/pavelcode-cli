const { app, BrowserWindow, shell, Menu, Tray, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const { ipcMain } = require('electron');
const { pathToFileURL } = require('url');

const isDev = !app.isPackaged;
let win = null;
let tray = null;
let safeOperatorExecutor = null;
const EXECUTE_CHANNEL = 'sentinel:operator:execute';
const operatorModuleUrl = pathToFileURL(
  path.resolve(__dirname, 'sentinel-safe-operator.mjs'),
).href;
const operatorModulePromise = import(operatorModuleUrl);

const officeRuntimeModulePath = isDev
  ? path.resolve(__dirname, '../../office/sentinel-office-runtime.mjs')
  : path.join(process.resourcesPath, 'office', 'sentinel-office-runtime.mjs');
const officeRuntimeModuleUrl = pathToFileURL(officeRuntimeModulePath).href;
const officeRuntimePromise = import(officeRuntimeModuleUrl)
  .then(({ createSentinelOfficeRuntime }) => createSentinelOfficeRuntime())
  .catch(() => null);


function isTrustedOperatorSender(event) {
  if (!win || event.sender !== win.webContents || !event.senderFrame) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return isDev
      ? senderUrl.origin === 'http://localhost:3939'
      : senderUrl.protocol === 'file:';
  } catch {
    return false;
  }
}

function projectOfficeSuccess(request, receipt) {
  void officeRuntimePromise.then((runtime) => {
    if (runtime) runtime.recordSuccess(request, receipt);
  }).catch(() => {});
}

function projectOfficeBlocked(request, error) {
  void officeRuntimePromise.then((runtime) => {
    if (runtime) runtime.recordBlocked(request, error);
  }).catch(() => {});
}

ipcMain.handle(EXECUTE_CHANNEL, async (event, request) => {
  if (!isTrustedOperatorSender(event)) {
    return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'IPC sender is not trusted' } };
  }

  try {
    const { createSafeOperatorExecutor } = await operatorModulePromise;
    if (!safeOperatorExecutor) {
      safeOperatorExecutor = createSafeOperatorExecutor({
        transport: 'electron-ipc',
        runtimeProvider: () => ({
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          electron: process.versions.electron,
          packaged: app.isPackaged,
        }),
      });
    }
    const receipt = safeOperatorExecutor.execute(request);
    projectOfficeSuccess(request, receipt);
    return { ok: true, receipt };
  } catch (error) {
    const { SafeOperatorError } = await operatorModulePromise;
    projectOfficeBlocked(request, error);
    return {
      ok: false,
      error: {
        code: error instanceof SafeOperatorError ? error.code : 'OPERATOR_FAILED',
        message: error instanceof SafeOperatorError ? error.message : 'Safe operator failed',
      },
    };
  }
});

Menu.setApplicationMenu(null);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Eclipse Sentinel',
    backgroundColor: '#05070A',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#05070A',
      symbolColor: '#6B7A8A',
      height: 40,
    },
    icon: path.join(__dirname, '../public/favicon.svg'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') void shell.openExternal(target.href);
    } catch {
      // Invalid and non-HTTPS URLs stay closed.
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Voice devices stay fail-closed until the dedicated hardware/dependency
  // audit can bind permission to an explicit operator action.
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  win.once('ready-to-show', () => win.show());

  // Minimize to tray instead of closing
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:3939');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function createTray() {
  // Simple 16x16 icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA1ElEQVQ4T2NkoBAwUqifYdAY8B8E/v//z8DIyMjAwMDAwMTExPAfJIeNDdIHMoORkZHhPzZNuNgg/SBDQJpBYtgMwGkzyDCQISDD/mNzFi5xcABB/QCKfBBgYmJi+I/NEFxiID9ADAH5AWQQLhtwGfIfqhakBqIRFEAgQ4jRzMjIyAgyBJshMEOwGQLSBzMEZgg2TdgMgbkemyEwf4LkCBqCbjOlhoBdBXI9uoNJCiRYKJBbUoLYIDUkGQKyGdtQIGgILI5wGYJNP4whIFeD/EisIQAvjYFpM/RLYAAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);
  tray.setToolTip('Eclipse Sentinel');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Открыть', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { win.show(); win.focus(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Global hotkey: Ctrl+Shift+S to toggle window
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit — stay in tray
  }
});

app.on('activate', () => {
  if (win) { win.show(); win.focus(); }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void officeRuntimePromise.then((runtime) => {
    if (runtime) runtime.dispose();
  }).catch(() => {});
});
