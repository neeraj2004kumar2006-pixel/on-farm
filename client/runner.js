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

// Cloud backend URL (Points to 24/7 Vercel Cloud Server)
const CLOUD_URL = process.env.ONFARM_CLOUD_URL || 'https://on-farm.vercel.app';
const SESSION_CACHE_FILE = path.join(__dirname, 'user-session.json');

// Restore cached session if available so UI never flashes ₹0
let initialBalance = 1;
let initialUser = null;
let initialSubscription = null;
try {
  if (fs.existsSync(SESSION_CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(SESSION_CACHE_FILE, 'utf8'));
    if (typeof cached.walletBalance === 'number') initialBalance = cached.walletBalance;
    if (cached.user) initialUser = cached.user;
    if (cached.subscription !== undefined) initialSubscription = cached.subscription;
  }
} catch {}

// In-Memory state
const state = {
  isOnline: true,
  isRunning: false,
  stopRequested: false,
  hwid: getHardwareId(),
  user: initialUser,
  walletBalance: initialBalance,
  subscription: initialSubscription,
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

    if (!state.user || !state.user.id) {
      await syncUserBalance();
      if (!state.user || !state.user.id) {
        throw new Error('Operator mobile number not linked. Please click "Link Mobile No." in the app header.');
      }
    }

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
// Khasra 18-digit Code Generator
function makeKhasra(muraMain, muraSub = 0, kilaMain = 0, kilaSub = 0) {
  const leading = '0'.repeat(11 - String(muraMain).length);
  const sub2 = String(muraSub || 0).padStart(2, '0');
  const k2 = String(kilaMain || 0).padStart(2, '0');
  const ks2 = String(kilaSub || 0).padStart(2, '0');
  return leading + muraMain + '0' + sub2 + k2 + ks2;
}

function parseKilasInput(kilasStr, subKilasStr = '') {
  // Parse sub-kilas overrides first, e.g. "1/1, 10/1, 11/1, 20/1, 21/1"
  const subMap = new Map();
  if (subKilasStr) {
    const subItems = String(subKilasStr).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    for (const item of subItems) {
      const match = item.match(/^(\d+)(?:[\/\.](\d+))?$/);
      if (match) {
        const m = parseInt(match[1], 10);
        const s = parseInt(match[2] || 0, 10);
        if (!subMap.has(m)) subMap.set(m, []);
        subMap.get(m).push({ main: m, sub: s });
      }
    }
  }

  const items = String(kilasStr).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const result = [];
  for (const item of items) {
    const rangeMatch = item.match(/^(\d+)\s*(?:-|to)\s*(\d+)$/i);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10);
      const to = parseInt(rangeMatch[2], 10);
      for (let k = from; k <= to; k++) {
        if (subMap.has(k)) {
          // Replace with specific sub-kila(s)
          for (const subItem of subMap.get(k)) {
            result.push(subItem);
          }
        } else {
          result.push({ main: k, sub: 0 });
        }
      }
    } else {
      const subMatch = item.match(/^(\d+)(?:[\/\.](\d+))?$/);
      if (subMatch) {
        result.push({ main: parseInt(subMatch[1], 10), sub: parseInt(subMatch[2] || 0, 10) });
      }
    }
  }
  return result;
}

function startControlPanel() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Save reviewed/edited rows directly to farmers.xlsx
  app.post('/save-excel-rows', async (req, res) => {
    try {
      const { rows, append = false } = req.body;
      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ ok: false, message: 'Koi kila row save karne ke liye nahi mili.' });
      }

      const ExcelJS = require('exceljs');
      const excelPath = path.join(__dirname, '..', 'form automation', 'farmers.xlsx');
      const wb = new ExcelJS.Workbook();
      let ws;

      if (append && fs.existsSync(excelPath)) {
        await wb.xlsx.readFile(excelPath);
        ws = wb.worksheets[0];
      } else {
        ws = wb.addWorksheet('Farmers');
        ws.addRow(['Name', 'Crop', 'SowingDate', 'Ownership', 'KhasraNo', 'KhataNo', 'FarmerName', 'Status', 'Error']);
        ws.getColumn(1).width = 18;
        ws.getColumn(2).width = 24;
        ws.getColumn(3).width = 14;
        ws.getColumn(4).width = 12;
        ws.getColumn(5).width = 22; // 18-digit KhasraNo
        ws.getColumn(6).width = 12; // KhataNo
        ws.getColumn(7).width = 18; // FarmerName
        ws.getColumn(8).width = 10; // Status
        ws.getColumn(9).width = 25; // Error
        ws.getColumn(5).numFmt = '@';
        ws.getColumn(6).numFmt = '@';
      }

      for (const r of rows) {
        const addedRow = ws.addRow([
          (r.name || '').trim(),
          (r.crop || '').trim(),
          (r.sowingDate || '').trim(),
          (r.ownership || 'Owner').trim(),
          String(r.khasraNo || '').trim(),
          String(r.khataNo || '').trim(),
          (r.farmerName || r.name || '').trim(),
          (r.status || '').trim(),
          (r.error || '').trim(),
        ]);
        addedRow.getCell(5).value = String(r.khasraNo || '').trim();
        addedRow.getCell(5).numFmt = '@';
        addedRow.getCell(6).value = String(r.khataNo || '').trim();
        addedRow.getCell(6).numFmt = '@';
      }

      await wb.xlsx.writeFile(excelPath);
      state.totalRows = ws.rowCount - 1;
      state.processedCount = 0;
      log(`Records Saved: ${rows.length} entries successfully saved.`);

      res.json({
        ok: true,
        count: rows.length,
        message: `${rows.length} records successfully saved.`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Excel Generator API (App se direct Kila aur Farmer add karna)
  app.post('/generate-excel', async (req, res) => {
    try {
      const { name, crop, sowingDate, ownership, khataNo, muraMain, muraSub, murabbaInput, kilasInput, subKilasInput, append = false } = req.body;
      let main = parseInt(muraMain, 10) || 0;
      let sub = parseInt(muraSub, 10) || 0;
      if (murabbaInput) {
        const parts = String(murabbaInput).trim().split(/[\/\.]/);
        main = parseInt(parts[0], 10) || 0;
        sub = parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0;
      }

      if (!name || !crop || !sowingDate || !khataNo || !main || !kilasInput) {
        return res.status(400).json({ ok: false, message: 'All required fields (Name, Crop, Sowing Date, Khata, Murabba, Kilas) must be filled.' });
      }

      const parsedKilas = parseKilasInput(kilasInput, subKilasInput);
      if (!parsedKilas.length) {
        return res.status(400).json({ ok: false, message: 'Koi valid kila number nahi mila. Jaise 1-25 ya 1, 2, 3/1 likhein.' });
      }

      const ExcelJS = require('exceljs');
      const excelPath = path.join(__dirname, '..', 'form automation', 'farmers.xlsx');
      const wb = new ExcelJS.Workbook();
      let ws;

      if (append && fs.existsSync(excelPath)) {
        await wb.xlsx.readFile(excelPath);
        ws = wb.worksheets[0];
      } else {
        ws = wb.addWorksheet('Farmers');
        ws.addRow(['Name', 'Crop', 'SowingDate', 'Ownership', 'KhasraNo', 'KhataNo', 'FarmerName', 'Status', 'Error']);
        ws.getColumn(1).width = 18;
        ws.getColumn(2).width = 24;
        ws.getColumn(3).width = 14;
        ws.getColumn(4).width = 12;
        ws.getColumn(5).width = 22; // 18-digit KhasraNo
        ws.getColumn(6).width = 12; // KhataNo
        ws.getColumn(7).width = 18; // FarmerName
        ws.getColumn(8).width = 10; // Status
        ws.getColumn(9).width = 25; // Error
        ws.getColumn(5).numFmt = '@';
        ws.getColumn(6).numFmt = '@';
      }

      const generatedRows = [];
      for (const k of parsedKilas) {
        const khasra18 = makeKhasra(main, sub, k.main, k.sub);
        const rowData = [
          name.trim(),
          crop.trim(),
          sowingDate.trim(),
          ownership ? ownership.trim() : 'Owner',
          khasra18,
          String(khataNo).trim(),
          name.trim(),
          '',
          '',
        ];
        const addedRow = ws.addRow(rowData);
        addedRow.getCell(5).value = khasra18;
        addedRow.getCell(5).numFmt = '@';
        addedRow.getCell(6).value = String(khataNo).trim();
        addedRow.getCell(6).numFmt = '@';

        generatedRows.push({
          kila: k.sub ? `${k.main}/${k.sub}` : `${k.main}`,
          khasra: khasra18,
          farmer: name.trim(),
          khata: khataNo,
        });
      }

      await wb.xlsx.writeFile(excelPath);
      state.totalRows = ws.rowCount - 1;
      state.processedCount = 0;
      log(`Excel Generated: ${generatedRows.length} kilas added for ${name} (Murabba: ${main}/${sub})`);

      res.json({
        ok: true,
        count: generatedRows.length,
        rows: generatedRows,
        message: `${generatedRows.length} kilas successfully generate hokar farmers.xlsx me save ho gaye!`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Get current Excel rows for in-app table preview
  app.get('/get-excel-rows', async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const excelPath = path.join(__dirname, '..', 'form automation', 'farmers.xlsx');
      if (!fs.existsSync(excelPath)) return res.json({ ok: true, rows: [] });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(excelPath);
      const ws = wb.worksheets[0];
      const rows = [];
      ws.eachRow((r, i) => {
        if (i === 1) return;
        rows.push({
          index: i - 1,
          name: String(r.getCell(1).value || '').trim(),
          crop: String(r.getCell(2).value || '').trim(),
          date: String(r.getCell(3).value || '').trim(),
          khasra: String(r.getCell(5).value || '').trim(),
          khata: String(r.getCell(6).value || '').trim(),
          status: String(r.getCell(8).value || '').trim().toUpperCase() || 'PENDING',
          error: String(r.getCell(9).value || '').trim(),
        });
      });
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

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

  app.post('/set-operator', async (req, res) => {
    try {
      const { phone, name } = req.body;
      const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ ok: false, message: 'Please enter a valid 10-digit mobile number' });
      }

      // Hard permanent lock: If this PC is already bound to an operator, forbid changing to any other number
      if (state.user && state.user.phone && state.user.phone !== cleanPhone) {
        return res.status(403).json({
          ok: false,
          message: `This computer is permanently locked to +91 ${state.user.phone}. Operator mobile number cannot be changed from this PC. Please contact Admin for device transfer.`
        });
      }

      const cleanName = String(name || '').trim() || (state.user && state.user.name) || `Operator_${cleanPhone.slice(-4)}`;

      const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
        phone: cleanPhone,
        hwid: state.hwid,
        name: cleanName,
      }, { timeout: 8000 });

      if (loginRes.data && loginRes.data.ok) {
        state.user = loginRes.data.user;
        state.walletBalance = loginRes.data.wallet ? loginRes.data.wallet.balance : 0;
        state.subscription = loginRes.data.subscription;
        state.isOnline = true;
        try {
          fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify({
            walletBalance: state.walletBalance,
            user: state.user,
            subscription: state.subscription,
          }, null, 2));
        } catch {}
        return res.json({ ok: true, user: state.user, walletBalance: state.walletBalance, subscription: state.subscription });
      } else {
        return res.status(400).json({ ok: false, message: loginRes.data ? loginRes.data.message : 'Registration failed' });
      }
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.response && err.response.data ? err.response.data.message : err.message });
    }
  });

  app.post('/create-payment', async (req, res) => {
    try {
      const { type, amount } = req.body;

      // Always enforce the locked operator phone on this PC
      const cleanPhone = (state.user && state.user.phone) || String(req.body.phone || '').replace(/\D/g, '').slice(-10);
      const cleanName = (state.user && state.user.name) || `Operator_${cleanPhone.slice(-4)}`;

      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ ok: false, message: 'Please link your 10-digit mobile number before making a payment.' });
      }

      if (!state.user || state.user.phone !== cleanPhone) {
        const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
          phone: cleanPhone,
          hwid: state.hwid,
          name: cleanName,
        }, { timeout: 8000 });
        if (loginRes.data && loginRes.data.ok) {
          state.user = loginRes.data.user;
          state.walletBalance = loginRes.data.wallet ? loginRes.data.wallet.balance : 0;
          state.subscription = loginRes.data.subscription;
          try {
            fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify({
              walletBalance: state.walletBalance,
              user: state.user,
              subscription: state.subscription,
            }, null, 2));
          } catch {}
        } else {
          return res.status(400).json({ ok: false, message: loginRes.data ? loginRes.data.message : 'User account verification failed.' });
        }
      }

      const orderRes = await axios.post(`${CLOUD_URL}/api/pay/create-order`, {
        userId: state.user.id,
        type,
        customAmount: amount,
        returnUrl: `https://neeraj2004kumar2006-pixel.github.io/on-farm/pay.html?order_id={order_id}`,
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
      if (verifyRes.data.ok && state.user && state.user.phone) {
        const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
          phone: state.user.phone,
          hwid: state.hwid,
        });
        if (loginRes.data.ok) {
          state.walletBalance = loginRes.data.wallet.balance;
          state.subscription = loginRes.data.subscription;
          try {
            fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify({
              walletBalance: state.walletBalance,
              user: state.user,
              subscription: state.subscription,
            }, null, 2));
          } catch {}
        }
      }
      res.json(verifyRes.data);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.listen(PANEL_PORT, () => {
    log(`Service initialized on port ${PANEL_PORT}.`);
  });
}

// -------------------------------------------------------------------------
// 5. USER BALANCE & CLOUD SYNC
// -------------------------------------------------------------------------
async function syncUserBalance() {
  try {
    const phone = (state.user && state.user.phone) || process.env.OPERATOR_PHONE;
    if (!phone) {
      state.isOnline = true;
      return true;
    }
    const name = (state.user && state.user.name) || process.env.OPERATOR_NAME || `Operator_${phone.slice(-4)}`;
    const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
      phone,
      hwid: state.hwid,
      name,
    }, { timeout: 6000 });

    if (loginRes.data && loginRes.data.ok) {
      state.user = loginRes.data.user;
      state.walletBalance = loginRes.data.wallet ? loginRes.data.wallet.balance : 0;
      state.subscription = loginRes.data.subscription;
      state.isOnline = true;
      try {
        fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify({
          walletBalance: state.walletBalance,
          user: state.user,
          subscription: state.subscription,
        }, null, 2));
      } catch {}
      return true;
    }
  } catch (err) {
    // Keep last known balance if network momentarily blips
  }
  return false;
}

// -------------------------------------------------------------------------
// 6. MAIN ENTRY POINT
// -------------------------------------------------------------------------
async function main() {
  // Step 1: Start local UI server immediately so Electron loads in milliseconds
  startControlPanel();

  // Step 2: Cloud Handshake in background
  try {
    log('System initialized. Checking network connection...');
    await checkCloudConnectivity();
    await verifyVersionGate();

    const synced = await syncUserBalance();
    if (synced) {
      const planName = state.subscription ? 'Monthly Pass' : 'Pay As You Go';
      log(`Connected to cloud services. Active Plan: ${planName} | Available Balance: ₹${state.walletBalance}`);
    }
  } catch (err) {
    log(`Network check: ${err.response ? err.response.data.message : err.message}`);
  }

  // Periodic background balance sync every 10 seconds
  setInterval(syncUserBalance, 10000);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
});
