// client/electron-main.js
// Native Desktop Application Window for On-Farm
// Hardened with process isolation, token header injection & graceful CDP cleanup

const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');

let mainWindow = null;
let runnerProcess = null;
const RUNNER_PORT = 3789;
const LOCAL_RUNNER_TOKEN = crypto.randomBytes(32).toString('hex');

// Security: Prevent unauthorized debuggers or inspect flags
app.commandLine.appendSwitch('js-flags', '--noexpose_wasm');
if (process.execArgv.some(arg => arg.includes('--inspect') || arg.includes('--remote-debugging-port'))) {
  app.quit();
}

function waitForServer(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const req = http.get(url, {
        headers: { 'X-OnFarm-Token': LOCAL_RUNNER_TOKEN }
      }, (res) => {
        clearInterval(interval);
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      });
      req.setTimeout(800, () => {
        req.destroy();
      });
    }, 400);
  });
}

async function createWindow() {
  const iconPath = path.join(__dirname, 'public', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 880,
    minHeight: 620,
    title: 'On-Farm',
    icon: iconPath,
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    },
  });

  // Security: Prevent inspecting element or opening DevTools
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Automatically inject security token header into all local runner requests
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1:3789/*', 'http://localhost:3789/*'] },
    (details, callback) => {
      details.requestHeaders['X-OnFarm-Token'] = LOCAL_RUNNER_TOKEN;
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Start internal background runner (uses hardened/obfuscated runner in dist-protected if built)
  const fs = require('fs');
  const protectedRunner = path.join(__dirname, 'dist-protected', 'runner.js');
  const runnerScript = fs.existsSync(protectedRunner) ? protectedRunner : path.join(__dirname, 'runner.js');

  runnerProcess = fork(runnerScript, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ONFARM_PANEL_TOKEN: LOCAL_RUNNER_TOKEN,
    },
  });

  // Wait until runner server is fully ready and accepting connections
  const ready = await waitForServer(`http://127.0.0.1:${RUNNER_PORT}/status`, 20000);
  mainWindow.loadURL(`http://127.0.0.1:${RUNNER_PORT}`);

  // Handle external links (like Cashfree payment) in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanupProcesses();
  });
}

function cleanupProcesses() {
  if (runnerProcess) {
    try {
      runnerProcess.send('shutdown');
    } catch {}
    setTimeout(() => {
      if (runnerProcess) {
        try { runnerProcess.kill(); } catch {}
        runnerProcess = null;
      }
    }, 1200);
  }
}

app.whenReady().then(createWindow);

app.on('before-quit', cleanupProcesses);

app.on('window-all-closed', () => {
  cleanupProcesses();
  if (process.platform !== 'darwin') app.quit();
});
