let csrfToken = '';

async function fetchCsrf() {
  try {
    const d = await fetch('/api/auth/csrf').then(r => r.json());
    csrfToken = d.token || '';
  } catch { csrfToken = ''; }
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('show');
}
function clearError() {
  document.getElementById('errorMsg').classList.remove('show');
}

function showStep(n) {
  document.getElementById('step1').classList.toggle('active', n === 1);
  document.getElementById('step2').classList.toggle('active', n === 2);
  clearError();
}

// Fetch CSRF token on page load
fetchCsrf();

/* ── Step 1: credentials ── */
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (data.requireTotp) {
        showStep(2);
        document.getElementById('totpCode').focus();
      } else {
        window.location.href = '/admin/dashboard';
      }
    } else {
      showError(data.error || 'Invalid credentials');
    }
  } catch {
    showError('Connection error. Is the server running?');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

/* ── Step 2: TOTP ── */
document.getElementById('totpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const btn = document.getElementById('totpBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
    const res = await fetch('/api/auth/totp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ token: document.getElementById('totpCode').value.replace(/\s/g, '') }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      window.location.href = '/admin/dashboard';
    } else {
      showError(data.error || 'Invalid code');
      document.getElementById('totpCode').value = '';
      document.getElementById('totpCode').focus();
    }
  } catch {
    showError('Connection error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
});

document.getElementById('backBtn').addEventListener('click', () => showStep(1));
