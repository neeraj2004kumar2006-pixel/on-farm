// server/security.js
// Handles AES-256-CBC encryption and payload protection for in-memory execution.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

function getSecretKey() {
  const secret = process.env.SCRIPT_ENCRYPTION_SECRET || 'onfarm_super_secure_secret_key32';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts plain JavaScript string to an encrypted payload
 */
function encryptScript(plainJsCode) {
  const key = getSecretKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainJsCode, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted_code: encrypted,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypts an encrypted payload back into executable JavaScript string
 */
function decryptScript(encryptedCodeHex, ivHex) {
  const key = getSecretKey();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  let decrypted = decipher.update(encryptedCodeHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = {
  encryptScript,
  decryptScript,
};
