// client/electron-main.js
// Native Desktop Application Window for On-Farm

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

let mainWindow = null;
let runnerProcess = null;

function waitForServer(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const req = http.get(url, (res) => {
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

app.disableHardwareAcceleration();

async function createWindow() {
  const iconPath = path.join(__dirname, 'public', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 850,
    minHeight: 600,
    title: 'On-Farm',
    icon: iconPath,
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Start internal background runner
  runnerProcess = fork(path.join(__dirname, 'runner.js'), [], {
    stdio: 'inherit', // Show output in terminal if opened
  });

  // Wait until runner server is fully ready and accepting connections
  const ready = await waitForServer('http://localhost:3789/status', 20000);
  if (ready) {
    mainWindow.loadURL('http://localhost:3789');
  } else {
    mainWindow.loadURL('http://localhost:3789');
  }

  // Handle external links (like Cashfree payment) in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (runnerProcess) {
      runnerProcess.kill();
      runnerProcess = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (runnerProcess) runnerProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
