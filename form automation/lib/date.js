// form automation/lib/date.js
// Parses Excel SowingDate (Date object, Excel serial number, or DD/MM/YYYY string)
// Throws strict validation error if date is invalid (Never silently defaults to today!)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseSowingDate(raw) {
  if (raw instanceof Date) {
    return raw;
  }
  // Handle numeric Excel date serial numbers (e.g. 45100)
  if (typeof raw === 'number' && raw > 25000 && raw < 75000) {
    const epochDays = raw - 25569;
    return new Date(epochDays * 86400 * 1000);
  }

  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) {
    throw new Error(`SowingDate "${s}" is invalid. Expected format: DD/MM/YYYY (e.g. 15/06/2026).`);
  }
  const [, dd, mm, yyyy] = m;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (date.getMonth() !== Number(mm) - 1 || date.getDate() !== Number(dd)) {
    throw new Error(`SowingDate "${s}" is not a valid calendar date.`);
  }
  return date;
}

function monthYearLabel(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Builds an accurate regex to find the day button in datepicker, matching weekday, month, day, and year
function dayButtonPattern(date) {
  const weekday = WEEKDAYS[date.getDay()];
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return new RegExp(`${weekday}.*${month}.*\\b0?${day}\\b(?:.*${year})?`, 'i');
}

module.exports = { parseSowingDate, monthYearLabel, dayButtonPattern, MONTHS, WEEKDAYS };
