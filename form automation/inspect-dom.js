// inspect-dom.js
//
// A self-serve DOM inspector, since I (Claude) don't have browser or
// network access to your machine or the live government website to
// inspect it myself. Run this WHILE automation.js is running and the form
// is open in the Playwright-controlled browser — it attaches to that same
// browser over Chrome DevTools Protocol (port 9222) without disturbing
// your logged-in session.
//
// Usage:
//   node inspect-dom.js              -> dumps every <select> on the page
//                                        (name, id, data-* attributes, options)
//   node inspect-dom.js --calendar   -> ALSO dumps the open date-picker
//                                        popup HTML. Click the "select date"
//                                        field in the browser FIRST, then
//                                        run this command.
//
// Paste the output back if you need help tightening a selector in
// lib/formActions.js.

const { chromium } = require('playwright');

const CDP_URL = 'http://localhost:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => !p.url().startsWith('about:')) || context.pages()[0];

  console.log('Inspecting page:', page.url());
  console.log('----------------------------------------');

  const selects = await page.$$eval('select', els => els.map((el, i) => ({
    index: i,
    name: el.getAttribute('name'),
    id: el.id,
    dataAttrs: Object.fromEntries(Object.entries(el.dataset || {})),
    options: Array.from(el.options).map(o => o.text.trim()),
  })));

  selects.forEach(s => {
    console.log(`select #${s.index}`);
    console.log('  name    :', s.name);
    console.log('  id      :', s.id);
    console.log('  data-*  :', JSON.stringify(s.dataAttrs));
    console.log('  options :', s.options);
    console.log('');
  });

  if (process.argv.includes('--calendar')) {
    console.log('---- Open date-picker popup(s) ----');
    const popups = await page.$$eval(
      '[role="dialog"], [role="listbox"], [role="grid"]',
      els => els.map(el => el.outerHTML.slice(0, 4000))
    );
    popups.forEach((html, i) => {
      console.log(`\n[popup ${i}]\n${html}\n`);
    });
    if (!popups.length) {
      console.log('(Koi role="dialog"/"grid"/"listbox" element nahi mila — pehle calendar khula hai ye confirm kar lein.)');
    }
  }

  await browser.close(); // only closes this CDP connection, not the actual browser window
}

main().catch(err => {
  console.error('inspect-dom failed:', err.message);
  console.error('Check karein ki automation.js chal raha hai aur form browser me khula hai.');
  process.exit(1);
});
