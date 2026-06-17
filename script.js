const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#primary-nav');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.matches('a')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

const API_BASE_URL = window.HAILIN_CONFIG?.API_BASE_URL || 'http://localhost:3000';
const form = document.querySelector('.join-form');

function setFormStatus(message, type = '') {
  const status = form?.querySelector('.form-status');
  if (!status) return;
  status.textContent = message;
  status.className = `form-status ${type}`.trim();
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      submitButton.disabled = true;
      setFormStatus('正在提交，请稍候……');

      const response = await fetch(`${API_BASE_URL}/api/applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '提交失败，请稍后再试');

      form.reset();
      setFormStatus('提交成功，管理员审核后会与你联系。', 'success');
    } catch (error) {
      setFormStatus(`提交失败：${error.message}。请确认后端接口已启动，或联系管理员。`, 'error');
    } finally {
      submitButton.disabled = false;
    }
  });
}
