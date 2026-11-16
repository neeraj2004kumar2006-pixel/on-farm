// generate-sample.js (optional)
// Creates farmers.sample.xlsx with the correct headers and KhataNo forced
// to TEXT format, so leading zeros are never lost. Useful as a starting
// template, or to double-check your existing farmers.xlsx is set up the
// same way.
//
//   node generate-sample.js

const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Farmers');

  ws.columns = [
    { header: 'Name', key: 'Name', width: 20 },
    { header: 'Crop', key: 'Crop', width: 26 },
    { header: 'SowingDate', key: 'SowingDate', width: 14 },
    { header: 'Ownership', key: 'Ownership', width: 14 },
    { header: 'KhataNo', key: 'KhataNo', width: 22 },
    { header: 'KhasraNo', key: 'KhasraNo', width: 12 },
    { header: 'Status', key: 'Status', width: 12 },
    { header: 'Error', key: 'Error', width: 30 },
  ];

  ws.getColumn('KhataNo').numFmt = '@'; // force text -> keeps leading zeros

  ws.addRow({
    Name: 'yasin khar',
    Crop: 'Groundnut (Pea Nut)',
    SowingDate: '15/06/2026',
    Ownership: 'Owner',
    KhataNo: '000000002070060100',
    KhasraNo: '38',
    Status: '',
    Error: '',
  });

  await wb.xlsx.writeFile('farmers.sample.xlsx');
  console.log('farmers.sample.xlsx ban gayi.');
}

main();
