const ExcelJS = require('exceljs');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, 'farmers.xlsx');

// KhataNo = 26 (Khata Sankhya Naya) - same for all rows
// KhasraNo = 18-digit: 00000000 + Mura(main+0+sub) + Kila(4 digits)
// Kila format: simple kila N → NN00, kila N/M → NNM0... wait: N=2digit, M=2digit
// e.g. kila 21/2 → 2102, kila 1 → 0100, kila 10 → 1000

function makeKhasra(muraMain, muraSub, kilaMain, kilaSub = 0) {
  const leading = '0'.repeat(11 - String(muraMain).length); // 8 zeros for 3-digit mura
  const sub2 = String(muraSub).padStart(2, '0');
  const k2 = String(kilaMain).padStart(2, '0');
  const ks2 = String(kilaSub).padStart(2, '0');
  return leading + muraMain + '0' + sub2 + k2 + ks2;
}

const rows = [
  { khasra: makeKhasra(67, 58, 1, 1) },
  { khasra: makeKhasra(67, 58, 2) },
  { khasra: makeKhasra(67, 58, 3) },
  { khasra: makeKhasra(67, 58, 4) },
  { khasra: makeKhasra(67, 58, 5) },
  { khasra: makeKhasra(67, 58, 6) },
  { khasra: makeKhasra(67, 58, 7) },
  { khasra: makeKhasra(67, 58, 8) },
  { khasra: makeKhasra(67, 58, 9) },
  { khasra: makeKhasra(67, 58, 10, 1) },
  { khasra: makeKhasra(67, 58, 11, 1) },
  { khasra: makeKhasra(67, 58, 12) },
  { khasra: makeKhasra(67, 58, 13) },
  { khasra: makeKhasra(67, 58, 14) },
  { khasra: makeKhasra(67, 58, 15) },
  { khasra: makeKhasra(67, 58, 16) },
  { khasra: makeKhasra(67, 58, 17) },
  { khasra: makeKhasra(67, 58, 18) },
  { khasra: makeKhasra(67, 58, 19) },
  { khasra: makeKhasra(67, 58, 20, 1) },
  { khasra: makeKhasra(67, 58, 21, 1) },
  { khasra: makeKhasra(67, 58, 22) },
  { khasra: makeKhasra(67, 58, 23) },
  { khasra: makeKhasra(67, 58, 24) },
  { khasra: makeKhasra(67, 58, 25) },
].map(({ khasra }) => ({
  Name: 'हलीमा',
  Crop: 'Groundnut (Pea Nut)',
  SowingDate: '20/06/2026',
  Ownership: 'Owner',
  KhataNo: '61',
  KhasraNo: khasra,
  FarmerName: 'हलीमा',
  Status: '',
  Error: '',
}));

async function generate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Farmers');

  // Headers — KhasraNo pehle, KhataNo baad mein
  ws.addRow(['Name', 'Crop', 'SowingDate', 'Ownership', 'KhasraNo', 'KhataNo', 'FarmerName', 'Status', 'Error']);

  // Column widths set karo
  ws.getColumn(1).width = 18; // Name
  ws.getColumn(2).width = 22; // Crop
  ws.getColumn(3).width = 14; // SowingDate
  ws.getColumn(4).width = 12; // Ownership
  ws.getColumn(5).width = 22; // KhasraNo (18-digit)
  ws.getColumn(6).width = 12; // KhataNo
  ws.getColumn(7).width = 18; // FarmerName
  ws.getColumn(8).width = 10; // Status
  ws.getColumn(9).width = 20; // Error

  // KhasraNo column (col 5) ko Text format mein set karo (18-digit number)
  ws.getColumn(5).numFmt = '@';

  // Data rows
  rows.forEach(r => {
    const row = ws.addRow([r.Name, r.Crop, r.SowingDate, r.Ownership, r.KhasraNo, r.KhataNo, r.FarmerName, r.Status, r.Error]);
    // KhasraNo cell explicitly text
    row.getCell(5).value = r.KhasraNo;
    row.getCell(5).numFmt = '@';
  });

  await wb.xlsx.writeFile(EXCEL_PATH);
  console.log(`Done! ${rows.length} rows farmers.xlsx mein add ho gayi.`);
}

generate().catch(console.error);
