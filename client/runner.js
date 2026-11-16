// client/runner.js
// Secure On-Farm Desktop Runner with HWID Protection and In-Memory Script Execution

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const axios = require('axios');
const { chromium } = require('playwright');
const { getHardwareId } = require('./hwid');
const { decryptInMemory } = require('./security');
const { spawn } = require('child_process');

const CLIENT_VERSION = '1.0.0';
const PANEL_PORT = 3789;
const CDP_PORT = 9222;

// Cloud backend URL (change to production URL when deployed to Vercel/Render)
const CLOUD_URL = process.env.ONFARM_CLOUD_URL || 'http://localhost:4000';

// In-Memory state
const state = {
  isOnline: true,
  isRunning: false,
  stopRequested: false,
  hwid: getHardwareId(),
  user: null,
  walletBalance: 0,
  subscription: null,
  totalRows: 0,
  processedCount: 0,
  currentRow: null,
  lastError: null,
  logs: [],
};

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
  console.log(line);
}

// -------------------------------------------------------------------------
// 1. MANDATORY INTERNET CHECK & AUTO-UPDATE CHECK
// -------------------------------------------------------------------------
async function checkCloudConnectivity() {
  try {
    const res = await axios.get(`${CLOUD_URL}/api/health`, { timeout: 4000 });
    state.isOnline = res.data && res.data.ok;
    return state.isOnline;
  } catch {
    state.isOnline = false;
    return false;
  }
}

async function verifyVersionGate() {
  try {
    const res = await axios.get(`${CLOUD_URL}/api/config`, { timeout: 5000 });
    if (res.data && res.data.config && res.data.config.version_gate) {
      const gate = res.data.config.version_gate;
      if (gate.min_supported_version && gate.min_supported_version > CLIENT_VERSION) {
        log(`CRITICAL: Naya version uplabdh hai (${gate.latest_version}). Aage badhne ke liye update anivarya hai.`);
        throw new Error(`COMPULSORY_UPDATE_REQUIRED: Kripya latest version download karein: ${gate.update_url || 'https://onfarm-tech.vercel.app'}`);
      }
    }
  } catch (err) {
    if (err.message.includes('COMPULSORY_UPDATE')) throw err;
  }
}

// -------------------------------------------------------------------------
// 2. CHROME AUTO-DETECTION & CDP CONNECTION
// -------------------------------------------------------------------------
function findChromeExecutable() {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let browserInstance = null;
let browserContext = null;

async function connectBrowser() {
  if (browserInstance) {
    try {
      await browserContext.pages();
      return;
    } catch {
      browserInstance = null;
      browserContext = null;
    }
  }

  const profileDir = path.join(__dirname, '..', 'browser-profile');
  let alreadyRunning = false;
  try {
    const res = await axios.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 1500 });
    if (res.status === 200) alreadyRunning = true;
  } catch { /* not running */ }

  if (!alreadyRunning) {
    const chromePath = findChromeExecutable();
    if (!chromePath) {
      throw new Error('Google Chrome computer me nahi mila. Kripya Google Chrome install karein.');
    }

    log(`Chrome launch ho raha hai: ${chromePath}`);
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--start-maximized',
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await axios.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 1000 });
        if (r.status === 200) { log('Chrome ready hai!'); break; }
      } catch { /* wait */ }
    }
  }

  browserInstance = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  browserContext = browserInstance.contexts()[0] || await browserInstance.newContext();
}

async function getActivePage() {
  await connectBrowser();
  const allPages = browserContext.pages();
  const formPages = allPages.filter(p => {
    const url = p.url();
    return !url.startsWith('about:') &&
      !url.startsWith('chrome:') &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('https://localhost');
  });

  if (!formPages.length) {
    throw new Error('Government form wala tab nahi mila. Chrome me portal login karke form open karein.');
  }

  const activePage = formPages[formPages.length - 1];
  await activePage.bringToFront();
  return activePage;
}

// -------------------------------------------------------------------------
// 3. IN-MEMORY AUTOMATION EXECUTION (RAM ONLY)
// -------------------------------------------------------------------------
async function executeAutomation() {
  if (state.isRunning) return;
  state.isRunning = true;
  state.stopRequested = false;
  state.lastError = null;

  try {
    // 1. Internet Check
    const online = await checkCloudConnectivity();
    if (!online) throw new Error('Internet connection toot gaya hai. Kripya internet jodein.');

    // 2. Fetch Encrypted Payload into RAM
    log('Cloud server se secure automation logic verify ho raha hai...');
    const payloadRes = await axios.post(`${CLOUD_URL}/api/script/fetch-payload`, {
      userId: state.user.id,
      hwid: state.hwid,
    }, { timeout: 8000 });

    if (!payloadRes.data.ok) {
      throw new Error(payloadRes.data.message || 'Script fetch failed');
    }

    // 3. Decrypt directly in memory
    const decryptedJsCode = decryptInMemory(payloadRes.data.encrypted_code, payloadRes.data.iv);
    log(`Logic v${payloadRes.data.version} safely loaded into RAM!`);

    // 4. Load Excel Sheet
    const ExcelJS = require('exceljs');
    const excelPath = path.join(__dirname, '..', 'form automation', 'farmers.xlsx');
    if (!fs.existsSync(excelPath)) throw new Error(`farmers.xlsx file nahi mili: ${excelPath}`);

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(excelPath);
    } catch (e) {
      if (e.code === 'EBUSY') throw new Error('farmers.xlsx Excel me khuli hui hai! Kripya Excel file band karke START karein.');
      throw e;
    }
    const ws = wb.worksheets[0];

    // Read rows
    const headerRow = ws.getRow(1);
    const colIndex = {};
    headerRow.eachCell((c, colNumber) => { colIndex[String(c.value || '').trim()] = colNumber; });

    const rows = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const status = String(row.getCell(colIndex['Status'] || 8).value || '').trim().toUpperCase();
      if (status !== 'DONE') {
        rows.push({
          rowNumber,
          Name: String(row.getCell(colIndex['Name'] || 1).value || '').trim(),
          Crop: String(row.getCell(colIndex['Crop'] || 2).value || '').trim(),
          SowingDateRaw: row.getCell(colIndex['SowingDate'] || 3).value,
          Ownership: String(row.getCell(colIndex['Ownership'] || 4).value || '').trim(),
          KhasraNo: String(row.getCell(colIndex['KhasraNo'] || 5).value || '').trim(),
          KhataNo: String(row.getCell(colIndex['KhataNo'] || 6).value || '').trim(),
          FarmerName: colIndex['FarmerName'] ? String(row.getCell(colIndex['FarmerName']).value || '').trim() : '',
          Status: status,
        });
      }
    });

    state.totalRows = ws.rowCount - 1;
    state.processedCount = state.totalRows - rows.length;

    if (!rows.length) {
      log('Sabhi rows pehle se DONE hain!');
      return;
    }

    const page = await getActivePage();

    // 5. In-Memory Dynamic Execution Module
    // Evaluates decrypted JS code into in-memory function
    const inMemoryModule = { exports: {} };
    const runnerFunc = new Function('module', 'exports', 'require', decryptedJsCode);
    runnerFunc(inMemoryModule, inMemoryModule.exports, require);
    const formActions = inMemoryModule.exports;

    log(`Batch start: ${rows.length} pending rows.`);

    for (let i = 0; i < rows.length; i++) {
      if (state.stopRequested) { log('Operator ne automation pause kiya.'); break; }
      const r = rows[i];
      const isLastRow = (i === rows.length - 1);

      state.currentRow = r;
      log(`[${i + 1}/${rows.length}] Filling: ${r.Name} | Khasra: ${r.KhasraNo}`);

      // Call in-memory action routine
      if (formActions.processFarmerRow) {
        await formActions.processFarmerRow(page, r, isLastRow, log);
      } else {
        // Fallback default actions
        await formActions.selectCrop(page, r.Crop);
        await formActions.selectSowingDate(page, r.SowingDateRaw);
        await formActions.selectOwnership(page, r.Ownership);
        await formActions.fillKhata(page, r.KhasraNo);
        await formActions.fillKhasra(page, r.KhataNo);
        await formActions.clickVerify(page);
        await page.waitForTimeout(1500);
        await formActions.selectRadio(page, r.FarmerName);
        await formActions.clickPopupSubmit(page);
        if (isLastRow) {
          await formActions.clickSubmit(page);
        } else {
          await formActions.clickAddCrop(page);
        }
      }

      // 6. Deduct ₹1 per kila or log subscription entry
      const deductRes = await axios.post(`${CLOUD_URL}/api/kila/deduct`, {
        userId: state.user.id,
        hwid: state.hwid,
        kilaNumber: r.KhasraNo,
      });

      if (!deductRes.data.ok) {
        throw new Error(deductRes.data.message || 'Balance insufficient to continue.');
      }
      state.walletBalance = deductRes.data.remaining_balance;

      // Mark row DONE in Excel
      ws.getRow(r.rowNumber).getCell(colIndex['Status'] || 8).value = 'DONE';
      ws.getRow(r.rowNumber).getCell(colIndex['Error'] || 9).value = '';
      await wb.xlsx.writeFile(excelPath);

      state.processedCount++;
      log(`Done: ${r.Name} | Wallet Balance: ₹${state.walletBalance}`);
    }
  } catch (err) {
    state.lastError = err.message;
    log(`ERROR: ${err.message}`);
  } finally {
    state.isRunning = false;
    state.currentRow = null;
  }
}

// -------------------------------------------------------------------------
// 4. LOCAL WEB CONTROL PANEL (EXPRESS)
// -------------------------------------------------------------------------
function startControlPanel() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/status', (req, res) => {
    res.json({
      isOnline: state.isOnline,
      isRunning: state.isRunning,
      hwid: state.hwid,
      user: state.user,
      walletBalance: state.walletBalance,
      subscription: state.subscription,
      totalRows: state.totalRows,
      processedCount: state.processedCount,
      currentRow: state.currentRow,
      lastError: state.lastError,
      logs: state.logs.slice(-30),
    });
  });

  app.post('/start', (req, res) => {
    executeAutomation();
    res.json({ ok: true });
  });

  app.post('/stop', (req, res) => {
    state.stopRequested = true;
    log('STOP request mila — safe point par pause hoga.');
    res.json({ ok: true });
  });

  app.post('/reset-excel', async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const excelPath = path.join(__dirname, '..', 'form automation', 'farmers.xlsx');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(excelPath);
      const ws = wb.worksheets[0];
      ws.eachRow((r, i) => {
        if (i > 1) {
          r.getCell(8).value = '';
          r.getCell(9).value = '';
        }
      });
      await wb.xlsx.writeFile(excelPath);
      state.processedCount = 0;
      state.lastError = null;
      log('Excel sheet Status & Error clear ho gaye.');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.post('/create-payment', async (req, res) => {
    try {
      const { type, amount } = req.body;
      const orderRes = await axios.post(`${CLOUD_URL}/api/pay/create-order`, {
        userId: state.user.id,
        type,
        customAmount: amount,
      });
      const sessionUrl = `https://payments.cashfree.com/order/#${orderRes.data.payment_session_id}`;
      res.json({
        ok: true,
        payment_link: sessionUrl,
        payment_session_id: orderRes.data.payment_session_id,
        orderData: orderRes.data,
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.response ? e.response.data.message : e.message });
    }
  });

  app.post('/verify-payment', async (req, res) => {
    try {
      const { orderId } = req.body;
      const verifyRes = await axios.post(`${CLOUD_URL}/api/pay/verify`, { orderId });
      // Re-fetch user balance
      if (verifyRes.data.ok) {
        const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
          phone: state.user.phone,
          hwid: state.hwid,
        });
        if (loginRes.data.ok) {
          state.walletBalance = loginRes.data.wallet.balance;
          state.subscription = loginRes.data.subscription;
        }
      }
      res.json(verifyRes.data);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.listen(PANEL_PORT, () => {
    log(`Control Panel open hai: http://localhost:${PANEL_PORT}`);
  });
}

// -------------------------------------------------------------------------
// 5. MAIN ENTRY POINT
// -------------------------------------------------------------------------
async function main() {
  console.log(`\n======================================================`);
  console.log(`  ON-FARM DESKTOP RUNNER v${CLIENT_VERSION}`);
  console.log(`  Hardware ID: ${state.hwid}`);
  console.log(`======================================================\n`);

  // Step 1: Internet Handshake
  log('Cloud connectivity check...');
  const isOnline = await checkCloudConnectivity();
  if (!isOnline) {
    log('WARNING: Cloud backend se connect nahi ho paya. Offline mode lock active.');
  }

  // Step 2: Version Gate
  await verifyVersionGate();

  // Step 3: Login Handshake with HWID Binding
  try {
    const operatorPhone = process.env.OPERATOR_PHONE || '9999999999';
    const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
      phone: operatorPhone,
      hwid: state.hwid,
      name: 'Default Operator',
    });

    if (loginRes.data.ok) {
      state.user = loginRes.data.user;
      state.walletBalance = loginRes.data.wallet.balance;
      state.subscription = loginRes.data.subscription;
      log(`Welcome ${state.user.name}! Plan: ${state.subscription ? '₹699 Pass' : 'Wallet (₹' + state.walletBalance + ')'}`);
    }
  } catch (err) {
    log(`Login error: ${err.response ? err.response.data.message : err.message}`);
  }

  // Step 4: Start local UI
  startControlPanel();
}

main().catch(err => {
  console.error('Fatal startup error:', err);
});
