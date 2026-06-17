const API_BASE_URL = window.HAILIN_CONFIG?.API_BASE_URL || 'http://localhost:3000';
const loginPanel = document.querySelector('#loginPanel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginStatus = document.querySelector('#loginStatus');
const rows = document.querySelector('#applicationRows');
const refreshBtn = document.querySelector('#refreshBtn');
const logoutBtn = document.querySelector('#logoutBtn');

const tokenKey = 'hailin_admin_token';

function getToken() {
  return localStorage.getItem(tokenKey);
}

function setToken(token) {
  localStorage.setItem(tokenKey, token);
}

function clearToken() {
  localStorage.removeItem(tokenKey);
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function showLogin() {
  loginPanel.hidden = false;
  dashboard.hidden = true;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusText(status) {
  return { pending: '待审核', approved: '已通过', rejected: '已拒绝' }[status] || status;
}

function updateCounts(items) {
  document.querySelector('#totalCount').textContent = items.length;
  document.querySelector('#pendingCount').textContent = items.filter(item => item.status === 'pending').length;
  document.querySelector('#approvedCount').textContent = items.filter(item => item.status === 'approved').length;
  document.querySelector('#rejectedCount').textContent = items.filter(item => item.status === 'rejected').length;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '接口请求失败');
  return data;
}

async function loadApplications() {
  rows.innerHTML = '<tr><td colspan="7">正在加载……</td></tr>';
  try {
    const data = await api('/api/admin/applications');
    const items = data.items || [];
    updateCounts(items);
    if (!items.length) {
      rows.innerHTML = '<tr><td colspan="7">暂无申请</td></tr>';
      return;
    }
    rows.innerHTML = items.map(item => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.year || '')}<br>${escapeHtml(item.class_name || '')}</td>
        <td>${escapeHtml(item.phone || '')}<br>${escapeHtml(item.email || '')}</td>
        <td>${escapeHtml(item.city || '')}</td>
        <td>${escapeHtml(item.message || '')}</td>
        <td><span class="badge ${escapeHtml(item.status)}">${statusText(item.status)}</span></td>
        <td>
          <div class="row-actions">
            <button class="approve" data-id="${item.id}" data-status="approved">通过</button>
            <button class="reject" data-id="${item.id}" data-status="rejected">拒绝</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
    if (String(error.message).includes('登录') || String(error.message).includes('token')) {
      clearToken();
      showLogin();
    }
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatus.textContent = '';
  const formData = new FormData(loginForm);
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(formData.entries()))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '登录失败');
    setToken(data.token);
    showDashboard();
    await loadApplications();
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

rows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/admin/applications/${button.dataset.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: button.dataset.status })
    });
    await loadApplications();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

refreshBtn.addEventListener('click', loadApplications);
logoutBtn.addEventListener('click', () => {
  clearToken();
  showLogin();
});

if (getToken()) {
  showDashboard();
  loadApplications();
} else {
  showLogin();
}
