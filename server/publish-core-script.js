// server/publish-core-script.js
// Reads formActions logic, fixes selectors, encrypts it, and publishes to Supabase cloud!

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { encryptScript } = require('./security');

const supabase = createClient(process.env.SUPABASE_URL || 'http://localhost:54321', process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key');

// The Core Form Automation Logic that will be encrypted and sent to RAM
const coreAutomationCode = `
// On-Farm Core Cloud Automation Logic (Version 1.0.0)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseDate(raw) {
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const m = s.match(/^(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{4})$/);
  if (!m) return new Date();
  const [, dd, mm, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

async function selectCrop(page, cropValue, log) {
  const wanted = cropValue.trim();
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    let opts = [];
    try { opts = (await sel.locator('option').allTextContents()).map(t => t.trim()); } catch {}
    if (opts.includes(wanted)) {
      await sel.selectOption({ label: wanted });
      if (log) log('Crop selected: ' + wanted);
      return sel;
    }
  }
  throw new Error('Crop dropdown option nahi mila: ' + wanted);
}

async function selectOwnership(page, ownershipValue, cropSelect, log) {
  const wanted = ownershipValue.trim();
  const wantedLower = wanted.toLowerCase();
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    let opts = [];
    try { opts = (await sel.locator('option').allTextContents()).map(t => t.trim().toLowerCase()); } catch {}
    if (opts.includes(wantedLower)) {
      await sel.selectOption({ label: wanted });
      if (log) log('Ownership selected: ' + wanted);
      return sel;
    }
  }
  throw new Error('Ownership dropdown option nahi mila: ' + wanted);
}

async function selectSowingDate(page, rawDate, log) {
  const target = parseDate(rawDate);
  const dateBox = page.getByRole('textbox', { name: /select date/i }).first();
  await dateBox.click();

  const weekday = WEEKDAYS[target.getDay()];
  const month = MONTHS[target.getMonth()];
  const day = target.getDate();
  const dayPattern = new RegExp(weekday + '.*' + month + '.*\\\\b0?' + day + '\\\\b', 'i');

  const dayBtn = page.getByRole('button', { name: dayPattern });
  if (await dayBtn.count()) {
    await dayBtn.first().click();
    if (log) log('Date selected: ' + rawDate);
    return;
  }

  const backwardBtn = page.getByRole('button', { name: /backward|previous/i });
  for (let i = 0; i < 15; i++) {
    if (!(await backwardBtn.count())) break;
    await backwardBtn.first().click();
    await page.waitForTimeout(150);
    if (await dayBtn.count()) {
      await dayBtn.first().click();
      if (log) log('Date selected: ' + rawDate);
      return;
    }
  }
}

async function fillKhata(page, khataNo, log) {
  const input = page.locator('input[name="Khata No"]').first();
  await input.click();
  await input.fill(String(khataNo));
}

async function fillKhasra(page, khasraNo, log) {
  const input = page.locator('input[name="Khasra No"]').first();
  await input.click();
  await input.fill(String(khasraNo));
}

async function clickVerify(page, log) {
  await page.getByRole('button', { name: 'Verify' }).first().click();
}

async function selectRadio(page, farmerName, log) {
  const allRadios = page.getByRole('radio');
  await allRadios.first().waitFor({ state: 'visible', timeout: 15000 });

  if (farmerName && String(farmerName).trim()) {
    const rawWanted = String(farmerName).trim();
    const wantedLower = rawWanted.toLowerCase();
    const wantedTokens = wantedLower.split(/\s+/).filter(t => t.length > 2);

    const popupSelectors = [
      '[class*="modal"] tr',
      '[role="dialog"] tr',
      '.modal-body tr',
      '.modal-content tr',
      'table tbody tr',
    ];

    for (const sel of popupSelectors) {
      const rows = page.locator(sel);
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const text = (await row.innerText().catch(() => '')).toLowerCase();
        const matchesAllTokens = wantedTokens.length > 0 && wantedTokens.every(token => text.includes(token));
        if (text.includes(wantedLower) || matchesAllTokens) {
          const radio = row.locator('input[type="radio"]');
          if (await radio.count() > 0) {
            await radio.first().click();
            if (log) log(`Farmer matched & selected from popup: "${rawWanted}"`);
            return;
          }
        }
      }
    }
  }

  await allRadios.first().check();
  if (log) log('Verification radio selected (first)');
}

async function clickPopupSubmit(page, log) {
  try {
    await page.getByText('Already Insured Area (Farmer)').waitFor({ state: 'visible', timeout: 8000 });
    const submitBtn = page.getByRole('button', { name: 'Submit' }).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
    await page.getByText('Already Insured Area (Farmer)').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  } catch {
    // Popup nahi aaya — continue
  }
}

async function clickAddCrop(page, log) {
  const btn = page.getByRole('button', { name: /Add Crop or Survey Number/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await page.waitForTimeout(800);
}

async function clickSubmit(page, log) {
  // Multi-selector fallback to fix last row submit timeout
  const candidates = [
    page.getByRole('button', { name: 'Submit' }).last(),
    page.locator('button:has-text("Submit")').last(),
    page.locator('input[type="submit"]').last(),
    page.getByRole('button', { name: /Save|Final/i }).last(),
  ];

  for (const btn of candidates) {
    if (await btn.count()) {
      await btn.click();
      if (log) log('Final Submit clicked successfully!');
      return;
    }
  }
  throw new Error('Final Submit button portal par nahi mila.');
}

async function processFarmerRow(page, row, isLastRow, log) {
  const cropSel = await selectCrop(page, row.Crop, log);
  await selectSowingDate(page, row.SowingDateRaw, log);
  await selectOwnership(page, row.Ownership, cropSel, log);
  await fillKhata(page, row.KhataNo, log);
  await fillKhasra(page, row.KhasraNo, log);
  await clickVerify(page, log);
  await page.waitForTimeout(1500);
  await selectRadio(page, row.FarmerName, log);
  await clickPopupSubmit(page, log);

  if (isLastRow) {
    await clickSubmit(page, log);
  } else {
    await clickAddCrop(page, log);
  }
}

module.exports = {
  processFarmerRow,
  selectCrop,
  selectOwnership,
  selectSowingDate,
  fillKhata,
  fillKhasra,
  clickVerify,
  selectRadio,
  clickPopupSubmit,
  clickAddCrop,
  clickSubmit,
};
`;

async function publish() {
  console.log('Encrypting core automation code with AES-256...');
  const { encrypted_code, iv } = encryptScript(coreAutomationCode);

  try {
    const { error } = await supabase.from('remote_scripts').upsert({
      version: '1.0.0',
      encrypted_code,
      iv,
      description: 'Initial production-ready cloud automation payload',
      created_at: new Date().toISOString(),
    }, { onConflict: 'version' });

    if (error) throw error;
    console.log('✅ Core script successfully published to Supabase remote_scripts!');
  } catch (err) {
    console.log('Note: Once you paste SUPABASE_URL in server/.env, run this file to publish to cloud.');
    console.log('Local encrypted preview ready.');
  }
}

publish();
