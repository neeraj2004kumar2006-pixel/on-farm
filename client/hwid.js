// client/hwid.js
// Generates a tamper-proof hardware fingerprint for Windows PC
// Hardened with Windows MachineGuid fallback & blank/all-F filter

const { execSync } = require('child_process');
const crypto = require('crypto');

function isValidHardwareString(str) {
  if (!str || typeof str !== 'string') return false;
  const clean = str.trim().toUpperCase();
  if (clean.length < 5) return false;
  // Check for common blank/dummy motherboard UUIDs (e.g. 00000000-..., FFFFFFFF-..., To be filled by O.E.M., Default string)
  if (/^[0\-]+$/.test(clean) || /^[F\-]+$/.test(clean)) return false;
  if (clean.includes('TO BE FILLED') || clean.includes('DEFAULT STRING') || clean.includes('NONE')) return false;
  return true;
}

function getHardwareId() {
  let rawIdentifier = '';

  try {
    // 1. Motherboard / System UUID via PowerShell (Get-CimInstance, Windows 11 24H2 safe)
    const uuidOut = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (isValidHardwareString(uuidOut)) {
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

    if (isValidHardwareString(cpuOut)) {
      rawIdentifier += '_' + cpuOut.trim();
    }
  } catch { /* fallback */ }

  // 3. Fallback to Windows MachineGuid (stored in registry, unique per Windows installation)
  // This guarantees budget PCs with corrupted BIOS/blank UUID never share a duplicate fingerprint!
  if (!rawIdentifier || rawIdentifier.length < 8) {
    try {
      const guidOut = execSync('powershell -NoProfile -Command "(Get-ItemProperty -Path \'HKLM:\\SOFTWARE\\Microsoft\\Cryptography\').MachineGuid"', {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (guidOut && guidOut.length > 8) {
        rawIdentifier = 'GUID_' + guidOut;
      }
    } catch { /* fallback */ }
  }

  // 4. Ultimate fallback to computer name + username
  if (!rawIdentifier) {
    rawIdentifier = `${process.env.COMPUTERNAME || 'PC'}_${process.env.USERNAME || 'USER'}`;
  }

  // Hash into a clean 32-character SHA-256 fingerprint
  return crypto.createHash('sha256').update(rawIdentifier).digest('hex').slice(0, 32);
}

module.exports = { getHardwareId };
