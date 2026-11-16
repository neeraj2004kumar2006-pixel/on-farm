// lib/date.js
// Parses the Excel SowingDate value and builds a fuzzy pattern to find the
// matching day button in whatever date-picker widget the site uses.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Accepts either a JS Date (if Excel stored SowingDate as a real date cell)
// or a "DD/MM/YYYY" text string (as in the example data).
function parseSowingDate(raw) {
  if (raw instanceof Date) {
    return raw;
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) {
    throw new Error(`SowingDate "${s}" samajh nahi aayi. Expected format: DD/MM/YYYY (e.g. 15/06/2026).`);
  }
  const [, dd, mm, yyyy] = m;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (date.getMonth() !== Number(mm) - 1 || date.getDate() !== Number(dd)) {
    throw new Error(`SowingDate "${s}" ek valid calendar date nahi hai.`);
  }
  return date;
}

function monthYearLabel(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Builds a loose regex to find the day button by its accessible name.
// The original Codegen recording showed names like "Monday, June 15,",
// so we match weekday -> month -> day in order, and let anything else
// (year, "th"/"st" suffixes, extra punctuation) float freely around them.
function dayButtonPattern(date) {
  const weekday = WEEKDAYS[date.getDay()];
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  return new RegExp(`${weekday}.*${month}.*\\b0?${day}\\b`, 'i');
}

module.exports = { parseSowingDate, monthYearLabel, dayButtonPattern, MONTHS, WEEKDAYS };
