# Farmer Form Automation

Playwright automation for filling the farmer crop-insurance form from `farmers.xlsx`,
with a local START/STOP control panel — built around the exact workflow and
Codegen selectors you provided.

## ⚠️ Please read before running

I do not have browser or network access to your Windows machine, your
Playwright browser session, or the live government website — so I could not
personally re-open your form and inspect its DOM the way you asked.

Here's how each field was handled instead:

| Field | Selector source |
|---|---|
| District / Tehsil / Girdawar / PatwarHalka / Village | **Not touched** — you select these manually, as planned |
| Khata No, Khasra No, Verify, Radio, Submit | **Exact** selectors from your Codegen recording (`input[name="Khata No"]`, etc.) |
| Crop, Ownership | Found **at runtime** by matching the visible `<option>` text against your Excel value (avoids the strict-mode "matched 2/8 elements" errors you hit before, since it no longer depends on a fixed index) |
| Sowing Date | Found **at runtime** by matching the day button's accessible name (weekday + month + day), navigating the calendar with the "previous/next month" buttons |

This is the honest alternative to guessing a hard-coded selector. If a field
still isn't found on your real form, you'll get a clear error message telling
you exactly what was searched for — and `inspect-dom.js` (below) lets you dump
the live DOM yourself, without needing to re-run Codegen.

**Please test with exactly ONE Excel row first** (as you asked in point 10),
before turning it loose on the full list.

## 1. Setup (one-time)

```powershell
cd "D:\Downloads\form automation"
npm install
```

This installs Playwright, Express, and ExcelJS, and downloads the Chromium
browser Playwright uses.

Your existing `farmers.xlsx` (with the `Name / Crop / SowingDate / Ownership /
KhataNo / KhasraNo / Status / Error` columns, `KhataNo` formatted as **Text**)
goes in this same project folder. If you want a fresh correctly-formatted
template to compare against, run:

```powershell
node generate-sample.js
```

## 2. Running

```powershell
node automation.js
```

This:
1. Opens a Chromium browser with a persistent profile (`browser-profile/`
   folder — your login stays saved for next time).
2. Starts the control panel at **http://localhost:3789**.

In the opened browser:
1. Log in / handle OTP / CAPTCHA manually.
2. Open the actual farmer form.
3. Manually select **District, Tehsil, Girdawar Circle, Patwar Halka,
   Village**.
4. Go to the control panel and press **START**.

The automation then takes over from **Crop** onward, for the first row not
already marked `DONE`:

```
Crop → Sowing Date → Ownership → Khata No → Khasra No → Verify → Radio → Submit
```

It does **not** touch Insured Area (left for the website to auto-calculate),
and does **not** click "+ Add Crop or Survey Number".

## 3. START / STOP / Errors

- **START** — begins from the first row where `Status` is not `DONE`.
- **STOP** — pauses at the next safe checkpoint (between steps, or between
  rows). If you stop mid-row, that row is **not** marked `DONE` — check the
  form on screen before pressing START again, since restarting will redo that
  row from Crop onward.
- **On error** — the row's `Status` is set to `ERROR` and the exact error
  message is written to the `Error` column. Automation **stops** rather than
  skipping to the next farmer, exactly as you specified.
- The panel shows the current row, processed count, and a live log.

## 4. If Crop / Ownership / Sowing Date don't match on your real form

Run this **while `automation.js` is running and the form is open**:

```powershell
node inspect-dom.js
```

This connects to your already-open, already-logged-in browser (over
`localhost:9222`) and prints every `<select>` on the page — its `name`, `id`,
`data-*` attributes, and visible options — so you can see exactly why a
match did or didn't happen, without touching your session.

For the date picker specifically:
1. Click the "select date" field in the browser so the calendar is open.
2. Then run:
   ```powershell
   node inspect-dom.js --calendar
   ```
   This dumps the open calendar popup's HTML so the day/month button
   matching in `lib/formActions.js` (`selectSowingDate`) can be tightened —
   e.g. if your site's "previous/next month" buttons don't contain the words
   "backward/previous/forward/next" in their accessible name, or the day
   buttons don't read like `"Monday, June 15,"`.

## 5. Project structure

```
form automation/
  automation.js          entry point — launches browser + control panel + loop
  inspect-dom.js          DOM debugging helper (see section 4)
  generate-sample.js      optional: creates a correctly-formatted template xlsx
  farmers.xlsx             your data (not included — use your existing file)
  lib/
    excel.js               reads/writes farmers.xlsx, keeps KhataNo as text
    formActions.js          all Playwright page actions (see selector notes at the top of the file)
    date.js                 SowingDate parsing + day-button matching
    controlPanel.js         Express server for the START/STOP panel
    state.js                shared in-memory status + logging
  public/
    panel.html              control panel UI
```

## 6. Known limitation to watch for

The sowing-date navigation assumes the calendar opens on the **current
real-world month** and searches backward, then forward, up to ~15 months
each way. This matches what your Codegen recording showed (2 backward clicks
from the recording date to reach June). If your site instead remembers the
last-shown month between farmers, or uses a completely different calendar
widget, use `node inspect-dom.js --calendar` to check and let me know what
it shows — the matching logic in `lib/formActions.js` can be adjusted from
there.
