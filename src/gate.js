const PASS_KEY = 'takken-pass';

function bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function decrypt(password, pack) {
  const keyMat = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(pack.salt), iterations: pack.iterations, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const data = bytes(pack.data);
  const tag = bytes(pack.tag);
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(pack.iv) }, key, combined);
  return new TextDecoder().decode(plain);
}

function loadCode(code) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([code], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    script.onerror = () => reject(new Error('load'));
    document.body.appendChild(script);
  });
}

function loadUrl(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(url));
    document.body.appendChild(script);
  });
}

async function unlock(password) {
  const text = await decrypt(password, window.TAKKEN_VAULT);
  const parts = JSON.parse(text);
  for (const code of parts) await loadCode(code);
  await loadUrl('src/main.js?v=6');
  localStorage.setItem(PASS_KEY, password);
  document.getElementById('gate').hidden = true;
}

function showError() {
  document.getElementById('gate-error').hidden = false;
}

async function tryPassword(password) {
  document.getElementById('gate-error').hidden = true;
  try {
    await unlock(password);
  } catch (_) {
    localStorage.removeItem(PASS_KEY);
    showError();
  }
}

document.getElementById('gate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = document.getElementById('gate-password').value;
  if (!password) return;
  tryPassword(password);
});

const saved = localStorage.getItem(PASS_KEY);
if (saved) tryPassword(saved);
