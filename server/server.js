import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'dev-secret-change-me';
const DATA_FILE = path.resolve(__dirname, process.env.DATA_FILE || './data/applications.json');
// GitHub Pages + Render 跨域修复：允许所有来源访问此 API。
// 后台只靠管理员密码和 token 控制，CORS 不再卡前端请求。
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(cors({ origin: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '1mb' }));

async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]', 'utf8');
  }
}

async function readApplications() {
  await ensureDataFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeApplications(items) {
  await ensureDataFile();
  await fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    year: item.year,
    class_name: item.class_name,
    city: item.city,
    phone: item.phone,
    email: item.email,
    message: item.message,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

function createToken(username) {
  const payload = {
    username,
    exp: Date.now() + 1000 * 60 * 60 * 8
  };
  const payloadText = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadText).digest('base64url');
  return `${payloadText}.${signature}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payloadText, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadText).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ message: '登录已失效，请重新登录' });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ message: '登录已失效，请重新登录' });
  }
}

function cleanText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'hailin-alumni-backend', message: '海林市高级中学校友会后端接口运行中' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'hailin-alumni-backend', port: PORT });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'hailin-alumni-backend', port: PORT });
});

app.post('/api/applications', async (req, res) => {
  const body = req.body || {};
  const item = {
    id: crypto.randomUUID(),
    name: cleanText(body.name, 50),
    year: cleanText(body.year || body.graduation_year, 40),
    class_name: cleanText(body.class_name, 80),
    city: cleanText(body.city, 80),
    phone: cleanText(body.phone, 40),
    email: cleanText(body.email, 120),
    message: cleanText(body.message, 800),
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!item.name || !item.year || !item.phone) {
    return res.status(400).json({ message: '姓名、毕业届别、联系电话为必填项' });
  }

  const items = await readApplications();
  items.unshift(item);
  await writeApplications(items);
  res.status(201).json({ message: '提交成功，等待管理员审核', item: publicItem(item) });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    return res.json({ token: createToken(username), username });
  }
  return res.status(401).json({ message: '账号或密码错误' });
});

app.get('/api/admin/applications', requireAdmin, async (req, res) => {
  const items = await readApplications();
  res.json({ items: items.map(publicItem) });
});

app.patch('/api/admin/applications/:id/status', requireAdmin, async (req, res) => {
  const allowed = new Set(['pending', 'approved', 'rejected']);
  const status = cleanText(req.body?.status, 20);
  if (!allowed.has(status)) return res.status(400).json({ message: '状态不正确' });

  const items = await readApplications();
  const target = items.find(item => item.id === req.params.id);
  if (!target) return res.status(404).json({ message: '申请不存在' });

  target.status = status;
  target.updated_at = new Date().toISOString();
  await writeApplications(items);
  res.json({ message: '状态已更新', item: publicItem(target) });
});

app.use((req, res) => {
  res.status(404).json({ message: '接口不存在' });
});

app.listen(PORT, () => {
  console.log(`Hailin alumni backend is running on http://localhost:${PORT}`);
});
