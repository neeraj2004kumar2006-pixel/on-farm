// automation.js — entry point.
//
// Workflow:
//   1. start.bat chalao — Chrome debugging mode mein khuljayega.
//   2. Chrome mein: login karein, farmer form kholein,
//      District/Tehsil/Girdawar/PatwarHalka/Village manually select karein.
//   3. Control panel (http://localhost:3789) pe START dabayein.

const path = require('path');
const { chromium } = require('playwright');
const { FarmerSheet } = require('./lib/excel');
const formActions = require('./lib/formActions');
const { state, log, StopRequested } = require('./lib/state');
const { startControlPanel } = require('./lib/controlPanel');

const PROJECT_DIR = __dirname;
const EXCEL_PATH = path.join(PROJECT_DIR, 'farmers.xlsx');
const CDP_PORT = 9222;
const PANEL_PORT = 3789;

// Browser aur context globally stored — page har baar fresh lete hain
let browserInstance = null;
let browserContext = null;

async function connectBrowser() {
  // Agar pehle se connected hai toh reuse karo
  if (browserInstance) {
    try {
      await browserContext.pages();
      return;
    } catch {
      browserInstance = null;
      browserContext = null;
    }
  }

  const profileDir = path.join(PROJECT_DIR, 'browser-profile');

  // Pehle check karo: kya Chrome pehle se chal raha hai port 9222 pe?
  let alreadyRunning = false;
  try {
    const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
    if (res.ok) alreadyRunning = true;
  } catch { /* nahi chal raha */ }

  if (!alreadyRunning) {
    // Chrome pehli baar launch karo — DETACHED taaki terminal band hone pe bhi khula rahe
    log('Chrome pehli baar khul raha hai...');
    const { spawn } = require('child_process');
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const child = spawn(chromePath, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--start-maximized',
    ], { detached: true, stdio: 'ignore' });
    child.unref(); // Node se disconnect — Chrome terminal band hone pe bhi khula rahega

    // Chrome ke ready hone ka wait karo
    log('Chrome start ho raha hai, please wait...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const r = await fetch(`http://localhost:${CDP_PORT}/json/version`);
        if (r.ok) { log('Chrome ready hai!'); break; }
      } catch { /* wait */ }
    }
  } else {
    log('Chrome pehle se chal raha hai — connect ho raha hai...');
  }

  // CDP se connect karo
  try {
    browserInstance = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    browserContext = browserInstance.contexts()[0] || await browserInstance.newContext();
    log('Chrome se connect ho gaya!');
  } catch (err) {
    throw new Error(`Chrome se connect nahi ho paya: ${err.message}`);
  }
}


// Har baar current active page laata hai — stale reference problem fix
async function getActivePage() {
  await connectBrowser();

  const allPages = browserContext.pages();

  // localhost aur chrome:// pages skip karo — sirf government form wala tab chahiye
  const formPages = allPages.filter(p => {
    const url = p.url();
    return !url.startsWith('about:')
      && !url.startsWith('chrome:')
      && !url.startsWith('http://localhost')
      && !url.startsWith('https://localhost');
  });

  if (!formPages.length) {
    throw new Error(
      'Government form wala tab nahi mila. Chrome mein form open karein ' +
      '(localhost:3789 wala tab form nahi hai — alag tab mein government site kholein).'
    );
  }

  // Sabse baad wali non-localhost page use karo
  const activePage = formPages[formPages.length - 1];
  log(`Active tab: ${activePage.url().slice(0, 80)}`);
  await activePage.bringToFront();
  return activePage;
}

function checkStop() {
  if (state.stopRequested) throw new StopRequested('Stopped by user');
}

async function processRow(sheet, row, page, isLastRow) {
  try {
    checkStop();
    log(`Row shuru: ${row.Name} | KhataNo: ${row.KhataNo}`);
    const cropSelect = await formActions.selectCrop(page, row.Crop);

    checkStop();
    await formActions.selectSowingDate(page, row.SowingDateRaw);

    checkStop();
    await formActions.selectOwnership(page, row.Ownership, cropSelect);

    checkStop();
    await formActions.fillKhata(page, row.KhasraNo);  // Plot No. field (site mein name="Khata No")
    await formActions.fillKhasra(page, row.KhataNo);  // Khata No. field (site mein name="Khasra No")

    checkStop();
    await formActions.clickVerify(page);
    await page.waitForTimeout(1500);

    checkStop();
    await formActions.selectRadio(page, row.FarmerName);

    checkStop();
    // Radio ke baad confirmation popup aata hai — Submit dabao
    await formActions.clickPopupSubmit(page);

    checkStop();
    if (isLastRow) {
      // Sabse aakhri row ke baad Submit karo
      await formActions.clickSubmit(page);
      await page.waitForTimeout(1500);
    } else {
      // Baaki rows ke baad ’+ Add Crop or Survey Number’ click karo
      await formActions.clickAddCrop(page);
    }

    await sheet.markDone(row.rowNumber);
    log(`Row DONE: ${row.Name} (KhataNo: ${row.KhataNo})`);
  } catch (err) {
    if (err instanceof StopRequested) throw err;
    await sheet.markError(row.rowNumber, err.message);
    throw err;
  }
}

async function runLoop() {
  if (state.isRunning) return;
  state.isRunning = true;
  state.stopRequested = false;
  state.lastError = null;

  try {
    await connectBrowser();

    const sheet = new FarmerSheet(EXCEL_PATH);
    await sheet.load();
    const allRows = sheet.getRows();

    // Sirf pending rows (DONE nahi hain)
    const pendingRows = allRows.filter(r => r.Status !== 'DONE');
    state.totalRows = allRows.length;
    state.processedCount = allRows.length - pendingRows.length; // pehle se DONE

    if (!pendingRows.length) {
      log('Sab rows pehle se DONE hain!');
      return;
    }

    // Har baar fresh page lo
    const page = await getActivePage();

    for (let i = 0; i < pendingRows.length; i++) {
      const row = pendingRows[i];
      const isLastRow = (i === pendingRows.length - 1);

      if (state.stopRequested) {
        log('Stopped by user before the next row.');
        break;
      }

      state.currentRow = { index: row.rowNumber, name: row.Name };
      log(`[${i + 1}/${pendingRows.length}] ${row.Name} — KhataNo: ${row.KhataNo}${isLastRow ? ' (LAST — Submit karega)' : ' (+ Add karega)'}`);

      try {
        await processRow(sheet, row, page, isLastRow);
        state.processedCount++;
      } catch (err) {
        if (err instanceof StopRequested) {
          log('Stopped by user mid-row.');
          break;
        }
        state.lastError = `${row.Name}: ${err.message}`;
        log(`ERROR on row "${row.Name}": ${err.message}`);
        log('Automation ruk gaya (agla farmer automatically skip nahi hoga).');
        break;
      }
    }
  } catch (err) {
    state.lastError = err.message;
    log(`Fatal error: ${err.message}`);
  } finally {
    state.isRunning = false;
    state.currentRow = null;
  }
}

async function main() {
  // Startup pe connect try karo (agar Chrome pehle se khula ho)
  try {
    await connectBrowser();
    log('Chrome se connect ho gaya! Ab Chrome mein: Login > Form > District/Tehsil/Girdawar/PatwarHalka/Village select karein, phir START dabayein.');
  } catch {
    log('Chrome abhi nahi mila — start.bat chalayein. Phir START dabayein toh connect ho jayega.');
  }

  startControlPanel({
    port: PANEL_PORT,
    onStart: () => { runLoop(); },
    onStop: () => {
      state.stopRequested = true;
      log('STOP requested — agle safe checkpoint par ruk jaayega.');
    },
  });
  log(`Control panel: http://localhost:${PANEL_PORT}`);
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
