const { app, BrowserWindow, shell, Menu, Tray, globalShortcut, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const { existsSync } = require('fs');
const { ipcMain } = require('electron');
const { pathToFileURL } = require('url');

// The desktop product was renamed to Eclipse Ultron, but the existing local
// Chromium profile remains the stable data boundary for sessions and settings.
// Set it before app readiness so an upgrade never creates an empty parallel profile.
app.setPath('userData', path.join(app.getPath('appData'), 'Eclipse Sentinel'));

const isDev = !app.isPackaged;
let win = null;
let tray = null;
let safeOperatorExecutor = null;
let labOllamaProcess = null;
const EXECUTE_CHANNEL = 'sentinel:operator:execute';
const VOICE_LISTEN_CHANNEL = 'sentinel:voice:listen-once';
const VOICE_OUTPUT_LIMIT_BYTES = 8 * 1024;
const VOICE_PROCESS_TIMEOUT_MS = 25_000;
const VOICE_RATE_LIMIT_MS = 1_500;
const VOICE_MODEL_WARMUP_URL = 'http://127.0.0.1:11434/api/generate';
const VOICE_MODEL_WARMUP_TIMEOUT_MS = 120_000;
let voiceListenInFlight = false;
let voiceLastStartedAt = 0;
const operatorModuleUrl = pathToFileURL(
  path.resolve(__dirname, 'sentinel-safe-operator.mjs'),
).href;
const operatorModulePromise = import(operatorModuleUrl);

const officeRuntimeModulePath = isDev
  ? path.resolve(__dirname, '../../office/sentinel-office-runtime.mjs')
  : path.join(process.resourcesPath, 'office', 'sentinel-office-runtime.mjs');
const officeRuntimeModuleUrl = pathToFileURL(officeRuntimeModulePath).href;
const windowIconPath = isDev
  ? path.resolve(__dirname, '../build/eclipse-sentinel.ico')
  : path.join(process.resourcesPath, 'brand', 'eclipse-sentinel.ico');
const officeRuntimePromise = import(officeRuntimeModuleUrl)
  .then(({ createSentinelOfficeRuntime }) => createSentinelOfficeRuntime())
  .catch(() => null);

const voiceScriptPath = isDev
  ? path.resolve(__dirname, '../../scripts/sentinel-stt.ps1')
  : path.join(process.resourcesPath, 'voice', 'sentinel-stt.ps1');
const eclipseProgramsRoot = isDev
  ? path.join(path.parse(__dirname).root, 'ADMIN_HOPSON_PC', 'Программы')
  : path.dirname(path.dirname(process.execPath));
const eclipseAiRuntimeRoot = process.env.ECLIPSE_AI_RUNTIME_DIR
  ? path.resolve(process.env.ECLIPSE_AI_RUNTIME_DIR)
  : path.join(eclipseProgramsRoot, 'Eclipse AI Runtime');
const labOllamaExecutable = path.join(eclipseAiRuntimeRoot, 'ollama', 'ollama.exe');
const labOllamaModels = path.join(eclipseAiRuntimeRoot, 'models', 'ollama');

function isLabOllamaListening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 11435 });
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function ensureLabOllamaServer() {
  if (!existsSync(labOllamaExecutable) || await isLabOllamaListening()) return;

  const child = spawn(labOllamaExecutable, ['serve'], {
    env: {
      ...process.env,
      OLLAMA_HOST: '127.0.0.1:11435',
      OLLAMA_MODELS: labOllamaModels,
      OLLAMA_KEEP_ALIVE: '5m',
      OLLAMA_LOAD_TIMEOUT: '15m',
    },
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  labOllamaProcess = child;
  child.once('error', () => {
    if (labOllamaProcess === child) labOllamaProcess = null;
  });
  child.once('exit', () => {
    if (labOllamaProcess === child) labOllamaProcess = null;
  });
}

async function warmPrimaryVoiceModel() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VOICE_MODEL_WARMUP_TIMEOUT_MS);
  try {
    const response = await fetch(VOICE_MODEL_WARMUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3:8b',
        prompt: '',
        stream: false,
        keep_alive: '30m',
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    await response.arrayBuffer();
  } catch {
    // Voice UI remains usable and reports provider failures explicitly.
  } finally {
    clearTimeout(timeoutId);
  }
}


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

function parseVoicePayload(output) {
  try {
    const payload = JSON.parse(output.trim());
    if (payload?.ok === false && typeof payload.code === 'string') {
      const safeErrors = {
        WHISPER_RUNTIME_MISSING: 'Локальный голосовой runtime не найден. Переустановите Eclipse AI Runtime на диске E:.',
        WHISPER_RUNTIME_INVALID: 'Путь к локальному голосовому runtime некорректен.',
        WHISPER_MODEL_MISSING: 'Локальная модель распознавания речи не найдена.',
        WHISPER_MODEL_INVALID: 'Локальная модель распознавания речи повреждена или несовместима.',
        WHISPER_START_FAILED: 'Не удалось запустить локальный Whisper runtime.',
        RUSSIAN_SPEECH_PACK_MISSING: 'Локальный Whisper недоступен, а русский Windows Speech не установлен.',
        MICROPHONE_UNAVAILABLE: 'Микрофон недоступен. Проверьте разрешения Windows и устройство ввода по умолчанию.',
        NO_SPEECH_RECOGNIZED: 'Речь не распознана. Нажмите ещё раз и говорите обычным голосом рядом с микрофоном.',
      };
      const message = safeErrors[payload.code];
      if (message) return { ok: false, error: { code: payload.code, message } };
    }
    if (!payload || payload.ok !== true || typeof payload.text !== 'string') {
      return { ok: false, error: { code: 'VOICE_NOT_RECOGNIZED', message: 'Речь не распознана. Попробуйте ещё раз.' } };
    }

    const text = payload.text.trim().slice(0, 500);
    if (!text) {
      return { ok: false, error: { code: 'VOICE_NOT_RECOGNIZED', message: 'Речь не распознана. Попробуйте ещё раз.' } };
    }

    const parsedConfidence = Number(payload.confidence);
    const confidence = Number.isFinite(parsedConfidence)
      ? Math.max(0, Math.min(1, parsedConfidence))
      : null;
    return { ok: true, text, confidence };
  } catch {
    return { ok: false, error: { code: 'VOICE_INVALID_OUTPUT', message: 'Локальный модуль речи вернул некорректный ответ.' } };
  }
}

function runLocalVoiceRecognition() {
  return new Promise((resolve) => {
    let stdout = '';
    let outputBytes = 0;
    let settled = false;

    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      voiceScriptPath,
      '-TimeoutSeconds',
      '12',
      '-RuntimeRoot',
      eclipseAiRuntimeRoot,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: { code: 'VOICE_TIMEOUT', message: 'Время ожидания речи истекло.' } });
    }, VOICE_PROCESS_TIMEOUT_MS);

    const consume = (chunk, capture) => {
      outputBytes += chunk.length;
      if (outputBytes > VOICE_OUTPUT_LIMIT_BYTES) {
        child.kill();
        finish({ ok: false, error: { code: 'VOICE_OUTPUT_LIMIT', message: 'Локальный модуль речи превысил допустимый объём ответа.' } });
        return;
      }
      if (capture) stdout += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.on('error', () => {
      finish({ ok: false, error: { code: 'VOICE_UNAVAILABLE', message: 'Локальное распознавание речи недоступно.' } });
    });
    child.on('close', () => finish(parseVoicePayload(stdout)));
  });
}

ipcMain.handle(VOICE_LISTEN_CHANNEL, async (event, ...args) => {
  if (!isTrustedOperatorSender(event)) {
    return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'IPC sender is not trusted' } };
  }
  if (args.length !== 0) {
    return { ok: false, error: { code: 'VOICE_INPUT_REJECTED', message: 'Голосовой канал не принимает параметры.' } };
  }
  if (voiceListenInFlight) {
    return { ok: false, error: { code: 'VOICE_BUSY', message: 'Распознавание уже выполняется.' } };
  }

  const now = Date.now();
  if (now - voiceLastStartedAt < VOICE_RATE_LIMIT_MS) {
    return { ok: false, error: { code: 'VOICE_RATE_LIMITED', message: 'Подождите секунду перед повторным запуском.' } };
  }

  voiceListenInFlight = true;
  voiceLastStartedAt = now;
  try {
    return await runLocalVoiceRecognition();
  } finally {
    voiceListenInFlight = false;
  }
});

Menu.setApplicationMenu(null);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Eclipse Ultron',
    backgroundColor: '#050507',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#050507',
      symbolColor: '#C7CDD6',
      height: 40,
    },
    icon: windowIconPath,
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
  const icon = nativeImage.createFromPath(windowIconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Eclipse Ultron');

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
  void warmPrimaryVoiceModel();
  void ensureLabOllamaServer();

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
  if (labOllamaProcess && !labOllamaProcess.killed) {
    labOllamaProcess.kill();
    labOllamaProcess = null;
  }
  void officeRuntimePromise.then((runtime) => {
    if (runtime) runtime.dispose();
  }).catch(() => {});
});
