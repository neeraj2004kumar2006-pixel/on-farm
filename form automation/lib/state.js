// lib/state.js
// Simple shared, in-memory state used by both automation.js and the control panel API.
// Kept in one module (instead of globals scattered around) so the panel's
// /status endpoint and the automation loop always agree on the current state.

const state = {
  isRunning: false,
  stopRequested: false,
  currentRow: null,      // { index, name } | null
  totalRows: 0,
  processedCount: 0,
  lastError: null,
  logs: [],               // recent log lines, newest last (shown in the panel)
};

function log(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  state.logs.push(stamped);
  if (state.logs.length > 200) state.logs.shift();
  console.log(stamped);
}

// Thrown from inside the row-processing steps when the user has pressed STOP.
// Caught separately from real errors so a manual stop is never recorded as a
// row failure.
class StopRequested extends Error {}

module.exports = { state, log, StopRequested };
