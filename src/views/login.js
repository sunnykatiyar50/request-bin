document.getElementById('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorEl = document.getElementById('loginError');
    const button = event.target.querySelector('button[type="submit"]');
    errorEl.textContent = '';
    button.disabled = true;
    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
            body: JSON.stringify({ password: document.getElementById('passwordInput').value }),
        });
        if (response.ok) {
            window.location.href = '/';
            return;
        }
        const data = await response.json().catch(() => ({}));
        errorEl.textContent = data.error || 'Sign in failed.';
    } catch {
        errorEl.textContent = 'Could not reach the server.';
    } finally {
        button.disabled = false;
    }
});
