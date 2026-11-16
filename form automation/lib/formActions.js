// lib/formActions.js
//
// SELECTOR NOTES (please read)
// -----------------------------------------------------------------------
// District / Tehsil / Girdawar / PatwarHalka / Village are selected
// MANUALLY by the user and are never touched by this file.
//
// Khata No, Khasra No, Verify, Radio and Submit use the EXACT selectors
// captured by Playwright Codegen on the real site — these are not guessed:
//   input[name="Khata No"], input[name="Khasra No"],
//   getByRole('button', { name: 'Verify' }), getByRole('radio'),
//   getByRole('button', { name: 'Submit' })
//
// Crop, Ownership, and the sowing-date picker could NOT be captured
// cleanly by Codegen (they caused strict-mode violations / matched
// multiple elements), and I do not have browser or network access to your
// machine or to the live government site to inspect its DOM myself.
// Rather than guess a fixed selector (which is exactly what caused the
// earlier failures), the functions below locate the correct element AT
// RUNTIME by matching on what's actually visible on screen — the same way
// a human operator would pick the right field by reading it:
//   - Crop / Ownership: whichever <select> currently has an <option> whose
//     text exactly equals the Excel value.
//   - Sowing date: whichever calendar day button's accessible name matches
//     the target weekday/month/day.
//
// If a field still isn't found on your real form, the thrown error message
// tells you exactly what was searched for. Run `node inspect-dom.js`
// (see README.md) while the form is open to dump the live DOM and adjust
// the matching logic if needed.
// -----------------------------------------------------------------------

const { parseSowingDate, dayButtonPattern } = require('./date');
const { log } = require('./state');

// ---------- Crop ----------
async function selectCrop(page, cropValue) {
  const wanted = cropValue.trim();
  const selects = page.locator('select');
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    let optionTexts;
    try {
      optionTexts = (await sel.locator('option').allTextContents()).map(t => t.trim());
    } catch {
      continue;
    }
    if (optionTexts.includes(wanted)) {
      await sel.selectOption({ label: wanted });
      log(`Crop select: "${wanted}"`);
      return sel;
    }
  }
  throw new Error(`Crop dropdown nahi mila jisme option "${wanted}" ho. Excel ki Crop value aur website ke dropdown option ka text EXACTLY match hona chahiye (spacing/spelling bhi).`);
}

// ---------- Ownership ----------
async function selectOwnership(page, ownershipValue, cropSelect) {
  const wanted = ownershipValue.trim();
  const wantedLower = wanted.toLowerCase();

  async function isSameElement(sel) {
    if (!cropSelect) return false;
    try {
      const cropHandle = await cropSelect.elementHandle();
      return await sel.evaluate((el, cropEl) => el === cropEl, cropHandle);
    } catch {
      return false;
    }
  }

  // Strategy 1: a <select> in the same table row as the Crop dropdown
  // (matches the "td:nth-child(3) > select" shape seen in Codegen, without
  // hard-coding a column index that could shift).
  if (cropSelect) {
    const row = cropSelect.locator('xpath=ancestor::tr[1]');
    if (await row.count()) {
      const rowSelects = row.locator('select');
      const rc = await rowSelects.count();
      for (let i = 0; i < rc; i++) {
        const sel = rowSelects.nth(i);
        if (await isSameElement(sel)) continue;
        let opts;
        try {
          opts = (await sel.locator('option').allTextContents()).map(t => t.trim().toLowerCase());
        } catch {
          continue;
        }
        if (opts.includes(wantedLower)) {
          await sel.selectOption({ label: wanted });
          log(`Ownership select (same row as Crop): "${wanted}"`);
          return sel;
        }
      }
    }
  }

  // Strategy 2: fall back to any <select> on the page (excluding Crop)
  // whose options include the wanted value.
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    if (await isSameElement(sel)) continue;
    let opts;
    try {
      opts = (await sel.locator('option').allTextContents()).map(t => t.trim().toLowerCase());
    } catch {
      continue;
    }
    if (opts.includes(wantedLower)) {
      await sel.selectOption({ label: wanted });
      log(`Ownership select (page-wide match): "${wanted}"`);
      return sel;
    }
  }

  throw new Error(`Ownership dropdown nahi mila jisme option "${wanted}" ho.`);
}

// ---------- Sowing Date ----------
async function selectSowingDate(page, rawDate) {
  const target = parseSowingDate(rawDate);
  const dateBox = page.getByRole('textbox', { name: 'select date' });
  await dateBox.click();

  const dayPattern = dayButtonPattern(target);
  const backwardBtn = page.getByRole('button', { name: /backward|previous/i });
  const forwardBtn = page.getByRole('button', { name: /forward|next/i });

  const tryClickDay = async () => {
    const dayBtn = page.getByRole('button', { name: dayPattern });
    if (await dayBtn.count()) {
      await dayBtn.first().click();
      return true;
    }
    return false;
  };

  if (await tryClickDay()) {
    log(`Sowing date selected: ${rawDate}`);
    return;
  }

  const MAX_STEPS = 15;

  // The picker opens on the current real-world month by default (this
  // matches the original Codegen recording, which clicked "backward" twice
  // to go from the recording month to June). Try backward first...
  for (let i = 0; i < MAX_STEPS; i++) {
    if (!(await backwardBtn.count())) break;
    await backwardBtn.first().click();
    await page.waitForTimeout(150);
    if (await tryClickDay()) {
      log(`Sowing date selected: ${rawDate}`);
      return;
    }
  }

  // ...then reset and try forward, in case the target month was later than
  // the picker's starting month.
  await page.keyboard.press('Escape').catch(() => {});
  await dateBox.click();
  for (let i = 0; i < MAX_STEPS * 2; i++) {
    if (!(await forwardBtn.count())) break;
    await forwardBtn.first().click();
    await page.waitForTimeout(150);
    if (await tryClickDay()) {
      log(`Sowing date selected: ${rawDate}`);
      return;
    }
  }

  throw new Error(`Sowing date (${rawDate}) calendar me select nahi ho payi. README.md ke "Date picker debugging" section ke hisaab se node inspect-dom.js --calendar chalayein.`);
}

// ---------- Khata No / Khasra No / Verify / Radio / Submit (exact Codegen selectors) ----------
async function fillKhata(page, khataNo) {
  const input = page.locator('input[name="Khata No"]');
  await input.click();
  await input.fill('');
  await input.fill(String(khataNo));
  log(`Khata No filled: ${khataNo}`);
}

async function fillKhasra(page, khasraNo) {
  const input = page.locator('input[name="Khasra No"]');
  await input.click();
  await input.fill('');
  await input.fill(String(khasraNo));
  log(`Khasra No filled: ${khasraNo}`);
}

async function clickVerify(page) {
  await page.getByRole('button', { name: 'Verify' }).click();
  log('Verify clicked');
}

async function selectRadio(page, farmerName) {
  // Popup visible hone ka wait karo
  const allRadios = page.getByRole('radio');
  await allRadios.first().waitFor({ state: 'visible', timeout: 15000 });

  if (farmerName && farmerName.trim()) {
    const wanted = farmerName.trim();

    // Sirf popup/modal ke andar dhundo — baaki page (summary table) ignore karo
    // "Farmer's Land Details From Land Record" popup ke andar tr dhundo
    const popupSelectors = [
      '[class*="modal"] tr',
      '[role="dialog"] tr',
      '.modal-body tr',
      '.modal-content tr',
    ];

    for (const sel of popupSelectors) {
      const rows = page.locator(sel).filter({ hasText: wanted });
      const count = await rows.count();
      if (count > 0) {
        const radio = rows.first().locator('input[type="radio"]');
        const radioCount = await radio.count();
        if (radioCount > 0) {
          await radio.click();
          log(`Farmer selected from popup: "${wanted}"`);
          return;
        }
      }
    }

    // Koi modal selector kaam nahi kiya — directly radio elements mein se dhundo
    // Har radio ke parent row mein naam check karo
    const radios = page.locator('input[type="radio"]');
    const radioCount = await radios.count();
    for (let i = 0; i < radioCount; i++) {
      const radio = radios.nth(i);
      // Parent tr mein naam hai?
      const parentRow = radio.locator('xpath=ancestor::tr[1]');
      if (await parentRow.count()) {
        const rowText = await parentRow.first().innerText().catch(() => '');
        if (rowText.includes(wanted)) {
          await radio.click();
          log(`Farmer selected from popup (fallback): "${wanted}"`);
          return;
        }
      }
    }

    log(`WARNING: Popup mein "${wanted}" nahi mila — pehla radio select kar raha hai.`);
  }

  // Default: pehla radio
  await allRadios.first().check();
  log('Verification radio selected (first)');
}

async function clickPopupSubmit(page) {
  // Confirmation popup mein "Already Insured Area" text HAMESHA hota hai
  // Pehle yeh text aane tak wait karo — tab pata chalega popup open hua
  try {
    await page.getByText('Already Insured Area (Farmer)').waitFor({ state: 'visible', timeout: 8000 });
  } catch (e) {
    // Popup nahi aaya — aage badho
    log('INFO: Confirmation popup nahi aaya — skip');
    return;
  }

  // Popup open hai — Submit click karo
  const submitBtn = page.getByRole('button', { name: 'Submit' }).first();
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
  await submitBtn.click();
  log('Popup Submit clicked');

  // Popup band hone ka wait karo (text gayab ho jaye)
  await page.getByText('Already Insured Area (Farmer)').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function clickAddCrop(page) {
  // Popup band hone ke baad Add Crop button visible hoga
  const btn = page.getByRole('button', { name: /Add Crop or Survey Number/i });
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  log('+ Add Crop or Survey Number clicked — next row ready');
  await page.waitForTimeout(800);
}

async function clickSubmit(page) {
  await page.getByRole('button', { name: 'Submit' }).click();
  log('Submit clicked — sab rows submit ho gayi');
}

module.exports = {
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
