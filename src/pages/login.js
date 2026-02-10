document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('errorMsg');
  const btn = document.getElementById('submitBtn');

  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  const result = await window.electronAPI.login(email, password);
  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (result.success) {
    await window.electronAPI.nav('dashboard');
  } else {
    errorEl.textContent = result.error || 'Login failed';
    errorEl.classList.remove('hidden');
  }
});
