const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://zwx-hub.github.io/hailin-high-school-alumni').replace(/\/$/, '');

const pool = DATABASE_URL
  ? (() => {
      const dbUrl = new URL(DATABASE_URL);
      return new Pool({
        host: dbUrl.hostname,
        port: Number(dbUrl.port || 5432),
        database: dbUrl.pathname.replace(/^\//, '') || 'postgres',
        user: decodeURIComponent(dbUrl.username),
        password: decodeURIComponent(dbUrl.password),
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
    })()
  : null;

// 强制放开跨域，避免 GitHub Pages -> Render 被浏览器拦截。
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, message, ...extra });
}

async function dbQuery(text, params = []) {
  if (!pool) throw new Error('DATABASE_URL 未配置');
  return pool.query(text, params);
}

function normalizeEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function makeInviteCode() {
  return crypto.randomBytes(24).toString('hex');
}

function makeInviteLink(code) {
  return `${PUBLIC_SITE_URL}/admin/?invite=${encodeURIComponent(code)}`;
}

function requireStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('密码至少 8 位');
  return value;
}

function normalizePermissions(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function ensureRootAdmin() {
  if (!pool) return;
  await dbQuery(
    `insert into public.app_users (phone, display_name, role, status, is_phone_verified)
     values ($1, $2, 'super_admin', 'active', true)
     on conflict (phone) do update set role='super_admin', status='active', updated_at=now()
     returning id`,
    ['ROOT_ADMIN', '主管理员']
  );
  const user = await dbQuery(`select id from public.app_users where phone=$1 limit 1`, ['ROOT_ADMIN']);
  if (user.rows[0]) {
    await dbQuery(
      `insert into public.admin_accounts (user_id, admin_level, status, approved_at, note)
       values ($1, 'super_admin', 'approved', now(), '系统主管理员')
       on conflict (user_id) do update set admin_level='super_admin', status='approved', updated_at=now()`,
      [user.rows[0].id]
    );
  }
}

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      admin_id: user.admin_id,
      display_name: user.display_name,
      role: user.role,
      admin_level: user.admin_level || null,
    },
    TOKEN_SECRET,
    { expiresIn: '7d' }
  );
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

function requireAuth(req, res, next) {
  const token = getBearer(req);
  if (!token) return fail(res, 401, '未登录');
  try {
    req.user = jwt.verify(token, TOKEN_SECRET);
    return next();
  } catch (e) {
    return fail(res, 401, '登录已过期，请重新登录');
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) return fail(res, 403, '需要管理员权限');
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') return fail(res, 403, '需要主管理员权限');
  return next();
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

async function audit(req, action, targetType, targetId, detail = {}) {
  try {
    await dbQuery(
      `insert into public.audit_logs (actor_user_id, actor_role, action, target_type, target_id, ip_address, user_agent, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user?.user_id || null,
        req.user?.role || null,
        action,
        targetType || null,
        targetId || null,
        req.ip,
        req.headers['user-agent'] || '',
        JSON.stringify(detail),
      ]
    );
  } catch (e) {
    console.warn('audit log failed:', e.message);
  }
}

// 健康检查
app.get('/api/health', async (req, res) => {
  try {
    if (pool) await dbQuery('select 1');
    return ok(res, { service: 'hailin-alumni-backend', message: '海林市高级中学校友会后端接口运行中', database: pool ? 'connected' : 'not_configured' });
  } catch (e) {
    return fail(res, 500, '后端运行中，但数据库连接失败', { error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: '接口不存在，请访问 /api/health' });
});

// 管理员登录：兼容旧后台：admin + ADMIN_PASSWORD
app.post(['/api/admin/login', '/api/login'], async (req, res) => {
  try {
    const { username, phone, password } = req.body || {};
    const loginName = (username || phone || '').trim();
    if (!loginName || !password) return fail(res, 400, '请输入账号和密码');

    await ensureRootAdmin();

    // 环境变量主管理员登录
    if (loginName === ADMIN_USER && password === ADMIN_PASSWORD) {
      const r = await dbQuery(
        `select u.id as user_id, u.display_name, u.role, a.id as admin_id, a.admin_level
         from public.app_users u
         join public.admin_accounts a on a.user_id=u.id
         where u.phone='ROOT_ADMIN'
         limit 1`
      );
      const user = r.rows[0] || { user_id: null, admin_id: null, display_name: '主管理员', role: 'super_admin', admin_level: 'super_admin' };
      const token = signToken(user);
      await audit({ ...req, user }, 'admin_login', 'admin_account', user.admin_id, { loginName });
      return ok(res, { token, user: { name: user.display_name, role: user.role, admin_level: user.admin_level } });
    }

    // 数据库管理员登录：后面可给每个管理员设置 password_hash
    const r = await dbQuery(
      `select u.id as user_id, u.display_name, u.phone, u.role, u.status, u.password_hash,
              a.id as admin_id, a.admin_level, a.status as admin_status
       from public.app_users u
       join public.admin_accounts a on a.user_id=u.id
       where u.phone=$1 or u.email=$1
       limit 1`,
      [loginName]
    );
    const user = r.rows[0];
    if (!user) return fail(res, 401, '账号或密码错误');
    if (user.status !== 'active' || user.admin_status !== 'approved') return fail(res, 403, '管理员账号未审批或已禁用');
    if (!user.password_hash) return fail(res, 401, '该管理员暂未设置密码');
    const matched = await bcrypt.compare(password, user.password_hash);
    if (!matched) return fail(res, 401, '账号或密码错误');
    const token = signToken(user);
    await audit({ ...req, user }, 'admin_login', 'admin_account', user.admin_id, { loginName });
    return ok(res, { token, user: { name: user.display_name, role: user.role, admin_level: user.admin_level } });
  } catch (e) {
    console.error(e);
    return fail(res, 500, '登录失败', { error: e.message });
  }
});

app.get('/api/admin/me', requireAuth, requireAdmin, async (req, res) => {
  return ok(res, { user: req.user });
});


// 免费邮箱账号：不发短信、不接付费邮件。注册后仍需管理员审核认证才能进入通讯录。
app.post(['/api/auth/register', '/api/alumni/register'], async (req, res) => {
  try {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    const password = requireStrongPassword(b.password);
    const name = String(b.name || b.display_name || '').trim();
    const phone = String(b.phone || '').trim() || null;
    if (!email || !email.includes('@')) return fail(res, 400, '请输入有效邮箱');
    if (!name) return fail(res, 400, '请输入姓名');
    const passwordHash = await bcrypt.hash(password, 10);
    const r = await dbQuery(
      `insert into public.app_users (email, phone, display_name, role, status, password_hash, is_email_verified)
       values ($1,$2,$3,'pending_alumni','pending',$4,false)
       on conflict (email) do update set display_name=excluded.display_name, phone=coalesce(excluded.phone, public.app_users.phone), password_hash=excluded.password_hash, updated_at=now()
       returning id, email, phone, display_name, role, status`,
      [email, phone, name, passwordHash]
    );
    return ok(res, { user: r.rows[0], message: '邮箱账号已创建。请继续提交校友认证资料，审核通过后可查看校友通讯录。' });
  } catch (e) {
    return fail(res, 500, '注册失败', { error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const loginName = normalizeEmail(req.body?.email || req.body?.username || req.body?.phone);
    const password = String(req.body?.password || '');
    if (!loginName || !password) return fail(res, 400, '请输入邮箱/账号和密码');
    const r = await dbQuery(
      `select id as user_id, display_name, email, phone, role, status, password_hash
       from public.app_users
       where lower(email)=lower($1) or phone=$1
       limit 1`,
      [loginName]
    );
    const user = r.rows[0];
    if (!user || !user.password_hash) return fail(res, 401, '账号或密码错误');
    const matched = await bcrypt.compare(password, user.password_hash);
    if (!matched) return fail(res, 401, '账号或密码错误');
    if (!['active', 'pending'].includes(user.status)) return fail(res, 403, '账号已禁用或审核未通过');
    const token = signToken({ ...user, admin_id: null, admin_level: null });
    await dbQuery(`update public.app_users set last_login_at=now(), updated_at=now() where id=$1`, [user.user_id]).catch(() => {});
    return ok(res, { token, user: { name: user.display_name, email: user.email, phone: user.phone, role: user.role, status: user.status } });
  } catch (e) {
    return fail(res, 500, '登录失败', { error: e.message });
  }
});

// 管理员本人资料和密码
app.patch('/api/admin/account/profile', requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const displayName = String(b.display_name || b.name || '').trim();
    const email = normalizeEmail(b.email || '');
    const phone = String(b.phone || '').trim();
    if (!displayName) return fail(res, 400, '姓名不能为空');
    await dbQuery(
      `update public.app_users set display_name=$1, email=nullif($2,''), phone=nullif($3,''), updated_at=now() where id=$4`,
      [displayName, email, phone, req.user.user_id]
    );
    await dbQuery(
      `update public.admin_accounts set title=$1, department=$2, province=$3, city=$4, note=$5, updated_at=now() where id=$6`,
      [b.title || null, b.department || null, b.province || null, b.city || null, b.note || null, req.user.admin_id]
    );
    await audit(req, 'admin_profile_update', 'admin_account', req.user.admin_id, {});
    return ok(res, { message: '个人信息已保存' });
  } catch (e) {
    return fail(res, 500, '保存个人信息失败', { error: e.message });
  }
});

app.post('/api/admin/account/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const password = requireStrongPassword(req.body?.password);
    const oldPassword = String(req.body?.old_password || '');
    const r = await dbQuery(`select password_hash from public.app_users where id=$1 limit 1`, [req.user.user_id]);
    const oldHash = r.rows[0]?.password_hash;
    if (oldHash && oldPassword) {
      const matched = await bcrypt.compare(oldPassword, oldHash);
      if (!matched) return fail(res, 401, '原密码不正确');
    }
    const hash = await bcrypt.hash(password, 10);
    await dbQuery(`update public.app_users set password_hash=$1, updated_at=now() where id=$2`, [hash, req.user.user_id]);
    await dbQuery(`update public.admin_accounts set last_password_changed_at=now(), updated_at=now() where id=$1`, [req.user.admin_id]).catch(() => {});
    await audit(req, 'admin_password_change', 'admin_account', req.user.admin_id, {});
    return ok(res, { message: '密码已修改，下次登录请使用新密码' });
  } catch (e) {
    return fail(res, 500, '修改密码失败', { error: e.message });
  }
});

app.get('/api/admin/accounts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `select a.id as admin_id, a.admin_level, a.status as admin_status, a.title, a.department, a.province, a.city, a.permissions, a.note,
              u.id as user_id, u.display_name, u.email, u.phone, u.role, u.status as user_status, u.created_at, u.updated_at
       from public.admin_accounts a
       join public.app_users u on u.id=a.user_id
       order by case when a.admin_level='super_admin' then 0 else 1 end, u.created_at asc`
    );
    return ok(res, { admins: r.rows });
  } catch (e) {
    return fail(res, 500, '获取管理员列表失败', { error: e.message });
  }
});

app.patch('/api/admin/accounts/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const allowedLevels = ['admin', 'editor', 'reviewer', 'viewer', 'super_admin'];
    const allowedStatus = ['approved', 'disabled', 'pending'];
    if (b.admin_level && !allowedLevels.includes(b.admin_level)) return fail(res, 400, '管理员级别不正确');
    if (b.status && !allowedStatus.includes(b.status)) return fail(res, 400, '管理员状态不正确');
    const r = await dbQuery(
      `update public.admin_accounts
       set admin_level=coalesce($1, admin_level), status=coalesce($2, status), permissions=coalesce($3, permissions), note=coalesce($4, note), updated_at=now()
       where id=$5 returning *`,
      [b.admin_level || null, b.status || null, b.permissions ? JSON.stringify(b.permissions) : null, b.note || null, id]
    );
    if (!r.rows[0]) return fail(res, 404, '管理员不存在');
    await audit(req, 'admin_account_update', 'admin_account', id, b);
    return ok(res, { admin: r.rows[0], message: '管理员权限已更新' });
  } catch (e) {
    return fail(res, 500, '更新管理员失败', { error: e.message });
  }
});

// 校友认证提交：兼容旧 /api/applications
app.post(['/api/alumni/verify', '/api/applications'], async (req, res) => {
  try {
    const b = req.body || {};
    const applicantType = b.applicant_type || b.applicantType || b.type || 'graduated_alumni';
    const name = b.name || b.real_name || b.realName;
    const phone = b.phone || b.mobile;
    if (!name || !phone) return fail(res, 400, '姓名和手机号不能为空');

    const row = {
      applicant_type: applicantType,
      name,
      phone,
      gender: b.gender || null,
      id_tail: b.id_tail || b.idTail || null,
      province: b.province || null,
      city: b.city || null,
      county: b.county || null,
      current_province: b.current_province || b.currentProvince || null,
      current_city: b.current_city || b.currentCity || null,
      current_county: b.current_county || b.currentCounty || null,
      graduation_year: b.graduation_year || b.graduationYear || null,
      class_name: b.class_name || b.className || b.class || null,
      homeroom_teacher: b.homeroom_teacher || b.teacher || b.classTeacher || null,
      school_year: b.school_year || b.schoolYear || null,
      current_school: b.current_school || b.currentSchool || b.school || null,
      university_graduated: b.university_graduated || b.universityGraduated || b.university || null,
      chsi_proof_url: b.chsi_proof_url || b.chsiProofUrl || null,
      student_card_url: b.student_card_url || b.studentCardUrl || null,
      admission_notice_url: b.admission_notice_url || b.admissionNoticeUrl || null,
      extra_materials: JSON.stringify(b.extra_materials || b.extraMaterials || []),
      consent_personal_info: Boolean(b.consent_personal_info ?? b.consentPersonalInfo ?? true),
      consent_material_review: Boolean(b.consent_material_review ?? b.consentMaterialReview ?? true),
    };

    const r = await dbQuery(
      `insert into public.alumni_verifications
       (applicant_type,name,phone,gender,id_tail,province,city,county,current_province,current_city,current_county,
        graduation_year,class_name,homeroom_teacher,school_year,current_school,university_graduated,
        chsi_proof_url,student_card_url,admission_notice_url,extra_materials,consent_personal_info,consent_material_review)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       returning *`,
      [
        row.applicant_type,row.name,row.phone,row.gender,row.id_tail,row.province,row.city,row.county,row.current_province,row.current_city,row.current_county,
        row.graduation_year,row.class_name,row.homeroom_teacher,row.school_year,row.current_school,row.university_graduated,
        row.chsi_proof_url,row.student_card_url,row.admission_notice_url,row.extra_materials,row.consent_personal_info,row.consent_material_review
      ]
    );
    return ok(res, { application: r.rows[0], verification: r.rows[0], message: '校友认证资料已提交，等待审核' });
  } catch (e) {
    console.error(e);
    return fail(res, 500, '提交失败', { error: e.message });
  }
});

app.get(['/api/applications', '/api/admin/applications', '/api/admin/alumni/verifications'], requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `where status=$1`; }
    const r = await dbQuery(
      `select * from public.alumni_verifications ${where} order by created_at desc limit 500`,
      params
    );
    return ok(res, { applications: r.rows, verifications: r.rows, items: r.rows });
  } catch (e) {
    return fail(res, 500, '获取认证列表失败', { error: e.message });
  }
});

app.patch(['/api/applications/:id/status', '/api/admin/applications/:id/status', '/api/admin/alumni/verifications/:id/review'], requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body.status || req.body.action;
    const rejectReason = req.body.reject_reason || req.body.rejectReason || null;
    if (!['approved', 'rejected', 'need_more_info', 'pending'].includes(status)) return fail(res, 400, '审核状态不正确');

    const updated = await dbQuery(
      `update public.alumni_verifications
       set status=$1, reject_reason=$2, reviewed_by=$3, reviewed_at=now(), updated_at=now()
       where id=$4
       returning *`,
      [status, rejectReason, req.user.admin_id, id]
    );
    if (!updated.rows[0]) return fail(res, 404, '认证记录不存在');

    // 通过后自动生成/更新校友用户和校友档案
    if (status === 'approved') {
      const v = updated.rows[0];
      const u = await dbQuery(
        `insert into public.app_users (phone, display_name, role, status, is_phone_verified)
         values ($1,$2,'alumni','active',false)
         on conflict (phone) do update set display_name=excluded.display_name, role='alumni', status='active', updated_at=now()
         returning id`,
        [v.phone, v.name]
      );
      const userId = u.rows[0].id;
      await dbQuery(
        `insert into public.alumni_profiles
         (user_id, verification_id, name, phone, province, city, county, current_province, current_city, current_county,
          graduation_year, class_name, homeroom_teacher)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (user_id) do update set
          verification_id=excluded.verification_id, name=excluded.name, province=excluded.province, city=excluded.city, county=excluded.county,
          current_province=excluded.current_province, current_city=excluded.current_city, current_county=excluded.current_county,
          graduation_year=excluded.graduation_year, class_name=excluded.class_name, homeroom_teacher=excluded.homeroom_teacher,
          status='active', updated_at=now()`,
        [userId, v.id, v.name, v.phone, v.province, v.city, v.county, v.current_province, v.current_city, v.current_county, v.graduation_year, v.class_name, v.homeroom_teacher]
      );
    }

    await audit(req, `alumni_verification_${status}`, 'alumni_verification', id, { rejectReason });
    return ok(res, { application: updated.rows[0], verification: updated.rows[0] });
  } catch (e) {
    console.error(e);
    return fail(res, 500, '审核失败', { error: e.message });
  }
});

// 校友通讯录：已认证校友和管理员可看
app.get('/api/alumni/directory', requireAuth, async (req, res) => {
  try {
    if (!['alumni', 'admin', 'super_admin'].includes(req.user.role)) return fail(res, 403, '完成校友认证后才可查看通讯录');
    const { province, city, county, year, q } = req.query;
    const params = [];
    const wheres = [`status='active'`];
    if (province) { params.push(province); wheres.push(`province=$${params.length}`); }
    if (city) { params.push(city); wheres.push(`city=$${params.length}`); }
    if (county) { params.push(county); wheres.push(`county=$${params.length}`); }
    if (year) { params.push(Number(year)); wheres.push(`graduation_year=$${params.length}`); }
    if (q) { params.push(`%${q}%`); wheres.push(`(name ilike $${params.length} or class_name ilike $${params.length} or company ilike $${params.length})`); }
    const r = await dbQuery(
      `select id,name,province,city,county,current_province,current_city,current_county,graduation_year,class_name,industry,company,position_title,
              case when public_contact then phone else null end as phone
       from public.alumni_profiles
       where ${wheres.join(' and ')}
       order by graduation_year desc nulls last, name asc
       limit 500`,
      params
    );
    return ok(res, { alumni: r.rows });
  } catch (e) {
    return fail(res, 500, '获取校友通讯录失败', { error: e.message });
  }
});

// 官网内容公开读取
app.get('/api/site/pages', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  try {
    const r = await dbQuery(`select * from public.site_pages where is_public=true order by sort_order asc, created_at asc`);
    return ok(res, { pages: r.rows });
  } catch (e) {
    return fail(res, 500, '获取页面失败', { error: e.message });
  }
});

app.get('/api/site/sections', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  try {
    const page = req.query.page;
    const params = [];
    let where = '';
    if (page) { params.push(page); where = 'where page_slug=$1'; }
    const r = await dbQuery(`select * from public.site_sections ${where} order by display_order asc, created_at asc`, params);
    return ok(res, { sections: r.rows });
  } catch (e) {
    return fail(res, 500, '获取内容区块失败', { error: e.message });
  }
});


// 官网页面完整读取，例如 /api/site/home
app.get('/api/site/:slug', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  try {
    const { slug } = req.params;
    const pageResult = await dbQuery(
      `select slug, title, description, current_content, sort_order
       from public.site_pages
       where slug=$1 and is_public=true
       limit 1`,
      [slug]
    );
    if (!pageResult.rows[0]) return fail(res, 404, '页面不存在');

    const sectionsResult = await dbQuery(
      `select section_key, section_name, content, display_order
       from public.site_sections
       where page_slug=$1
       order by display_order asc, created_at asc`,
      [slug]
    );

    return ok(res, {
      page: pageResult.rows[0],
      sections: sectionsResult.rows
    });
  } catch (e) {
    return fail(res, 500, '获取页面内容失败', { error: e.message });
  }
});

// 管理员编辑内容：主管理员直接发布，普通管理员提交审批
app.post('/api/admin/content/sections', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { page_slug, section_key, section_name, content, display_order } = req.body || {};
    if (!page_slug || !section_key || !section_name) return fail(res, 400, '页面、区块标识、区块名称不能为空');

    if (req.user.role === 'super_admin') {
      const r = await dbQuery(
        `insert into public.site_sections (page_slug, section_key, section_name, content, display_order)
         values ($1,$2,$3,$4,$5)
         on conflict (section_key) do update set page_slug=excluded.page_slug, section_name=excluded.section_name, content=excluded.content, display_order=excluded.display_order, updated_at=now()
         returning *`,
        [page_slug, section_key, section_name, JSON.stringify(content || {}), display_order || 0]
      );
      await audit(req, 'content_publish_direct', 'site_section', r.rows[0].id, { section_key });
      return ok(res, { section: r.rows[0], message: '主管理员已直接发布' });
    }

    const r = await dbQuery(
      `insert into public.content_change_requests (target_type, page_slug, section_key, title, proposed_content, status, submitted_by_admin)
       values ('section',$1,$2,$3,$4,'pending',$5)
       returning *`,
      [page_slug, section_key, section_name, JSON.stringify({ page_slug, section_key, section_name, content: content || {}, display_order: display_order || 0 }), req.user.admin_id]
    );
    await audit(req, 'content_change_request_create', 'content_change_request', r.rows[0].id, { section_key });
    return ok(res, { request: r.rows[0], message: '已提交主管理员审批' });
  } catch (e) {
    return fail(res, 500, '提交内容修改失败', { error: e.message });
  }
});

app.get('/api/admin/content/requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(`select * from public.content_change_requests order by created_at desc limit 500`);
    return ok(res, { requests: r.rows });
  } catch (e) {
    return fail(res, 500, '获取内容审批列表失败', { error: e.message });
  }
});

app.patch('/api/admin/content/requests/:id/review', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body.status;
    const rejectReason = req.body.reject_reason || req.body.rejectReason || null;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, '审批状态不正确');

    const r = await dbQuery(
      `update public.content_change_requests
       set status=$1, reject_reason=$2, reviewed_by_admin=$3, reviewed_at=now(), updated_at=now()
       where id=$4
       returning *`,
      [status, rejectReason, req.user.admin_id, id]
    );
    const reqRow = r.rows[0];
    if (!reqRow) return fail(res, 404, '审批记录不存在');

    if (status === 'approved' && reqRow.target_type === 'section') {
      const p = typeof reqRow.proposed_content === 'string' ? JSON.parse(reqRow.proposed_content) : (reqRow.proposed_content || {});
      await dbQuery(
        `insert into public.site_sections (page_slug, section_key, section_name, content, display_order)
         values ($1,$2,$3,$4,$5)
         on conflict (section_key) do update set page_slug=excluded.page_slug, section_name=excluded.section_name, content=excluded.content, display_order=excluded.display_order, updated_at=now()`,
        [p.page_slug || reqRow.page_slug, p.section_key || reqRow.section_key, p.section_name || reqRow.title, JSON.stringify(p.content || {}), p.display_order || 0]
      );
    }
    await audit(req, `content_change_${status}`, 'content_change_request', id, { rejectReason });
    return ok(res, { request: reqRow });
  } catch (e) {
    return fail(res, 500, '内容审批失败', { error: e.message });
  }
});

// 管理员邀请和审批：免费版，不自动发邮件。后台生成邀请链接，复制给对方即可。
app.get('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(
      `select i.*, inviter.display_name as inviter_name, reviewer.display_name as reviewer_name
       from public.admin_invites i
       left join public.admin_accounts ia on ia.id=i.inviter_admin_id
       left join public.app_users inviter on inviter.id=ia.user_id
       left join public.admin_accounts ra on ra.id=i.approved_by
       left join public.app_users reviewer on reviewer.id=ra.user_id
       order by i.created_at desc limit 500`
    );
    const invites = r.rows.map(row => ({ ...row, invite_link: row.invite_code ? makeInviteLink(row.invite_code) : null }));
    return ok(res, { invites });
  } catch (e) {
    return fail(res, 500, '获取管理员邀请失败', { error: e.message });
  }
});

app.post('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const inviteeEmail = normalizeEmail(b.invitee_email || b.email);
    const inviteeName = String(b.invitee_name || b.name || '').trim();
    if (!inviteeEmail || !inviteeEmail.includes('@')) return fail(res, 400, '被邀请人邮箱不能为空');
    if (!inviteeName) return fail(res, 400, '被邀请人姓名不能为空');
    const code = makeInviteCode();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
    const permissions = normalizePermissions(b.permissions) || {};
    const r = await dbQuery(
      `insert into public.admin_invites
       (inviter_admin_id, invitee_email, invitee_phone, invitee_name, admin_level, title, department, permissions, invite_code, status, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'invited',$10)
       returning *`,
      [req.user.admin_id, inviteeEmail, b.invitee_phone || b.phone || null, inviteeName, b.admin_level || 'admin', b.title || null, b.department || null, JSON.stringify(permissions), code, expiresAt]
    );
    await audit(req, 'admin_invite_create', 'admin_invite', r.rows[0].id, { inviteeEmail });
    return ok(res, { invite: { ...r.rows[0], invite_link: makeInviteLink(code) }, message: '邀请已创建。复制邀请链接发给对方，免费，不需要短信或邮件服务。' });
  } catch (e) {
    return fail(res, 500, '创建管理员邀请失败', { error: e.message });
  }
});

app.get('/api/admin/invites/public/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const r = await dbQuery(
      `select id, invitee_email, invitee_phone, invitee_name, admin_level, title, department, status, expires_at
       from public.admin_invites where invite_code=$1 limit 1`,
      [code]
    );
    const invite = r.rows[0];
    if (!invite) return fail(res, 404, '邀请链接不存在');
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return fail(res, 410, '邀请链接已过期，请联系管理员重新邀请');
    if (!['invited', 'accepted'].includes(invite.status)) return fail(res, 400, '邀请状态不可用');
    return ok(res, { invite });
  } catch (e) {
    return fail(res, 500, '读取邀请失败', { error: e.message });
  }
});

app.post('/api/admin/invites/accept', async (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.code || b.token || '').trim();
    const password = requireStrongPassword(b.password);
    const email = normalizeEmail(b.email || b.invitee_email);
    const name = String(b.name || b.invitee_name || '').trim();
    if (!code) return fail(res, 400, '邀请码不能为空');
    const r = await dbQuery(`select * from public.admin_invites where invite_code=$1 limit 1`, [code]);
    const invite = r.rows[0];
    if (!invite) return fail(res, 404, '邀请链接不存在');
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return fail(res, 410, '邀请链接已过期');
    if (!['invited', 'accepted'].includes(invite.status)) return fail(res, 400, '邀请已处理，不能重复设置');
    if (email && normalizeEmail(invite.invitee_email) !== email) return fail(res, 400, '邮箱与邀请邮箱不一致');
    const passwordHash = await bcrypt.hash(password, 10);
    const personalInfo = {
      name: name || invite.invitee_name,
      email: invite.invitee_email,
      phone: b.phone || invite.invitee_phone || null,
      title: b.title || invite.title || null,
      department: b.department || invite.department || null,
      province: b.province || null,
      city: b.city || null,
      note: b.note || null,
    };
    const updated = await dbQuery(
      `update public.admin_invites
       set status='accepted', accepted_at=now(), accepted_password_hash=$1, personal_info=$2, invitee_phone=coalesce($3, invitee_phone), title=coalesce($4, title), department=coalesce($5, department), updated_at=now()
       where id=$6 returning id, invitee_email, invitee_name, status`,
      [passwordHash, JSON.stringify(personalInfo), personalInfo.phone, personalInfo.title, personalInfo.department, invite.id]
    );
    return ok(res, { invite: updated.rows[0], message: '资料和密码已提交，等待主管理员审批后即可登录后台。' });
  } catch (e) {
    return fail(res, 500, '接受邀请失败', { error: e.message });
  }
});

app.patch('/api/admin/invites/:id/review', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body.status;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, '审批状态不正确');
    const r0 = await dbQuery(`select * from public.admin_invites where id=$1 limit 1`, [id]);
    const invite = r0.rows[0];
    if (!invite) return fail(res, 404, '邀请不存在');
    if (status === 'approved' && !invite.accepted_password_hash) return fail(res, 400, '对方还没有通过邀请链接设置密码和个人资料');
    const info = typeof invite.personal_info === 'string' ? JSON.parse(invite.personal_info || '{}') : (invite.personal_info || {});

    if (status === 'approved') {
      const u = await dbQuery(
        `insert into public.app_users (email, phone, display_name, role, status, password_hash, is_email_verified)
         values ($1,$2,$3,'admin','active',$4,true)
         on conflict (email) do update set role='admin', status='active', display_name=excluded.display_name, phone=excluded.phone, password_hash=excluded.password_hash, updated_at=now()
         returning id`,
        [normalizeEmail(invite.invitee_email), info.phone || invite.invitee_phone || null, info.name || invite.invitee_name, invite.accepted_password_hash]
      );
      await dbQuery(
        `insert into public.admin_accounts (user_id, admin_level, status, invited_by, approved_by, approved_at, title, department, province, city, permissions, note)
         values ($1,$2,'approved',$3,$4,now(),$5,$6,$7,$8,$9,$10)
         on conflict (user_id) do update set admin_level=excluded.admin_level, status='approved', approved_by=$4, approved_at=now(), title=excluded.title, department=excluded.department, province=excluded.province, city=excluded.city, permissions=excluded.permissions, updated_at=now()`,
        [u.rows[0].id, invite.admin_level || 'admin', invite.inviter_admin_id, req.user.admin_id, info.title || invite.title || null, info.department || invite.department || null, info.province || null, info.city || null, JSON.stringify(normalizePermissions(invite.permissions)), info.note || '邀请审批通过']
      );
    }

    const r = await dbQuery(
      `update public.admin_invites set status=$1, approved_by=$2, approved_at=now(), reject_reason=$3, updated_at=now()
       where id=$4 returning *`,
      [status, req.user.admin_id, req.body.reject_reason || req.body.rejectReason || null, id]
    );
    await audit(req, `admin_invite_${status}`, 'admin_invite', id, {});
    return ok(res, { invite: { ...r.rows[0], invite_link: r.rows[0].invite_code ? makeInviteLink(r.rows[0].invite_code) : null }, message: status === 'approved' ? '管理员已批准启用' : '邀请已拒绝' });
  } catch (e) {
    return fail(res, 500, '管理员邀请审批失败', { error: e.message });
  }
});

// 地区数据接口，后面导入全国省市区县后可直接用
app.get('/api/regions', async (req, res) => {
  try {
    const parent = req.query.parent;
    const params = [];
    let where = '';
    if (parent) { params.push(parent); where = 'where parent_code=$1'; }
    const r = await dbQuery(`select code,name,level,parent_code from public.region_catalog ${where} order by code asc`, params);
    return ok(res, { regions: r.rows });
  } catch (e) {
    return fail(res, 500, '获取地区失败', { error: e.message });
  }
});

// 短信接口占位：正式接阿里云/腾讯云短信后启用
app.post('/api/sms/send', async (req, res) => {
  return fail(res, 501, '短信验证码服务尚未接入。下一期接入阿里云或腾讯云短信。');
});

app.use((req, res) => {
  fail(res, 404, '接口不存在');
});

ensureRootAdmin()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`hailin alumni backend running on http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('startup failed:', e);
    app.listen(PORT, () => {
      console.log(`hailin alumni backend running without database init on http://localhost:${PORT}`);
    });
  });
