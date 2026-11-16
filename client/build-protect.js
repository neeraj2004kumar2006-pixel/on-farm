// client/build-protect.js
// Obfuscates and encrypts JavaScript code to make reverse-engineering impossible!

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

console.log('🔒 Starting On-Farm Code Hardening & Obfuscation...');

const filesToProtect = ['security.js', 'hwid.js', 'runner.js'];

const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.8,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayEncoding: ['base64', 'rc4'],
  stringArrayThreshold: 0.8,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// Create a 'protected' dist directory for production release
const distDir = path.join(__dirname, 'dist-protected');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

for (const file of filesToProtect) {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    const rawCode = fs.readFileSync(filePath, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(rawCode, obfuscatorOptions).getObfuscatedCode();
    const outPath = path.join(distDir, file);
    fs.writeFileSync(outPath, obfuscated);
    console.log(`✅ Protected: ${file} -> dist-protected/${file}`);
  }
}

console.log('🛡️ Code protection build completed successfully!');
