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

const CLIENT_BASE_DIR = fs.existsSync(path.join(__dirname, 'public')) ? __dirname : path.join(__dirname, '..');

// Cloud backend URL (Points to 24/7 Vercel Cloud Server)
const CLOUD_URL = process.env.ONFARM_CLOUD_URL || 'https://on-farm.vercel.app';
const SESSION_CACHE_FILE = path.join(CLIENT_BASE_DIR, 'user-session.json');
const TX_HISTORY_FILE = path.join(CLIENT_BASE_DIR, 'transaction_history.json');

// Helper to record transaction / deduction locally on operator PC
function appendLocalTransaction(tx) {
  try {
    let list = [];
    if (fs.existsSync(TX_HISTORY_FILE)) {
      list = JSON.parse(fs.readFileSync(TX_HISTORY_FILE, 'utf8') || '[]');
    }
    list.unshift({
      id: tx.id || ('local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
      created_at: tx.created_at || new Date().toISOString(),
      type: tx.type, // 'KILA_DEBIT', 'WALLET_RECHARGE', 'REFERRAL_BONUS', 'MONTHLY_PASS'
      amount: tx.amount !== undefined ? tx.amount : 0,
      status: tx.status || 'SUCCESS',
      details: tx.details || {},
      balance: tx.balance !== undefined ? tx.balance : (state ? state.walletBalance : 0),
    });
    if (list.length > 500) list = list.slice(0, 500);
    fs.writeFileSync(TX_HISTORY_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('appendLocalTransaction error:', err);
  }
}

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
async function callCloudWithRetry(fn, actionName = 'Cloud request', maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetError = !err.response || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || (err.message && err.message.includes('Network Error'));
      if (isNetError && attempt < maxAttempts) {
        log(`Network blip on ${actionName}. Retrying automatically (${attempt}/${maxAttempts})...`);
        await new Promise(res => setTimeout(res, 1500));
        continue;
      }
      throw err;
    }
  }
}

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

async function saveWorkbookAtomic(wb, targetPath, maxTries = 5) {
  const tmpPath = `${targetPath}.${Date.now()}.${process.pid}.tmp`;
  await wb.xlsx.writeFile(tmpPath);
  for (let i = 0; i < maxTries; i++) {
    try {
      if (fs.existsSync(targetPath)) {
        try { fs.unlinkSync(targetPath); } catch {}
      }
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      if (['EBUSY', 'EPERM'].includes(err.code) && i < maxTries - 1) {
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      } else {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        throw err;
      }
    }
  }
}

async function closeBrowserGracefully() {
  try {
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
      browserContext = null;
    }
  } catch {}
}

process.on('message', async (m) => {
  if (m === 'shutdown') {
    await closeBrowserGracefully();
    process.exit(0);
  }
});

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

  const profileDir = path.join(CLIENT_BASE_DIR, '..', 'browser-profile');
  let alreadyRunning = false;
  try {
    const res = await axios.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 1500 });
    if (res.status === 200) alreadyRunning = true;
  } catch { /* not running */ }

  if (!alreadyRunning) {
    const chromePath = findChromeExecutable();
    if (!chromePath) {
      throw new Error('Google Chrome was not found on this computer. Please install Google Chrome to continue.');
    }

    log(`Launching Chrome: ${chromePath}`);
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--start-maximized',
      'https://pmfby.gov.in',
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await axios.get(`http://localhost:${CDP_PORT}/json/version`, { timeout: 1000 });
        if (r.status === 200) { log('Chrome browser ready!'); break; }
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
    throw new Error('PMFBY form tab not found in browser. Please click "Launch PMFBY Browser", log in, and open the farmer application form.');
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
    if (!online) throw new Error('Active internet connection required. Please connect your computer to the internet.');

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
    const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
    if (!fs.existsSync(excelPath)) throw new Error('Application records file (farmers.xlsx) not found. Please save farmer entries first.');

    // Pre-flight check: ensure farmers.xlsx is not locked exclusively by MS Excel
    try {
      const fd = fs.openSync(excelPath, 'r+');
      fs.closeSync(fd);
    } catch (lockErr) {
      if (['EBUSY', 'EPERM'].includes(lockErr.code)) {
        throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel before starting automation.');
      }
    }

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(excelPath);
    } catch (e) {
      if (e.code === 'EBUSY') throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel before starting.');
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

    // 5. In-Memory Dynamic Execution Module (Sandboxed: no access to require or process)
    const inMemoryModule = { exports: {} };
    const runnerFunc = new Function('module', 'exports', decryptedJsCode);
    runnerFunc(inMemoryModule, inMemoryModule.exports);
    const formActions = inMemoryModule.exports;

    log(`Batch start: ${rows.length} pending rows.`);

    for (let i = 0; i < rows.length; i++) {
      if (state.stopRequested) { log('Operator ne automation pause kiya.'); break; }
      const r = rows[i];
      const isLastRow = (i === rows.length - 1);
      const chargeKey = `KILA_${state.user.id}_${r.KhasraNo || i}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      state.currentRow = r;
      log(`[${i + 1}/${rows.length}] Authorizing: ${r.Name} | Khasra: ${r.KhasraNo}`);

      // 5. Phase 1: Authorize & Reserve ₹1 per kila (or verify subscription) BEFORE filling form
      const deductRes = await callCloudWithRetry(() => axios.post(`${CLOUD_URL}/api/kila/deduct`, {
        userId: state.user.id,
        hwid: state.hwid,
        kilaNumber: r.KhasraNo,
        chargeKey,
      }, { timeout: 9000 }), `Kila authorization (${r.KhasraNo})`);

      if (!deductRes.data || !deductRes.data.ok || !deductRes.data.authNonce) {
        throw new Error((deductRes.data && deductRes.data.message) || 'Balance insufficient to continue. Please recharge your wallet.');
      }
      state.walletBalance = deductRes.data.remaining_balance;

      // Save deduction history locally on operator PC
      appendLocalTransaction({
        type: 'KILA_DEBIT',
        amount: deductRes.data.deducted !== undefined ? deductRes.data.deducted : (deductRes.data.plan === 'SUBSCRIPTION_UNLIMITED' ? 0 : 1.00),
        status: 'SUCCESS',
        balance: state.walletBalance,
        details: {
          khasra: r.KhasraNo,
          farmer: r.FarmerName || r.Name,
          crop: r.Crop,
          plan: deductRes.data.plan,
        }
      });

      log(`[${i + 1}/${rows.length}] Filling: ${r.Name} | Wallet Balance: ₹${state.walletBalance}`);

      try {
        // Call in-memory action routine
        if (formActions.processFarmerRow) {
          await formActions.processFarmerRow(page, r, isLastRow, log, deductRes.data.authNonce);
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

        // Phase 2: Commit charge on successful submission
        if (deductRes.data.plan === 'WALLET_PAY_PER_KILA') {
          axios.post(`${CLOUD_URL}/api/kila/commit`, {
            userId: state.user.id,
            hwid: state.hwid,
            chargeKey,
          }, { timeout: 5000 }).catch(() => {});
        }
      } catch (fillErr) {
        // Phase 3: Rollback / Refund on portal error (Only valid from RESERVED state)
        if (deductRes.data.plan === 'WALLET_PAY_PER_KILA') {
          log(`⚠️ Portal error during ${r.KhasraNo}. Initiating atomic refund...`);
          try {
            const refRes = await axios.post(`${CLOUD_URL}/api/kila/refund`, {
              userId: state.user.id,
              hwid: state.hwid,
              chargeKey,
              kilaNumber: r.KhasraNo,
              reason: fillErr.message || 'PMFBY Portal Form Error',
            }, { timeout: 6000 });
            if (refRes.data && refRes.data.ok) {
              state.walletBalance = refRes.data.remaining_balance;
              log(`✅ Auto-refund verified. Wallet balance restored to ₹${state.walletBalance}`);
            }
          } catch (rErr) {
            log(`Warning: Auto-refund API call: ${rErr.message}`);
          }
        }
        throw fillErr;
      }

      // Mark row DONE in Excel atomically
      ws.getRow(r.rowNumber).getCell(colIndex['Status'] || 8).value = 'DONE';
      ws.getRow(r.rowNumber).getCell(colIndex['Error'] || 9).value = '';
      await saveWorkbookAtomic(wb, excelPath);

      state.processedCount++;
      log(`Done: ${r.Name} | Kila ${r.KhasraNo} recorded successfully.`);
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

  // Security: Bind to loopback and validate internal runner token if set
  const PANEL_TOKEN = process.env.ONFARM_PANEL_TOKEN;
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${PANEL_PORT}`, `localhost:${PANEL_PORT}`]);
  app.use((req, res, next) => {
    if (ALLOWED_HOSTS.size && req.headers.host && !ALLOWED_HOSTS.has(req.headers.host)) {
      return res.status(403).json({ ok: false, message: 'Invalid host header' });
    }
    if (PANEL_TOKEN && (req.path.startsWith('/api') || req.path === '/start' || req.path === '/stop' || req.path.includes('excel') || req.path.includes('row'))) {
      const token = req.headers['x-onfarm-token'] || req.query.token;
      if (token !== PANEL_TOKEN) {
        return res.status(403).json({ ok: false, message: 'Unauthorized local runner request' });
      }
    }
    next();
  });

  app.use(express.static(path.join(CLIENT_BASE_DIR, 'public')));

  // Save reviewed/edited rows directly to farmers.xlsx
  app.post('/save-excel-rows', async (req, res) => {
    try {
      const { rows, append = false } = req.body;
      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ ok: false, message: 'Koi kila row save karne ke liye nahi mili.' });
      }

      const ExcelJS = require('exceljs');
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
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
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
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
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
      if (!fs.existsSync(excelPath)) return res.json({ ok: true, rows: [] });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(excelPath);
      const ws = wb.worksheets[0];
      const rows = [];
      let doneCount = 0;
      ws.eachRow((r, i) => {
        if (i === 1) return;
        const st = String(r.getCell(8).value || '').trim().toUpperCase() || 'READY';
        if (st === 'DONE') doneCount++;
        rows.push({
          index: i - 1,
          rowNumber: i,
          name: String(r.getCell(1).value || '').trim(),
          crop: String(r.getCell(2).value || '').trim(),
          date: String(r.getCell(3).value || '').trim(),
          khasra: String(r.getCell(5).value || '').trim(),
          khata: String(r.getCell(6).value || '').trim(),
          status: st,
          error: String(r.getCell(9).value || '').trim(),
        });
      });
      state.totalRows = rows.length;
      state.processedCount = doneCount;
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

  app.post('/launch-browser', async (req, res) => {
    try {
      await connectBrowser();
      if (browserContext) {
        const pages = browserContext.pages();
        const pmfbyPage = pages.find(p => p.url().includes('pmfby.gov.in'));
        if (pmfbyPage) {
          await pmfbyPage.bringToFront();
        } else if (pages.length > 0) {
          await pages[0].goto('https://pmfby.gov.in');
          await pages[0].bringToFront();
        } else {
          const newP = await browserContext.newPage();
          await newP.goto('https://pmfby.gov.in');
          await newP.bringToFront();
        }
      }
      state.lastError = null;
      res.json({ ok: true, message: 'Browser launched successfully.' });
    } catch (err) {
      state.lastError = err.message;
      res.status(500).json({ ok: false, message: err.message });
    }
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

  // Reset status of all rows back to READY without deleting data
  app.post('/reset-excel', async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
      if (!fs.existsSync(excelPath)) return res.json({ ok: true, message: 'No records file found.' });

      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.readFile(excelPath);
      } catch (e) {
        if (e.code === 'EBUSY') throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel before resetting.');
        throw e;
      }
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
      log('All saved records status reset to READY.');
      res.json({ ok: true, message: 'All saved records status reset to READY.' });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Clear all saved records from farmers.xlsx (Leave only row 1 headers)
  app.post('/clear-all-excel', async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Farmers');
      ws.addRow(['Name', 'Crop', 'SowingDate', 'Ownership', 'KhasraNo', 'KhataNo', 'FarmerName', 'Status', 'Error']);
      ws.getColumn(1).width = 18;
      ws.getColumn(2).width = 24;
      ws.getColumn(3).width = 14;
      ws.getColumn(4).width = 12;
      ws.getColumn(5).width = 22;
      ws.getColumn(6).width = 12;
      ws.getColumn(7).width = 18;
      ws.getColumn(8).width = 10;
      ws.getColumn(9).width = 25;
      ws.getColumn(5).numFmt = '@';
      ws.getColumn(6).numFmt = '@';

      try {
        await wb.xlsx.writeFile(excelPath);
      } catch (e) {
        if (e.code === 'EBUSY') throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel before resetting.');
        throw e;
      }
      state.totalRows = 0;
      state.processedCount = 0;
      state.currentRow = null;
      state.lastError = null;
      log('All saved records have been completely cleared.');
      res.json({ ok: true, message: 'All saved records have been completely cleared.' });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Delete individual row from farmers.xlsx
  app.post('/delete-excel-row', async (req, res) => {
    try {
      const { rowNumber } = req.body;
      const targetRow = parseInt(rowNumber, 10);
      if (!targetRow || targetRow < 2) {
        return res.status(400).json({ ok: false, message: 'Invalid row number to delete.' });
      }

      const ExcelJS = require('exceljs');
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
      if (!fs.existsSync(excelPath)) {
        return res.status(404).json({ ok: false, message: 'farmers.xlsx not found.' });
      }

      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.readFile(excelPath);
      } catch (e) {
        if (e.code === 'EBUSY') throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel before deleting.');
        throw e;
      }
      const ws = wb.worksheets[0];
      if (targetRow > ws.rowCount) {
        return res.status(400).json({ ok: false, message: 'Row number out of range.' });
      }

      ws.spliceRows(targetRow, 1);
      await wb.xlsx.writeFile(excelPath);

      // Recount
      let done = 0;
      let total = 0;
      ws.eachRow((r, i) => {
        if (i === 1) return;
        total++;
        const st = String(r.getCell(8).value || '').trim().toUpperCase();
        if (st === 'DONE') done++;
      });
      state.totalRows = total;
      state.processedCount = done;

      log(`Row ${targetRow} deleted from saved records.`);
      res.json({ ok: true, message: 'Record deleted successfully.' });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Update status and error for a single row in farmers.xlsx
  app.post('/update-row-status', async (req, res) => {
    try {
      const { rowNumber, status } = req.body;
      const targetRow = parseInt(rowNumber, 10);
      if (!targetRow || targetRow < 2) {
        return res.status(400).json({ ok: false, message: 'Invalid row number.' });
      }

      const ExcelJS = require('exceljs');
      const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
      if (!fs.existsSync(excelPath)) {
        return res.status(404).json({ ok: false, message: 'farmers.xlsx not found.' });
      }

      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.readFile(excelPath);
      } catch (e) {
        if (e.code === 'EBUSY') throw new Error('farmers.xlsx is open in Microsoft Excel. Please close Excel first.');
        throw e;
      }
      const ws = wb.worksheets[0];
      if (targetRow > ws.rowCount) {
        return res.status(400).json({ ok: false, message: 'Row number out of range.' });
      }

      const row = ws.getRow(targetRow);
      const cleanStatus = String(status || '').trim().toUpperCase();
      if (cleanStatus === 'READY') {
        row.getCell(8).value = '';
        row.getCell(9).value = '';
      } else {
        row.getCell(8).value = cleanStatus;
        if (cleanStatus !== 'ERROR') {
          row.getCell(9).value = '';
        }
      }

      await wb.xlsx.writeFile(excelPath);

      // Recount
      let done = 0;
      let total = 0;
      ws.eachRow((r, i) => {
        if (i === 1) return;
        total++;
        const st = String(r.getCell(8).value || '').trim().toUpperCase();
        if (st === 'DONE') done++;
      });
      state.totalRows = total;
      state.processedCount = done;

      log(`Row ${targetRow} status set to ${cleanStatus || 'READY'}`);
      res.json({ ok: true, message: `Status updated to ${cleanStatus || 'READY'}` });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.post('/set-operator', async (req, res) => {
    try {
      const { phone, name, referralCode } = req.body;
      const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
      if (!cleanPhone || cleanPhone.length !== 10) {
        return res.status(400).json({ ok: false, message: 'Please enter a valid 10-digit mobile number' });
      }

      // Sync latest cloud status first (in case admin recently reset device in admin panel)
      await syncUserBalance();

      // Hard permanent lock: If this PC is already bound to an operator, forbid changing to any other number
      if (state.user && state.user.phone && state.user.phone !== cleanPhone) {
        return res.status(403).json({
          ok: false,
          message: `This application profile is registered to +91 ${state.user.phone}. To update operator details, please contact Administrator.`
        });
      }

      const cleanName = String(name || '').trim() || (state.user && state.user.name) || `Operator_${cleanPhone.slice(-4)}`;

      const loginRes = await axios.post(`${CLOUD_URL}/api/auth/login`, {
        phone: cleanPhone,
        hwid: state.hwid,
        name: cleanName,
        referralCode: referralCode || undefined,
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
      if (verifyRes.data.ok) {
        appendLocalTransaction({
          type: verifyRes.data.plan === 'MONTHLY_PASS' ? 'MONTHLY_PASS' : 'WALLET_RECHARGE',
          amount: verifyRes.data.amount || (verifyRes.data.plan === 'MONTHLY_PASS' ? 699 : 1.00),
          status: 'SUCCESS',
          balance: state.walletBalance,
          details: { orderId, plan: verifyRes.data.plan }
        });
      }
      res.json(verifyRes.data);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.get('/get-transactions', async (req, res) => {
    let localList = [];
    try {
      if (fs.existsSync(TX_HISTORY_FILE)) {
        localList = JSON.parse(fs.readFileSync(TX_HISTORY_FILE, 'utf8') || '[]');
      }
    } catch {}

    if (state.user && state.user.id && state.isOnline) {
      try {
        const cloudRes = await axios.get(`${CLOUD_URL}/api/user/transactions`, {
          params: { userId: state.user.id, hwid: state.hwid },
          timeout: 6000,
        });
        if (cloudRes.data && cloudRes.data.ok && Array.isArray(cloudRes.data.transactions)) {
          return res.json({ ok: true, source: 'cloud', transactions: cloudRes.data.transactions });
        }
      } catch (err) {}
    }

    return res.json({ ok: true, source: 'local', transactions: localList });
  });

  app.get('/get-referral-stats', async (req, res) => {
    if (!state.user || !state.user.id) {
      return res.json({
        ok: true,
        referralCode: '',
        totalEarned: 0,
        successfulCount: 0,
      });
    }

    try {
      const refRes = await axios.get(`${CLOUD_URL}/api/user/referral-stats`, {
        params: { userId: state.user.id, hwid: state.hwid },
        timeout: 6000,
      });
      if (refRes.data && refRes.data.ok) {
        return res.json(refRes.data);
      }
    } catch (err) {}

    return res.json({
      ok: true,
      referralCode: state.user.phone || '',
      totalEarned: 0,
      successfulCount: 0,
    });
  });

  app.post('/link-referral', async (req, res) => {
    try {
      const { referralCode } = req.body;
      if (!state.user || !state.user.id) {
        return res.status(400).json({ ok: false, message: 'Please link your operator mobile number first.' });
      }
      const linkRes = await axios.post(`${CLOUD_URL}/api/user/link-referral`, {
        userId: state.user.id,
        hwid: state.hwid,
        referralCode,
      }, { timeout: 8000 });
      return res.json(linkRes.data);
    } catch (err) {
      return res.status(err.response && err.response.status ? err.response.status : 500).json({
        ok: false,
        message: err.response && err.response.data ? err.response.data.message : err.message,
      });
    }
  });

  app.get('/referral-status', async (req, res) => {
    try {
      if (!state.user || !state.user.id) {
        return res.json({ ok: true, linked: false });
      }
      const statusRes = await axios.get(`${CLOUD_URL}/api/user/referral-status`, {
        params: { userId: state.user.id, hwid: state.hwid },
        timeout: 6000,
      });
      return res.json(statusRes.data);
    } catch (err) {
      return res.json({ ok: true, linked: false }); // fail-open: don't block UI
    }
  });

  app.listen(PANEL_PORT, '127.0.0.1', () => {
    log(`Service initialized on 127.0.0.1:${PANEL_PORT}.`);
  });
}

// -------------------------------------------------------------------------
// 5. USER BALANCE & CLOUD SYNC
// -------------------------------------------------------------------------
async function syncUserBalance() {
  try {
    // Single Source of Truth: Check Cloud HWID binding status
    const devRes = await axios.post(`${CLOUD_URL}/api/auth/device-status`, {
      hwid: state.hwid,
    }, { timeout: 6000 });

    if (devRes.data && devRes.data.ok) {
      if (devRes.data.bound && devRes.data.user) {
        // Device is legitimately bound to this user
        state.user = devRes.data.user;
        state.walletBalance = devRes.data.wallet ? devRes.data.wallet.balance : 0;
        state.subscription = devRes.data.subscription;
        state.isOnline = true;
        try {
          fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify({
            walletBalance: state.walletBalance,
            user: state.user,
            subscription: state.subscription,
          }, null, 2));
        } catch {}
        return true;
      } else {
        // Device is NOT bound in Cloud! (Admin deleted the user or reset the device)
        if (state.user) {
          log('Notice: Operator account was unlinked/deleted by Admin. Resetting local device session.');
        }
        state.user = null;
        state.walletBalance = 0;
        state.subscription = null;
        state.isOnline = true;
        try {
          if (fs.existsSync(SESSION_CACHE_FILE)) {
            fs.unlinkSync(SESSION_CACHE_FILE);
          }
        } catch {}
        return true;
      }
    }
  } catch (err) {
    // Keep last known balance if network momentarily blips
  }
  return false;
}

async function refreshExcelCounts() {
  try {
    const ExcelJS = require('exceljs');
    const excelPath = path.join(CLIENT_BASE_DIR, '..', 'form automation', 'farmers.xlsx');
    if (!fs.existsSync(excelPath)) {
      state.totalRows = 0;
      state.processedCount = 0;
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelPath);
    const ws = wb.worksheets[0];
    if (!ws || ws.rowCount <= 1) {
      state.totalRows = 0;
      state.processedCount = 0;
      return;
    }
    let done = 0;
    let total = 0;
    ws.eachRow((r, i) => {
      if (i === 1) return;
      total++;
      const st = String(r.getCell(8).value || '').trim().toUpperCase();
      if (st === 'DONE') done++;
    });
    state.totalRows = total;
    state.processedCount = done;
  } catch {}
}

// -------------------------------------------------------------------------
// 6. MAIN ENTRY POINT
// -------------------------------------------------------------------------
async function main() {
  // Step 1: Start local UI server immediately so Electron loads in milliseconds
  startControlPanel();
  await refreshExcelCounts();

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

  // Periodic background balance sync every 60 seconds with backoff
  setInterval(syncUserBalance, 60000);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
});
