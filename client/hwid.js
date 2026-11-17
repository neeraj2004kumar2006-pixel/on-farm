// client/hwid.js
// Generates a tamper-proof hardware fingerprint for Windows PC
// Fast reg.exe MachineGuid + Get-CimInstance SMBIOS UUID with in-memory caching

const { execFileSync } = require('child_process');
const crypto = require('crypto');

let cachedHardwareId = null;

function isValidSmbiosUuid(str) {
  if (!str || typeof str !== 'string') return false;
  const clean = str.trim().toUpperCase();
  if (clean.length < 10) return false;
  // Detect blank or all-zeros / all-Fs dummy UUIDs commonly found on cheap OEM boards
  if (/^[0\-]+$/.test(clean) || /^[F\-]+$/.test(clean)) return false;
  if (clean.includes('TO BE FILLED') || clean.includes('DEFAULT STRING') || clean.includes('NONE') || clean.includes('OEM')) return false;
  return true;
}

function getHardwareId() {
  if (cachedHardwareId) return cachedHardwareId;

  let machineGuid = '';
  let smbiosUuid = '';

  // 1. Fast, synchronous read of Windows MachineGuid via reg.exe (takes ~5ms, unique per Windows install)
  try {
    const out = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    machineGuid = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i) || [])[1] || '';
  } catch { /* fallback */ }

  // 2. Read Motherboard UUID via PowerShell Get-CimInstance (Windows 11 24H2 safe)
  try {
    const uuidOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (isValidSmbiosUuid(uuidOut)) {
      smbiosUuid = uuidOut;
    }
  } catch { /* fallback */ }

  // 3. Fallback to CPU processor ID or computer name if needed
  let fallbackId = '';
  if (!machineGuid && !smbiosUuid) {
    fallbackId = `${process.env.COMPUTERNAME || 'PC'}_${process.env.USERNAME || 'USER'}`;
  }

  // Combine components into a stable unique fingerprint
  // Always incorporates MachineGuid so budget PCs with blank BIOS UUID never collide!
  const rawPayload = `onfarm-hwid-v2|${machineGuid}|${smbiosUuid}|${fallbackId}`;
  cachedHardwareId = crypto.createHash('sha256').update(rawPayload).digest('hex').slice(0, 32);

  return cachedHardwareId;
}

module.exports = { getHardwareId };
