const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_jwt_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const TONGYI_API_KEY = process.env.TONGYI_API_KEY || '';
const TONGYI_BASE_URL = (process.env.TONGYI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const TONGYI_MODELS = (process.env.TONGYI_MODELS || 'qwen3.6-max-preview,Qwen3.6-Plus')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const TONGYI_MODEL = process.env.TONGYI_MODEL || TONGYI_MODELS[0] || 'qwen3.6-max-preview';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 120000);
const MODEL_ALIASES = {
  'Qwen3.6-Plus': 'qwen3.6-plus',
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_CATEGORIES = [
  '写作创作', '编程开发', '图像绘画', '视频脚本', '商业营销', '办公效率',
  '学习教育', '数据分析', '产品设计', '角色扮演', '自动化工作流', '客服话术',
  '法律合同', '简历求职', '错误提示词', '待人工确认'
];

function id() {
  return crypto.randomUUID();
}

function nowSql() {
  return new Date().toISOString();
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function safeUser(row) {
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url || null };
}

function normalizeDomain(url) {
  try {
    if (!url) return null;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return null;
  }
}

function makeTitle(content) {
  const clean = String(content || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名提示词';
  return clean.slice(0, 20);
}

function normalizeForSimilarity(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, '')
    .replace(/[，。！？、；：“”"'`~!@#$%^&*()_+\-=[\]{}|\\;:,.<>/?]/g, '')
    .slice(0, 6000);
}

function diceSimilarity(a, b) {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < left.length - 1; i++) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const gram = right.slice(i, i + 2);
    const count = grams.get(gram) || 0;
    if (count > 0) {
      overlap++;
      grams.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

async function findSimilarPrompts(userId, content) {
  const normalized = normalizeForSimilarity(content);
  if (normalized.length < 12) return [];
  const result = await pool.query(
    `SELECT p.id, p.title, p.content, p.summary, p.source_domain, p.created_at, c.name AS category_name
     FROM prompts p
     LEFT JOIN categories c ON c.id=p.category_id
     WHERE p.user_id=$1 AND p.deleted_at IS NULL
     ORDER BY p.created_at DESC
     LIMIT 300`,
    [userId]
  );
  return result.rows
    .map((row) => ({ row, similarity: diceSimilarity(content, row.content) }))
    .filter((item) => item.similarity >= 0.82)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map((item) => ({
      id: item.row.id,
      title: item.row.title,
      summary: item.row.summary,
      categoryName: item.row.category_name,
      sourceDomain: item.row.source_domain,
      createdAt: item.row.created_at,
      similarity: Number(item.similarity.toFixed(3)),
    }));
}

async function initDb() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      name varchar(120) NOT NULL,
      avatar_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id uuid PRIMARY KEY,
      user_id uuid NULL,
      team_id uuid NULL,
      name varchar(120) NOT NULL,
      description text,
      sort_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id uuid NULL,
      title varchar(255) NOT NULL,
      content text NOT NULL,
      summary text,
      markdown_doc text,
      ai_model varchar(120),
      category_id uuid NULL REFERENCES categories(id) ON DELETE SET NULL,
      source_title varchar(255),
      source_url text,
      source_domain varchar(255),
      ai_status varchar(40) NOT NULL DEFAULT 'pending',
      ai_confidence numeric(4,3),
      is_favorite boolean NOT NULL DEFAULT false,
      is_manual_confirmed boolean NOT NULL DEFAULT false,
      visibility varchar(40) NOT NULL DEFAULT 'private',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id uuid PRIMARY KEY,
      user_id uuid NULL,
      team_id uuid NULL,
      name varchar(120) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS prompt_tags (
      prompt_id uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (prompt_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id uuid PRIMARY KEY,
      prompt_id uuid NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      title varchar(255) NOT NULL,
      content text NOT NULL,
      summary text,
      markdown_doc text,
      category_id uuid NULL,
      changed_by uuid NOT NULL,
      change_note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_prompts_user ON prompts(user_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_source_domain ON prompts(source_domain);
    CREATE INDEX IF NOT EXISTS idx_prompts_ai_status ON prompts(ai_status);
    CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at);
  `);

  await pool.query(`
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS markdown_doc text;
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS ai_model varchar(120);
    ALTER TABLE prompt_versions ADD COLUMN IF NOT EXISTS markdown_doc text;
  `);

  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    await pool.query(
      `INSERT INTO categories (id, user_id, name, sort_order)
       SELECT $1::uuid, NULL, $2::varchar, $3::int
       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND name = $2::varchar)`,
      [id(), DEFAULT_CATEGORIES[i], i + 1]
    );
  }
}

async function findCategoryByName(name) {
  const result = await pool.query('SELECT * FROM categories WHERE user_id IS NULL AND name=$1 LIMIT 1', [name]);
  if (result.rows[0]) return result.rows[0];
  const created = await pool.query(
    'INSERT INTO categories (id, user_id, name, sort_order) VALUES ($1, NULL, $2, 999) RETURNING *',
    [id(), name]
  );
  return created.rows[0];
}

async function setPromptTags(promptId, userId, tagNames) {
  const names = [...new Set((tagNames || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  await pool.query('DELETE FROM prompt_tags WHERE prompt_id=$1', [promptId]);
  for (const name of names) {
    let tag = await pool.query('SELECT * FROM tags WHERE user_id=$1 AND name=$2 LIMIT 1', [userId, name]);
    if (!tag.rows[0]) {
      tag = await pool.query('INSERT INTO tags (id, user_id, name) VALUES ($1, $2, $3) RETURNING *', [id(), userId, name]);
    }
    await pool.query('INSERT INTO prompt_tags (prompt_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [promptId, tag.rows[0].id]);
  }
}

async function getTagsForPrompt(promptId) {
  const result = await pool.query(
    `SELECT t.name FROM tags t JOIN prompt_tags pt ON pt.tag_id=t.id WHERE pt.prompt_id=$1 ORDER BY t.name`,
    [promptId]
  );
  return result.rows.map((r) => r.name);
}

function heuristicAnalyze(content) {
  const text = String(content || '');
  const lower = text.toLowerCase();
  const rules = [
    ['错误提示词', ['error', 'exception', 'traceback', 'stack trace', '404', '500', '报错', '错误', 'undefined', 'null pointer']],
    ['编程开发', ['代码', 'bug', 'api', '函数', '数据库', 'typescript', 'python', 'javascript', 'react', 'sql']],
    ['图像绘画', ['midjourney', 'stable diffusion', '图片', '绘画', '海报', '摄影', '插画']],
    ['商业营销', ['小红书', '营销', '广告', '转化', '销售', '爆款', '标题', '文案']],
    ['视频脚本', ['视频', '脚本', '分镜', '口播', '剪辑']],
    ['办公效率', ['邮件', '会议', '总结', '表格', '汇报', 'ppt']],
    ['学习教育', ['学习', '课程', '教学', '考试', '知识点']],
    ['数据分析', ['数据', '分析', '报表', '指标', '可视化']],
    ['产品设计', ['产品', '需求', 'prd', '用户体验', '原型']],
    ['法律合同', ['合同', '法律', '条款', '协议']],
    ['简历求职', ['简历', '面试', '求职', '岗位']],
    ['客服话术', ['客服', '话术', '用户投诉', '售后']],
    ['角色扮演', ['扮演', '角色', '你是一个']],
  ];
  let category = '写作创作';
  let confidence = 0.58;
  for (const [name, keywords] of rules) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) {
      category = name;
      confidence = 0.72;
      break;
    }
  }
  const title = makeTitle(text);
  const rawTags = [category, ...text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,10}/g)?.slice(0, 8) || []];
  const tags = [...new Set(rawTags)].slice(0, 6);
  return {
    title,
    category,
    tags,
    summary: `用于${category}场景的提示词，可在保存后继续人工优化分类、标题和标签。`,
    markdownDoc: `# ${title}\n\n## 用途\n用于${category}场景的提示词，可帮助用户快速复用和优化工作流程。\n\n## 适用场景\n- ${category}\n- AI 辅助创作\n- 日常工作沉淀\n\n## 原始提示词\n${text}\n\n## 标签\n${tags.join('、')}\n\n## 整理方式\n当前由本地规则自动整理。配置通义 API Key 后，可升级为通义自动生成更完整的 Markdown 文档。`,
    confidence,
  };
}

function extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('AI response is not valid JSON');
}

function pickAiModel(model) {
  const requested = String(model || '').trim();
  const normalized = MODEL_ALIASES[requested] || requested;
  const normalizedDefault = MODEL_ALIASES[TONGYI_MODEL] || TONGYI_MODEL;
  const normalizedModels = TONGYI_MODELS.map((item) => MODEL_ALIASES[item] || item);
  return normalizedModels.includes(normalized) ? normalized : normalizedDefault;
}

async function analyzePrompt(content, model) {
  const selectedModel = pickAiModel(model);
  if (!TONGYI_API_KEY) return heuristicAnalyze(content);
  const system = `你是一个提示词知识库整理助手。请根据用户提供的提示词内容，生成结构化 JSON。要求：title 是提示词的精髓标题，限制 6 到 20 个中文字符；category 从给定分类中选择最合适的一个；tags 生成 3 到 8 个；summary 用 1 到 2 句话说明用途；markdownDoc 生成一份 Markdown 知识卡片，包含 # 标题、## 用途、## 适用场景、## 原始提示词、## 使用方法、## 标签、## 来源说明；confidence 返回 0 到 1。如果内容明显不是可复用提示词，例如误选文本、乱码、错误日志、网页碎片、无意义片段、异常报错内容，category 使用“错误提示词”；如果只是无法判断分类，category 使用“待人工确认”，confidence 低于 0.5。只返回 JSON。分类：${DEFAULT_CATEGORIES.join('、')}`;
  const fallbackModels = ['qwen3.6-plus'];
  const modelsToTry = [...new Set([selectedModel, ...TONGYI_MODELS.map((item) => MODEL_ALIASES[item] || item), ...fallbackModels].filter(Boolean))];
  let response;
  let usedModel = selectedModel;
  let lastError;
  for (const candidateModel of modelsToTry) {
    try {
      response = await axios.post(`${TONGYI_BASE_URL}/chat/completions`, {
        model: candidateModel,
        messages: [
          { role: 'system', content: system },
        { role: 'user', content: String(content).slice(0, 16000) }
      ],
      temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 3000
      }, {
        headers: { Authorization: `Bearer ${TONGYI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: AI_TIMEOUT_MS,
      });
      usedModel = candidateModel;
      break;
    } catch (error) {
      lastError = error;
      const message = error.response?.data?.error?.message || '';
      const invalidModel = error.response?.status === 400 && /model .*not supported/i.test(message);
      if (!invalidModel) throw error;
    }
  }
  if (!response) throw lastError || new Error('AI model request failed');
  const parsed = extractJson(response.data.choices?.[0]?.message?.content || '{}');
  return {
    title: String(parsed.title || makeTitle(content)).slice(0, 80),
    category: DEFAULT_CATEGORIES.includes(parsed.category) ? parsed.category : '待人工确认',
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 8) : [],
    summary: String(parsed.summary || '').slice(0, 500),
    markdownDoc: String(parsed.markdownDoc || parsed.markdown_doc || '').slice(0, 8000),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.5))),
    usedModel,
  };
}

async function applyAnalysis(promptId, userId, content, model) {
  const selectedModel = pickAiModel(model);
  try {
    const analysis = await analyzePrompt(content, selectedModel);
    const confidence = Number(analysis.confidence || 0);
    const categoryName = confidence < 0.5 ? '待人工确认' : analysis.category;
    const category = await findCategoryByName(categoryName);
    await pool.query(
      `UPDATE prompts SET title=$1, summary=$2, markdown_doc=$3, category_id=$4, ai_status=$5, ai_confidence=$6, ai_model=$7, updated_at=now()
       WHERE id=$8 AND user_id=$9`,
      [analysis.title || makeTitle(content), analysis.summary || '', analysis.markdownDoc || '', category.id, confidence < 0.5 ? 'need_review' : 'completed', confidence, analysis.usedModel || selectedModel, promptId, userId]
    );
    await setPromptTags(promptId, userId, analysis.tags || []);
  } catch (error) {
    console.error('AI analyze failed:', error.response?.data || error.message);
    const category = await findCategoryByName('待人工确认');
    await pool.query(
      `UPDATE prompts SET category_id=$1, ai_status='failed', ai_confidence=0, ai_model=$2, updated_at=now() WHERE id=$3 AND user_id=$4`,
      [category.id, selectedModel, promptId, userId]
    );
  }
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: '登录已过期，请重新登录' } });
  }
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ success: true, data: { status: 'ok', time: new Date().toISOString(), ai: TONGYI_API_KEY ? 'tongyi' : 'heuristic', aiBaseUrl: TONGYI_BASE_URL, aiModels: TONGYI_MODELS, defaultAiModel: TONGYI_MODEL } });
}));

app.get('/api/ai/models', authRequired, asyncRoute(async (req, res) => {
  res.json({ success: true, data: { models: TONGYI_MODELS, defaultModel: TONGYI_MODEL, enabled: Boolean(TONGYI_API_KEY) } });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || email.split('@')[0] || '用户').trim();
  if (!email || !email.includes('@')) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '请输入有效邮箱' } });
  if (password.length < 8) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '密码至少 8 位' } });
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await pool.query(
      'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING *',
      [id(), email, passwordHash, name]
    );
    const user = safeUser(result.rows[0]);
    res.json({ success: true, data: { user, accessToken: signToken(user) } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: { code: 'EMAIL_EXISTS', message: '邮箱已注册' } });
    throw error;
  }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await pool.query('SELECT * FROM users WHERE email=$1 LIMIT 1', [email]);
  const row = result.rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' } });
  }
  const user = safeUser(row);
  res.json({ success: true, data: { user, accessToken: signToken(user) } });
}));

app.get('/api/auth/me', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.sub]);
  res.json({ success: true, data: safeUser(result.rows[0]) });
}));

app.get('/api/categories', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, COUNT(p.id)::int AS prompt_count
     FROM categories c
     LEFT JOIN prompts p ON p.category_id=c.id AND p.user_id=$1 AND p.deleted_at IS NULL
     WHERE c.user_id IS NULL OR c.user_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC, c.name ASC`,
    [req.user.sub]
  );
  res.json({ success: true, data: result.rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, promptCount: r.prompt_count })) });
}));

app.get('/api/prompts', authRequired, asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
  const where = ['p.user_id=$1', 'p.deleted_at IS NULL'];
  const params = [req.user.sub];
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.content ILIKE $${params.length} OR p.summary ILIKE $${params.length} OR p.source_domain ILIKE $${params.length})`);
  }
  if (req.query.categoryId) { params.push(req.query.categoryId); where.push(`p.category_id=$${params.length}`); }
  if (req.query.sourceDomain) { params.push(req.query.sourceDomain); where.push(`p.source_domain=$${params.length}`); }
  if (req.query.favorite === 'true') where.push('p.is_favorite=true');
  if (req.query.aiStatus) { params.push(req.query.aiStatus); where.push(`p.ai_status=$${params.length}`); }
  const whereSql = where.join(' AND ');
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM prompts p WHERE ${whereSql}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(
    `SELECT p.*, c.name AS category_name,
      COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
     FROM prompts p
     LEFT JOIN categories c ON c.id=p.category_id
     LEFT JOIN prompt_tags pt ON pt.prompt_id=p.id
     LEFT JOIN tags t ON t.id=pt.tag_id
     WHERE ${whereSql}
     GROUP BY p.id, c.name
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ success: true, data: { items: result.rows.map(promptRow), total: count.rows[0].total, page, pageSize } });
}));

function promptRow(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    summary: r.summary,
    markdownDoc: r.markdown_doc,
    category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
    tags: r.tags || [],
    sourceTitle: r.source_title,
    sourceUrl: r.source_url,
    sourceDomain: r.source_domain,
    aiStatus: r.ai_status,
    aiConfidence: r.ai_confidence === null ? null : Number(r.ai_confidence),
    aiModel: r.ai_model,
    isFavorite: r.is_favorite,
    isManualConfirmed: r.is_manual_confirmed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.get('/api/prompts/:id', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`,
    [req.params.id, req.user.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const data = promptRow({ ...result.rows[0], tags: await getTagsForPrompt(req.params.id) });
  res.json({ success: true, data });
}));

async function createPrompt(userId, body) {
  const content = String(body.content || '').trim();
  if (!content) throw Object.assign(new Error('提示词内容不能为空'), { status: 400, code: 'VALIDATION_ERROR' });
  if (!body.forceSave) {
    const similarPrompts = await findSimilarPrompts(userId, content);
    if (similarPrompts.length) {
      const error = new Error('已经保存过类似提示词');
      error.status = 409;
      error.code = 'DUPLICATE_PROMPT';
      error.details = { matches: similarPrompts };
      throw error;
    }
  }
  const promptId = id();
  const sourceUrl = body.sourceUrl || null;
  const sourceDomain = body.sourceDomain || normalizeDomain(sourceUrl);
  const result = await pool.query(
    `INSERT INTO prompts (id, user_id, title, content, source_title, source_url, source_domain, ai_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [promptId, userId, makeTitle(content), content, body.sourceTitle || null, sourceUrl, sourceDomain, body.autoAnalyze === false ? 'completed' : 'pending']
  );
  if (body.autoAnalyze !== false) await applyAnalysis(promptId, userId, content, body.aiModel);
  const detail = await pool.query(
    `SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1`,
    [promptId]
  );
  return promptRow({ ...detail.rows[0], tags: await getTagsForPrompt(promptId) });
}

app.post('/api/prompts', authRequired, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await createPrompt(req.user.sub, req.body) });
}));

app.post('/api/extension/save-selection', authRequired, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await createPrompt(req.user.sub, req.body) });
}));

app.patch('/api/prompts/:id', authRequired, asyncRoute(async (req, res) => {
  const existing = await pool.query('SELECT * FROM prompts WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.sub]);
  if (!existing.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const old = existing.rows[0];
  await pool.query(
    `INSERT INTO prompt_versions (id, prompt_id, title, content, summary, markdown_doc, category_id, changed_by, change_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id(), old.id, old.title, old.content, old.summary, old.markdown_doc, old.category_id, req.user.sub, req.body.changeNote || null]
  );
  await pool.query(
    `UPDATE prompts SET title=$1, content=$2, summary=$3, markdown_doc=$4, category_id=$5, is_manual_confirmed=$6, updated_at=now() WHERE id=$7 AND user_id=$8`,
    [req.body.title || old.title, req.body.content || old.content, req.body.summary ?? old.summary, req.body.markdownDoc ?? old.markdown_doc, req.body.categoryId || old.category_id, Boolean(req.body.isManualConfirmed ?? old.is_manual_confirmed), req.params.id, req.user.sub]
  );
  if (Array.isArray(req.body.tagNames)) await setPromptTags(req.params.id, req.user.sub, req.body.tagNames);
  const detail = await pool.query('SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1', [req.params.id]);
  res.json({ success: true, data: promptRow({ ...detail.rows[0], tags: await getTagsForPrompt(req.params.id) }) });
}));

app.delete('/api/prompts/:id', authRequired, asyncRoute(async (req, res) => {
  await pool.query('UPDATE prompts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  res.json({ success: true, data: { deleted: true } });
}));

app.post('/api/prompts/:id/favorite', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query('UPDATE prompts SET is_favorite=$1, updated_at=now() WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL RETURNING is_favorite', [Boolean(req.body.isFavorite), req.params.id, req.user.sub]);
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  res.json({ success: true, data: { isFavorite: result.rows[0].is_favorite } });
}));

app.post('/api/prompts/:id/confirm', authRequired, asyncRoute(async (req, res) => {
  await pool.query('UPDATE prompts SET category_id=$1, is_manual_confirmed=true, ai_status=$2, updated_at=now() WHERE id=$3 AND user_id=$4', [req.body.categoryId || null, 'completed', req.params.id, req.user.sub]);
  if (Array.isArray(req.body.tagNames)) await setPromptTags(req.params.id, req.user.sub, req.body.tagNames);
  res.json({ success: true, data: { isManualConfirmed: true, aiStatus: 'completed' } });
}));

app.post('/api/prompts/:id/reanalyze', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM prompts WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.sub]);
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  await applyAnalysis(req.params.id, req.user.sub, result.rows[0].content, req.body.aiModel);
  const detail = await pool.query('SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1', [req.params.id]);
  res.json({ success: true, data: promptRow({ ...detail.rows[0], tags: await getTagsForPrompt(req.params.id) }) });
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ success: false, error: { code: err.code || 'INTERNAL_ERROR', message: status === 500 ? '服务器错误' : err.message, details: err.details || null } });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Prompt Vault listening on ${PORT}`));
}).catch((error) => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
