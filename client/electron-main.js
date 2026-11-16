// client/electron-main.js
// Native Desktop Application Window for On-Farm

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow = null;
let runnerProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'On-Farm — Intelligent Crop Insurance Automation',
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Start internal background runner
  runnerProcess = fork(path.join(__dirname, 'runner.js'), [], {
    stdio: 'ignore',
  });

  // Wait 1.5 seconds for runner to start on port 3789 then load UI
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3789');
  }, 1500);

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
