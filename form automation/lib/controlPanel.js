// lib/controlPanel.js
// Minimal local web server for the START / STOP / Status control panel.

const express = require('express');
const path = require('path');
const { state } = require('./state');

function startControlPanel({ port, onStart, onStop }) {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/status', (req, res) => {
    res.json({
      isRunning: state.isRunning,
      currentRow: state.currentRow,
      totalRows: state.totalRows,
      processedCount: state.processedCount,
      lastError: state.lastError,
      logs: state.logs.slice(-30),
    });
  });

  app.post('/start', (req, res) => {
    onStart();
    res.json({ ok: true });
  });

  app.post('/stop', (req, res) => {
    onStop();
    res.json({ ok: true });
  });

  app.post('/reset', async (req, res) => {
    if (state.isRunning) {
      return res.json({ ok: false, message: 'Automation chal raha hai — pehle STOP karein.' });
    }
    try {
      const { FarmerSheet } = require('./excel');
      const path = require('path');
      const sheet = new FarmerSheet(path.join(__dirname, '..', 'farmers.xlsx'));
      await sheet.load();
      const count = await sheet.resetAll();
      state.processedCount = 0;
      state.lastError = null;
      state.currentRow = null;
      const { log } = require('./state');
      log(`Reset complete — ${count} rows ka Status/Error clear ho gaya.`);
      res.json({ ok: true, count });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  const server = app.listen(port).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Port ${port} already use mein hai.`);
      console.error(`Fix: Task Manager mein purana "node.exe" process band karein,`);
      console.error(`     ya PowerShell mein yeh chalayein:`);
      console.error(`     netstat -ano | findstr :${port}  (PID dekho)`);
      console.error(`     taskkill /F /PID <PID>\n`);
      process.exit(1);
    }
    throw err;
  });
  return server;
}

module.exports = { startControlPanel };
