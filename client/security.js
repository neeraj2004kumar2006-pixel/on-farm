// client/security.js
// In-Memory Decryption for On-Farm Desktop Runner

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

function getSecretKey() {
  const secret = process.env.SCRIPT_ENCRYPTION_SECRET || 'onfarm_super_secure_secret_key32';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Decrypts in-memory encrypted code without writing anything to disk!
 */
function decryptInMemory(encryptedHex, ivHex) {
  const key = getSecretKey();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { decryptInMemory };
