const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const password = process.env.TAKKEN_PASSWORD;
if (!password) {
  console.error('TAKKEN_PASSWORD is required');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const files = ['src/questions.js', 'src/memo-questions.js', 'src/gemini-questions.js', '論点.html'];
const parts = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const plain = Buffer.from(JSON.stringify(parts), 'utf8');
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const iterations = 120000;
const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const data = Buffer.concat([cipher.update(plain), cipher.final()]);
const tag = cipher.getAuthTag();
const pack = {
  iterations,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  data: data.toString('base64')
};
const out = `window.TAKKEN_VAULT = ${JSON.stringify(pack)};\n`;
fs.writeFileSync(path.join(root, 'src/vault.js'), out);
console.log('wrote src/vault.js', out.length);
