const API_BASE_URL = window.HAILIN_CONFIG?.API_BASE_URL || 'https://hailin-alumni-api.onrender.com';
const tokenKey = 'hailin_admin_token';
const userKey = 'hailin_admin_user';

const loginPanel = document.querySelector('#loginPanel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginStatus = document.querySelector('#loginStatus');
const userInfo = document.querySelector('#userInfo');
const rows = document.querySelector('#applicationRows');
const requestRows = document.querySelector('#requestRows');
const refreshBtn = document.querySelector('#refreshBtn');
const logoutBtn = document.querySelector('#logoutBtn');
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const homeForm = document.querySelector('#homeForm');
const homeStatus = document.querySelector('#homeStatus');
const loadHomeBtn = document.querySelector('#loadHomeBtn');
const loadRequestsBtn = document.querySelector('#loadRequestsBtn');

function getToken() { return localStorage.getItem(tokenKey); }
function setToken(token) { localStorage.setItem(tokenKey, token); }
function clearToken() { localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); }
function getUser() { try { return JSON.parse(localStorage.getItem(userKey) || '{}'); } catch { return {}; } }
function setUser(user) { localStorage.setItem(userKey, JSON.stringify(user || {})); }

function showDashboard() {
  const user = getUser();
  loginPanel.hidden = true;
  dashboard.hidden = false;
  userInfo.textContent = user.name ? `当前账号：${user.name}（${user.role || ''}${user.admin_level ? ' / ' + user.admin_level : ''}）` : '已登录';
}

function showLogin() {
  loginPanel.hidden = false;
  dashboard.hidden = true;
}

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusText(status) {
  return {
    pending: '待审核',
    approved: '已通过',
    rejected: '已拒绝',
    need_more_info: '需补充材料',
    active: '启用'
  }[status] || status || '未知';
}

function applicantTypeText(value) {
  return {
    graduated_alumni: '毕业校友',
    current_student: '在校师生',
    teacher: '教师',
    alumni: '校友'
  }[value] || value || '未填写';
}

function safeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || data.error || '接口请求失败');
  return data;
}

function setActiveTab(tabName) {
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
  panels.forEach(panel => panel.classList.toggle('active', panel.id === `${tabName}Panel`));
  if (tabName === 'applications') loadApplications();
  if (tabName === 'homeEditor') loadHomeContent();
  if (tabName === 'contentRequests') loadContentRequests();
}

tabs.forEach(tab => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));

function updateCounts(items) {
  document.querySelector('#totalCount').textContent = items.length;
  document.querySelector('#pendingCount').textContent = items.filter(item => item.status === 'pending').length;
  document.querySelector('#approvedCount').textContent = items.filter(item => item.status === 'approved').length;
  document.querySelector('#rejectedCount').textContent = items.filter(item => item.status === 'rejected').length;
}

function materialLinks(item) {
  const links = [];
  if (item.chsi_proof_url) links.push(['学信网证明', item.chsi_proof_url]);
  if (item.student_card_url) links.push(['学生证件', item.student_card_url]);
  if (item.admission_notice_url) links.push(['录取通知书', item.admission_notice_url]);
  const extra = safeJson(item.extra_materials);
  if (Array.isArray(extra)) {
    extra.forEach((url, index) => {
      if (url) links.push([`补充材料${index + 1}`, url]);
    });
  }
  if (!links.length) return '未上传';
  return `<div class="material-list">${links.map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`).join('')}</div>`;
}

async function loadApplications() {
  rows.innerHTML = '<tr><td colspan="7">正在加载……</td></tr>';
  try {
    const data = await api('/api/applications');
    const items = data.verifications || data.applications || data.items || [];
    updateCounts(items);
    if (!items.length) {
      rows.innerHTML = '<tr><td colspan="7">暂无申请</td></tr>';
      return;
    }
    rows.innerHTML = items.map(item => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(applicantTypeText(item.applicant_type))}<br>${escapeHtml(item.graduation_year || item.school_year || '')} ${escapeHtml(item.class_name || '')}<br>${escapeHtml(item.homeroom_teacher || '')}</td>
        <td>${escapeHtml([item.province, item.city, item.county].filter(Boolean).join(' / '))}<br>${escapeHtml([item.current_province, item.current_city, item.current_county].filter(Boolean).join(' / '))}</td>
        <td>${escapeHtml(item.phone || '')}<br>${escapeHtml(item.email || '')}</td>
        <td>${materialLinks(item)}</td>
        <td><span class="badge ${escapeHtml(item.status)}">${statusText(item.status)}</span></td>
        <td>
          <div class="row-actions">
            <button class="approve" data-review-id="${item.id}" data-status="approved">通过</button>
            <button class="reject" data-review-id="${item.id}" data-status="rejected">拒绝</button>
            <button class="ghost" data-review-id="${item.id}" data-status="need_more_info">补充</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    rows.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
    if (String(error.message).includes('登录') || String(error.message).includes('过期') || String(error.message).includes('权限')) {
      clearToken();
      showLogin();
    }
  }
}

async function loadHomeContent() {
  homeStatus.textContent = '正在读取首页内容……';
  homeStatus.className = 'status';
  try {
    const data = await api(`/api/site/home?t=${Date.now()}`);
    const sections = {};
    (data.sections || []).forEach(item => {
      sections[item.section_key] = typeof item.content === 'string' ? safeJson(item.content) : (item.content || {});
    });
    const hero = sections.home_hero || {};
    const notice = sections.home_notice || {};
    const stats = sections.home_stats || {};
    homeForm.hero_title.value = hero.title || '';
    homeForm.hero_subtitle.value = hero.subtitle || '';
    homeForm.notice_text.value = notice.text || '';
    homeForm.stats_founded.value = stats.founded || '';
    homeForm.stats_alumni.value = stats.alumni || '';
    homeForm.stats_regions.value = stats.regions || '';
    homeStatus.textContent = '首页内容已读取。';
    homeStatus.className = 'status ok';
  } catch (error) {
    homeStatus.textContent = `读取失败：${error.message}`;
    homeStatus.className = 'status';
  }
}

async function saveSection(payload) {
  return api('/api/admin/content/sections', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

homeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  homeStatus.textContent = '正在保存……';
  homeStatus.className = 'status';
  const form = Object.fromEntries(new FormData(homeForm).entries());
  try {
    const results = [];
    results.push(await saveSection({
      page_slug: 'home',
      section_key: 'home_hero',
      section_name: '首页横幅',
      display_order: 1,
      content: {
        title: form.hero_title || '',
        subtitle: form.hero_subtitle || ''
      }
    }));
    results.push(await saveSection({
      page_slug: 'home',
      section_key: 'home_notice',
      section_name: '首页公告',
      display_order: 2,
      content: {
        text: form.notice_text || ''
      }
    }));
    results.push(await saveSection({
      page_slug: 'home',
      section_key: 'home_stats',
      section_name: '首页数据',
      display_order: 3,
      content: {
        founded: form.stats_founded || '',
        alumni: form.stats_alumni || '',
        regions: form.stats_regions || ''
      }
    }));
    homeStatus.textContent = results.map(item => item.message || '保存成功').join('\n');
    homeStatus.className = 'status ok';
    await loadContentRequests();
  } catch (error) {
    homeStatus.textContent = `保存失败：${error.message}`;
    homeStatus.className = 'status';
  }
});

async function loadContentRequests() {
  requestRows.innerHTML = '<tr><td colspan="5">正在加载……</td></tr>';
  try {
    const data = await api('/api/admin/content/requests');
    const items = data.requests || [];
    if (!items.length) {
      requestRows.innerHTML = '<tr><td colspan="5">暂无内容审批</td></tr>';
      return;
    }
    requestRows.innerHTML = items.map(item => {
      const proposed = typeof item.proposed_content === 'string' ? safeJson(item.proposed_content) : (item.proposed_content || {});
      return `
        <tr>
          <td>${escapeHtml(item.title || '')}</td>
          <td>${escapeHtml(item.page_slug || '')}<br>${escapeHtml(item.section_key || '')}</td>
          <td><pre class="inline-json">${escapeHtml(JSON.stringify(proposed.content || proposed, null, 2))}</pre></td>
          <td><span class="badge ${escapeHtml(item.status)}">${statusText(item.status)}</span></td>
          <td>
            <div class="row-actions">
              <button class="approve" data-content-id="${item.id}" data-status="approved" ${item.status !== 'pending' ? 'disabled' : ''}>通过</button>
              <button class="reject" data-content-id="${item.id}" data-status="rejected" ${item.status !== 'pending' ? 'disabled' : ''}>拒绝</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    requestRows.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
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
    if (!response.ok || data.ok === false) throw new Error(data.message || '登录失败');
    setToken(data.token);
    setUser(data.user || {});
    showDashboard();
    await Promise.allSettled([loadApplications(), loadHomeContent(), loadContentRequests()]);
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

rows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-review-id]');
  if (!button) return;
  const reason = button.dataset.status === 'rejected' ? prompt('请输入拒绝原因，可留空：') : '';
  button.disabled = true;
  try {
    await api(`/api/applications/${button.dataset.reviewId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: button.dataset.status, reject_reason: reason || null })
    });
    await loadApplications();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

requestRows.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-content-id]');
  if (!button) return;
  const reason = button.dataset.status === 'rejected' ? prompt('请输入拒绝原因，可留空：') : '';
  button.disabled = true;
  try {
    await api(`/api/admin/content/requests/${button.dataset.contentId}/review`, {
      method: 'PATCH',
      body: JSON.stringify({ status: button.dataset.status, reject_reason: reason || null })
    });
    await loadContentRequests();
    await loadHomeContent();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});

refreshBtn.addEventListener('click', () => {
  const active = document.querySelector('.tab.active')?.dataset.tab || 'applications';
  setActiveTab(active);
});
loadHomeBtn.addEventListener('click', loadHomeContent);
loadRequestsBtn.addEventListener('click', loadContentRequests);
logoutBtn.addEventListener('click', () => {
  clearToken();
  showLogin();
});

if (getToken()) {
  showDashboard();
  Promise.allSettled([loadApplications(), loadHomeContent(), loadContentRequests()]);
} else {
  showLogin();
}
