const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
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

app.get(['/api/applications', '/api/admin/alumni/verifications'], requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `where status=$1`; }
    const r = await dbQuery(
      `select * from public.alumni_verifications ${where} order by created_at desc limit 500`,
      params
    );
    return ok(res, { applications: r.rows, verifications: r.rows });
  } catch (e) {
    return fail(res, 500, '获取认证列表失败', { error: e.message });
  }
});

app.patch(['/api/applications/:id/status', '/api/admin/alumni/verifications/:id/review'], requireAuth, requireAdmin, async (req, res) => {
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
  try {
    const r = await dbQuery(`select * from public.site_pages where is_public=true order by sort_order asc, created_at asc`);
    return ok(res, { pages: r.rows });
  } catch (e) {
    return fail(res, 500, '获取页面失败', { error: e.message });
  }
});

app.get('/api/site/sections', async (req, res) => {
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
      const p = reqRow.proposed_content || {};
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

// 管理员邀请和审批
app.get('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(`select * from public.admin_invites order by created_at desc limit 500`);
    return ok(res, { invites: r.rows });
  } catch (e) {
    return fail(res, 500, '获取管理员邀请失败', { error: e.message });
  }
});

app.post('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { invitee_phone, invitee_name, invitee_email } = req.body || {};
    if (!invitee_phone || !invitee_name) return fail(res, 400, '被邀请人姓名和手机号不能为空');
    const r = await dbQuery(
      `insert into public.admin_invites (inviter_admin_id, invitee_phone, invitee_name, invitee_email, status)
       values ($1,$2,$3,$4,'pending') returning *`,
      [req.user.admin_id, invitee_phone, invitee_name, invitee_email || null]
    );
    await dbQuery(
      `insert into public.admin_approval_tasks (task_type, status, requested_by_admin, target_table, target_id, payload)
       values ('admin_invite','pending',$1,'admin_invites',$2,$3)`,
      [req.user.admin_id, r.rows[0].id, JSON.stringify(r.rows[0])]
    );
    await audit(req, 'admin_invite_create', 'admin_invite', r.rows[0].id, {});
    return ok(res, { invite: r.rows[0], message: '管理员邀请已提交，等待主管理员审批' });
  } catch (e) {
    return fail(res, 500, '创建管理员邀请失败', { error: e.message });
  }
});

app.patch('/api/admin/invites/:id/review', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const status = req.body.status;
    if (!['approved', 'rejected'].includes(status)) return fail(res, 400, '审批状态不正确');
    const r = await dbQuery(
      `update public.admin_invites set status=$1, approved_by=$2, approved_at=now(), updated_at=now()
       where id=$3 returning *`,
      [status, req.user.admin_id, id]
    );
    const invite = r.rows[0];
    if (!invite) return fail(res, 404, '邀请不存在');

    if (status === 'approved') {
      const u = await dbQuery(
        `insert into public.app_users (phone, email, display_name, role, status, is_phone_verified)
         values ($1,$2,$3,'admin','active',false)
         on conflict (phone) do update set role='admin', status='active', display_name=excluded.display_name, email=excluded.email, updated_at=now()
         returning id`,
        [invite.invitee_phone, invite.invitee_email || null, invite.invitee_name]
      );
      await dbQuery(
        `insert into public.admin_accounts (user_id, admin_level, status, invited_by, approved_by, approved_at, note)
         values ($1,'admin','approved',$2,$3,now(),'主管理员审批通过')
         on conflict (user_id) do update set status='approved', approved_by=$3, approved_at=now(), updated_at=now()`,
        [u.rows[0].id, invite.inviter_admin_id, req.user.admin_id]
      );
    }
    await audit(req, `admin_invite_${status}`, 'admin_invite', id, {});
    return ok(res, { invite });
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
