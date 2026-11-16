// client/hwid.js
// Generates a tamper-proof hardware fingerprint for Windows PC

const { execSync } = require('child_process');
const crypto = require('crypto');

function getHardwareId() {
  let rawIdentifier = '';

  try {
    // 1. Motherboard / System UUID via PowerShell
    const uuidOut = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (uuidOut && uuidOut.length > 5) {
      rawIdentifier += uuidOut;
    }
  } catch { /* fallback */ }

  try {
    // 2. CPU Processor ID via PowerShell
    const cpuOut = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).ProcessorId"', {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (cpuOut) {
      rawIdentifier += '_' + cpuOut;
    }
  } catch { /* fallback */ }

  if (!rawIdentifier) {
    // 3. Fallback to computer name + username if CimInstance blocked
    rawIdentifier = `${process.env.COMPUTERNAME || 'PC'}_${process.env.USERNAME || 'USER'}`;
  }

  // Hash into a clean 32-character SHA-256 fingerprint
  return crypto.createHash('sha256').update(rawIdentifier).digest('hex').slice(0, 32);
}

module.exports = { getHardwareId };
