// lib/excel.js
// Reads farmers.xlsx by HEADER NAME (not fixed column letters), so column
// order in the sheet doesn't matter. KhataNo is always treated/saved as text
// so leading zeros are never lost.

const ExcelJS = require('exceljs');

const REQUIRED_COLUMNS = ['Name', 'Crop', 'SowingDate', 'Ownership', 'KhataNo', 'KhasraNo', 'Status', 'Error'];

class FarmerSheet {
  constructor(filePath) {
    this.filePath = filePath;
    this.workbook = null;
    this.sheet = null;
    this.colIndex = {}; // header name -> column number
    this.headerRowNumber = 1;
  }

  async load() {
    this.workbook = new ExcelJS.Workbook();
    await this.workbook.xlsx.readFile(this.filePath);
    this.sheet = this.workbook.worksheets[0];

    const headerRow = this.sheet.getRow(this.headerRowNumber);
    headerRow.eachCell((cell, colNumber) => {
      const name = String(cell.value || '').trim();
      if (name) this.colIndex[name] = colNumber;
    });

    for (const col of REQUIRED_COLUMNS) {
      if (!this.colIndex[col]) {
        throw new Error(`farmers.xlsx me "${col}" column nahi mila. Row 1 me headers check karein: ${REQUIRED_COLUMNS.join(', ')}`);
      }
    }

    // Force the KhataNo column to be treated as text on save too.
    const khataCol = this.sheet.getColumn(this.colIndex['KhataNo']);
    khataCol.numFmt = '@';
  }

  _cell(rowNumber, colName) {
    return this.sheet.getRow(rowNumber).getCell(this.colIndex[colName]);
  }

  _cellText(rowNumber, colName) {
    const cell = this._cell(rowNumber, colName);
    const v = cell.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object' && v.text) return String(v.text); // rich text cell
    if (typeof v === 'object' && v.result !== undefined) return String(v.result); // formula cell
    return String(v).trim();
  }

  getRows() {
    const rows = [];
    let rowNumber = this.headerRowNumber + 1;
    const lastRow = this.sheet.lastRow ? this.sheet.lastRow.number : this.headerRowNumber;

    for (; rowNumber <= lastRow; rowNumber++) {
      const nameVal = this._cellText(rowNumber, 'Name');
      const cropVal = this._cellText(rowNumber, 'Crop');
      if (!nameVal && !cropVal) continue; // skip fully blank rows

      rows.push({
        rowNumber,
        Name: nameVal,
        Crop: cropVal,
        SowingDateRaw: this._cell(rowNumber, 'SowingDate').value,
        Ownership: this._cellText(rowNumber, 'Ownership'),
        KhataNo: this._cellText(rowNumber, 'KhataNo'),
        KhasraNo: this._cellText(rowNumber, 'KhasraNo'),
        FarmerName: this.colIndex['FarmerName'] ? this._cellText(rowNumber, 'FarmerName') : '',
        Status: this._cellText(rowNumber, 'Status').toString().toUpperCase(),
        Error: this._cellText(rowNumber, 'Error'),
      });
    }
    return rows;
  }

  async markDone(rowNumber) {
    this._cell(rowNumber, 'Status').value = 'DONE';
    this._cell(rowNumber, 'Error').value = '';
    await this.save();
  }

  async markError(rowNumber, message) {
    this._cell(rowNumber, 'Status').value = 'ERROR';
    this._cell(rowNumber, 'Error').value = String(message).slice(0, 500);
    await this.save();
  }

  async resetAll() {
    const rows = this.getRows();
    for (const row of rows) {
      this._cell(row.rowNumber, 'Status').value = '';
      this._cell(row.rowNumber, 'Error').value = '';
    }
    await this.save();
    return rows.length;
  }

  async save() {
    await this.workbook.xlsx.writeFile(this.filePath);
  }
}

module.exports = { FarmerSheet, REQUIRED_COLUMNS };
