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

const CONTENT_TYPES = ['prompt', 'inspiration', 'web_excerpt', 'review', 'error'];
const CONTENT_TYPE_LABELS = {
  prompt: '提示词',
  inspiration: '灵感记录',
  web_excerpt: '网页摘录',
  review: '待审阅资料',
  error: '错误内容',
};

function normalizeContentType(value) {
  const type = String(value || '').trim();
  return CONTENT_TYPES.includes(type) ? type : 'prompt';
}

function looksInvalidContent(content) {
  const text = String(content || '').trim();
  if (!text) return true;
  const lower = text.toLowerCase();
  const errorSignals = ['traceback', 'stack trace', 'exception', 'syntaxerror', 'typeerror', 'referenceerror', '404', '500', 'undefined', 'null pointer', '报错', '错误日志'];
  const hasErrorSignal = errorSignals.some((item) => lower.includes(item));
  const readableChars = (text.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).length;
  const readableRatio = readableChars / Math.max(1, text.length);
  return hasErrorSignal || readableRatio < 0.35 || (text.length < 8 && readableRatio < 0.8);
}

function inferContentTypeFromText(content) {
  const text = String(content || '').trim();
  const lower = text.toLowerCase();
  if (looksInvalidContent(text)) return 'error';
  const promptSignals = ['你是', '请帮我', '请你', '生成', '输出', '扮演', '要求', 'act as', 'write a', 'create a', 'prompt'];
  const ideaSignals = ['灵感', '想法', '备忘', '计划', 'todo', 'idea', 'note to self'];
  const excerptSignals = ['网页摘录', '文章摘录', 'web excerpt', 'excerpt:', 'source:', '原文', '资料'];
  if (ideaSignals.some((item) => lower.includes(item))) return 'inspiration';
  if (excerptSignals.some((item) => lower.includes(item))) return 'web_excerpt';
  if (promptSignals.some((item) => lower.includes(item))) return 'prompt';
  if (text.length > 120) return 'web_excerpt';
  return 'review';
}

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
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
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
      content_type varchar(40) NOT NULL DEFAULT 'prompt',
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
      usage_count int NOT NULL DEFAULT 0,
      last_used_at timestamptz NULL,
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
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS content_type varchar(40) NOT NULL DEFAULT 'prompt';
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS usage_count int NOT NULL DEFAULT 0;
    ALTER TABLE prompts ADD COLUMN IF NOT EXISTS last_used_at timestamptz NULL;
    ALTER TABLE prompt_versions ADD COLUMN IF NOT EXISTS markdown_doc text;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prompts_content_type ON prompts(content_type);
    CREATE INDEX IF NOT EXISTS idx_prompts_last_used_at ON prompts(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_prompts_usage_count ON prompts(usage_count);
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

async function findOrCreateUserCategory(userId, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw Object.assign(new Error('分类名称不能为空'), { status: 400, code: 'VALIDATION_ERROR' });
  const existing = await pool.query(
    `SELECT * FROM categories WHERE (user_id=$1 OR user_id IS NULL) AND name=$2 ORDER BY user_id NULLS FIRST LIMIT 1`,
    [userId, clean]
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await pool.query(
    `INSERT INTO categories (id, user_id, name, description, sort_order)
     VALUES ($1, $2, $3, $4, 900) RETURNING *`,
    [id(), userId, clean, '用户自定义分类']
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
  const inferredType = inferContentTypeFromText(text);
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
  if (category === '错误提示词' && !looksInvalidContent(text)) category = '待人工确认';
  const title = makeTitle(text);
  const rawTags = [category, ...text.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,10}/g)?.slice(0, 8) || []];
  const tags = [...new Set(rawTags)].slice(0, 6);
  let contentType = inferredType;
  if (category === '错误提示词') contentType = 'error';
  const typeLabel = CONTENT_TYPE_LABELS[contentType] || '提示词';
  const md = contentType === 'prompt'
    ? `# ${title}\n\n## 用途\n用于${category}场景的提示词，可帮助用户快速复用和优化工作流程。\n\n## 适用场景\n- ${category}\n- AI 辅助创作\n- 日常工作沉淀\n\n## 原始提示词\n${text}\n\n## 标签\n${tags.join('、')}\n\n## 整理方式\n当前由本地规则自动整理。配置通义 API Key 后，可升级为通义自动生成更完整的 Markdown 文档。`
    : `# ${title}\n\n## 内容类型\n${typeLabel}\n\n## 核心摘要\n${text.slice(0, 180)}${text.length > 180 ? '...' : ''}\n\n## 关键信息\n- 可作为后续查看、审阅和整理的资料\n- 可继续人工补充分类、标签和备注\n\n## 原文\n${text}\n\n## 标签\n${tags.join('、')}`;
  return {
    title,
    category,
    contentType,
    tags,
    summary: contentType === 'prompt' ? `用于${category}场景的提示词，可在保存后继续人工优化分类、标题和标签。` : `这是一条${typeLabel}，已整理为便于后续查看和审阅的资料卡片。`,
    markdownDoc: md,
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
  const system = `你是一个个人知识库整理助手。请根据用户提供的内容，生成结构化 JSON。要求：
1. title 是内容精髓标题，限制 6 到 24 个中文字符。
2. contentType 必须从 prompt、inspiration、web_excerpt、review、error 中选择：prompt=可复用提示词；inspiration=想法/备忘/灵感；web_excerpt=网页摘录/文章段落/资料；review=需要后续审阅但暂不确定价值的资料；error=误选文本、乱码、错误日志、异常报错或无意义片段。
正常网页摘录、文章段落、学习资料、产品资料、待审阅文字，即使不是提示词，也不能归为 error，应优先归为 web_excerpt 或 review。
3. category 从给定分类中选择最合适的一个；如果 contentType 是 error，category 使用“错误提示词”；如果无法判断，category 使用“待人工确认”。
4. tags 生成 3 到 8 个。
5. summary 用 1 到 2 句话说明内容价值或用途。
6. markdownDoc 生成一份 Markdown 知识卡片。如果 contentType=prompt，包含 # 标题、## 用途、## 适用场景、## 原始提示词、## 使用方法、## 标签、## 来源说明。如果不是提示词，包含 # 标题、## 内容类型、## 核心摘要、## 关键信息、## 可用于、## 原文、## 后续审阅建议、## 标签。
7. confidence 返回 0 到 1。
只返回 JSON。分类：${DEFAULT_CATEGORIES.join('、')}`;
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
  let contentType = normalizeContentType(parsed.contentType || parsed.content_type);
  if (contentType === 'error' && !looksInvalidContent(content)) contentType = 'web_excerpt';
  const inferredType = inferContentTypeFromText(content);
  if (contentType === 'prompt' && inferredType !== 'prompt' && inferredType !== 'error') contentType = inferredType;
  return {
    title: String(parsed.title || makeTitle(content)).slice(0, 80),
    contentType,
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
    const contentType = normalizeContentType(confidence < 0.5 ? 'review' : analysis.contentType);
    const categoryName = contentType === 'error' ? '错误提示词' : (confidence < 0.5 ? '待人工确认' : analysis.category);
    const category = await findCategoryByName(categoryName);
    await pool.query(
      `UPDATE prompts
       SET title=$1,
           content_type=CASE WHEN is_manual_confirmed THEN content_type ELSE $10 END,
           summary=$2,
           markdown_doc=$3,
           category_id=CASE WHEN is_manual_confirmed THEN category_id ELSE $4 END,
           ai_status=$5,
           ai_confidence=$6,
           ai_model=$7,
           updated_at=now()
       WHERE id=$8 AND user_id=$9`,
      [analysis.title || makeTitle(content), analysis.summary || '', analysis.markdownDoc || '', category.id, confidence < 0.5 ? 'need_review' : 'completed', confidence, analysis.usedModel || selectedModel, promptId, userId, contentType]
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
  res.json({ success: true, data: result.rows.map((r) => ({ id: r.id, name: r.name, description: r.description, sortOrder: r.sort_order, promptCount: r.prompt_count, isSystem: r.user_id === null })) });
}));

app.post('/api/categories', authRequired, asyncRoute(async (req, res) => {
  const category = await findOrCreateUserCategory(req.user.sub, req.body.name);
  res.json({ success: true, data: { id: category.id, name: category.name, description: category.description, sortOrder: category.sort_order, promptCount: 0, isSystem: category.user_id === null } });
}));

app.patch('/api/categories/:id', authRequired, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '分类名称不能为空' } });
  const result = await pool.query(
    `UPDATE categories SET name=$1, description=$2, updated_at=now()
     WHERE id=$3 AND user_id=$4
     RETURNING *`,
    [name, req.body.description || null, req.params.id, req.user.sub]
  );
  if (!result.rows[0]) return res.status(403).json({ success: false, error: { code: 'SYSTEM_CATEGORY_LOCKED', message: '系统分类不能改名，请新建自定义分类' } });
  res.json({ success: true, data: { id: result.rows[0].id, name: result.rows[0].name, description: result.rows[0].description, sortOrder: result.rows[0].sort_order, isSystem: false } });
}));

app.delete('/api/categories/:id', authRequired, asyncRoute(async (req, res) => {
  const category = await pool.query('SELECT * FROM categories WHERE id=$1 AND user_id=$2 LIMIT 1', [req.params.id, req.user.sub]);
  if (!category.rows[0]) return res.status(403).json({ success: false, error: { code: 'SYSTEM_CATEGORY_LOCKED', message: '系统分类不能删除' } });
  await pool.query('UPDATE prompts SET category_id=NULL, updated_at=now() WHERE category_id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  await pool.query('DELETE FROM categories WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
  res.json({ success: true, data: { deleted: true } });
}));

app.get('/api/prompts', authRequired, asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
  const q = String(req.query.q || '').trim();
  if (q && req.query.searchMode === 'semantic') {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name,
        COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
       FROM prompts p
       LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN prompt_tags pt ON pt.prompt_id=p.id
       LEFT JOIN tags t ON t.id=pt.tag_id
       WHERE p.user_id=$1 AND p.deleted_at IS NULL
       GROUP BY p.id, c.name
       ORDER BY p.updated_at DESC
       LIMIT 500`,
      [req.user.sub]
    );
    const ranked = result.rows
      .filter((row) => !req.query.contentType || normalizeContentType(row.content_type) === normalizeContentType(req.query.contentType))
      .filter((row) => req.query.favorite !== 'true' || row.is_favorite)
      .filter((row) => !req.query.aiStatus || row.ai_status === req.query.aiStatus)
      .map((row) => {
        const haystack = `${row.title || ''}\n${row.summary || ''}\n${row.content || ''}\n${row.markdown_doc || ''}\n${(row.tags || []).join(' ')}`;
        const score = Math.max(diceSimilarity(q, haystack), haystack.toLowerCase().includes(q.toLowerCase()) ? 0.5 : 0);
        return { row, score };
      })
      .filter((item) => item.score >= 0.08)
      .sort((a, b) => b.score - a.score)
      .map((item) => ({ ...promptRow(item.row), searchScore: Number(item.score.toFixed(3)) }));
    const start = (page - 1) * pageSize;
    return res.json({ success: true, data: { items: ranked.slice(start, start + pageSize), total: ranked.length, page, pageSize } });
  }
  const where = ['p.user_id=$1', 'p.deleted_at IS NULL'];
  const params = [req.user.sub];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.content ILIKE $${params.length} OR p.summary ILIKE $${params.length} OR p.source_domain ILIKE $${params.length})`);
  }
  if (req.query.categoryId) { params.push(req.query.categoryId); where.push(`p.category_id=$${params.length}`); }
  if (req.query.sourceDomain) { params.push(req.query.sourceDomain); where.push(`p.source_domain=$${params.length}`); }
  if (req.query.contentType) { params.push(normalizeContentType(req.query.contentType)); where.push(`p.content_type=$${params.length}`); }
  if (req.query.favorite === 'true') where.push('p.is_favorite=true');
  if (req.query.aiStatus) { params.push(req.query.aiStatus); where.push(`p.ai_status=$${params.length}`); }
  if (req.query.sort === 'recent_used') where.push('p.last_used_at IS NOT NULL');
  const whereSql = where.join(' AND ');
  const orderSql = req.query.sort === 'frequent'
    ? 'p.usage_count DESC, p.updated_at DESC'
    : req.query.sort === 'recent_used'
      ? 'p.last_used_at DESC, p.updated_at DESC'
      : 'p.created_at DESC';
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
     ORDER BY ${orderSql}
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
    contentType: normalizeContentType(r.content_type),
    contentTypeLabel: CONTENT_TYPE_LABELS[normalizeContentType(r.content_type)],
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
    usageCount: Number(r.usage_count || 0),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function getPromptWithTagsForUser(userId, promptId) {
  const result = await pool.query(
    `SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`,
    [promptId, userId]
  );
  if (!result.rows[0]) return null;
  return promptRow({ ...result.rows[0], tags: await getTagsForPrompt(promptId) });
}

async function listPromptsForExport(userId) {
  const result = await pool.query(
    `SELECT p.*, c.name AS category_name,
      COALESCE(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
     FROM prompts p
     LEFT JOIN categories c ON c.id=p.category_id
     LEFT JOIN prompt_tags pt ON pt.prompt_id=p.id
     LEFT JOIN tags t ON t.id=pt.tag_id
     WHERE p.user_id=$1 AND p.deleted_at IS NULL
     GROUP BY p.id, c.name
     ORDER BY p.created_at DESC`,
    [userId]
  );
  return result.rows.map(promptRow);
}

function promptsToMarkdown(prompts) {
  return prompts.map((p) => {
    const lines = [
      `# ${p.title}`,
      '',
      `- 类型：${p.contentTypeLabel || '提示词'}`,
      `- 分类：${p.category?.name || '未分类'}`,
      `- 标签：${(p.tags || []).join('、') || '无'}`,
      `- 来源：${p.sourceUrl || p.sourceDomain || '网页端'}`,
      `- 创建时间：${p.createdAt}`,
      '',
      p.markdownDoc || `## 原始提示词\n${p.content}`,
      '',
      '---',
      ''
    ];
    return lines.join('\n');
  }).join('\n');
}

function parseImportContent(format, content) {
  const text = String(content || '').trim();
  if (!text) return [];
  if (format === 'json') {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.prompts) ? parsed.prompts : []);
    return arr.map((item) => ({
      content: String(item.content || item.prompt || item.text || '').trim(),
      title: item.title ? String(item.title).trim() : '',
      summary: item.summary ? String(item.summary).trim() : '',
      markdownDoc: item.markdownDoc || item.markdown_doc || '',
      contentType: item.contentType || item.content_type || '',
      categoryName: item.categoryName || item.category_name || item.category?.name || '',
      sourceTitle: item.sourceTitle || item.source_title || 'JSON 导入',
      sourceUrl: item.sourceUrl || item.source_url || '',
      tagNames: Array.isArray(item.tags) ? item.tags.map(String) : [],
    })).filter((item) => item.content);
  }
  const sections = (/\n---+\s*(\n|$)/.test(text) ? text.split(/\n---+\s*(?:\n|$)/g) : text.split(/\n(?=#\s+)/g))
    .map((section) => section.trim())
    .filter(Boolean);
  if (sections.length) {
    return sections.map((section) => {
      const titleMatch = section.match(/^#\s+(.+)$/m);
      const cleaned = section.replace(/^#\s+.+$/m, '').trim();
      return {
        title: titleMatch ? titleMatch[1].trim() : '',
        content: cleaned || section,
        sourceTitle: 'Markdown 导入',
      };
    }).filter((item) => item.content);
  }
  return [{ content: text, sourceTitle: 'Markdown 导入' }];
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

app.get('/api/prompts/:id/versions', authRequired, asyncRoute(async (req, res) => {
  const prompt = await pool.query('SELECT id FROM prompts WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.sub]);
  if (!prompt.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const result = await pool.query(
    `SELECT v.*, c.name AS category_name
     FROM prompt_versions v
     LEFT JOIN categories c ON c.id=v.category_id
     WHERE v.prompt_id=$1
     ORDER BY v.created_at DESC`,
    [req.params.id]
  );
  res.json({
    success: true,
    data: result.rows.map((r) => ({
      id: r.id,
      promptId: r.prompt_id,
      title: r.title,
      content: r.content,
      summary: r.summary,
      markdownDoc: r.markdown_doc,
      category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
      changeNote: r.change_note,
      createdAt: r.created_at,
    }))
  });
}));

app.post('/api/prompts/:id/versions/:versionId/restore', authRequired, asyncRoute(async (req, res) => {
  const current = await pool.query('SELECT * FROM prompts WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.sub]);
  if (!current.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const version = await pool.query('SELECT * FROM prompt_versions WHERE id=$1 AND prompt_id=$2', [req.params.versionId, req.params.id]);
  if (!version.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '版本不存在' } });
  const old = current.rows[0];
  await pool.query(
    `INSERT INTO prompt_versions (id, prompt_id, title, content, summary, markdown_doc, category_id, changed_by, change_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id(), old.id, old.title, old.content, old.summary, old.markdown_doc, old.category_id, req.user.sub, '恢复版本前自动备份']
  );
  const v = version.rows[0];
  await pool.query(
    `UPDATE prompts
     SET title=$1, content=$2, summary=$3, markdown_doc=$4, category_id=$5, is_manual_confirmed=true, ai_status='completed', updated_at=now()
     WHERE id=$6 AND user_id=$7`,
    [v.title, v.content, v.summary, v.markdown_doc, v.category_id, req.params.id, req.user.sub]
  );
  const detail = await getPromptWithTagsForUser(req.user.sub, req.params.id);
  res.json({ success: true, data: detail });
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
  const contentType = normalizeContentType(body.contentType);
  const result = await pool.query(
    `INSERT INTO prompts (id, user_id, title, content, content_type, source_title, source_url, source_domain, ai_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [promptId, userId, String(body.title || '').trim() || makeTitle(content), content, contentType, body.sourceTitle || null, sourceUrl, sourceDomain, body.autoAnalyze === false ? 'completed' : 'pending']
  );
  if (body.autoAnalyze !== false) {
    await applyAnalysis(promptId, userId, content, body.aiModel);
  } else {
    const category = body.categoryName ? await findCategoryByName(String(body.categoryName).trim()) : null;
    await pool.query(
      `UPDATE prompts SET title=$1, summary=$2, markdown_doc=$3, category_id=COALESCE($4, category_id), content_type=$5, updated_at=now()
       WHERE id=$6 AND user_id=$7`,
      [
        String(body.title || '').trim() || makeTitle(content),
        body.summary ? String(body.summary).trim() : null,
        body.markdownDoc ? String(body.markdownDoc).trim() : null,
        category?.id || null,
        contentType,
        promptId,
        userId
      ]
    );
    if (Array.isArray(body.tagNames)) await setPromptTags(promptId, userId, body.tagNames);
  }
  const detail = await pool.query(
    `SELECT p.*, c.name AS category_name FROM prompts p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1`,
    [promptId]
  );
  return promptRow({ ...detail.rows[0], tags: await getTagsForPrompt(promptId) });
}

app.get('/api/export', authRequired, asyncRoute(async (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const prompts = await listPromptsForExport(req.user.sub);
  if (format === 'markdown' || format === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prompt-vault-export.md"');
    return res.send(promptsToMarkdown(prompts));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prompt-vault-export.json"');
  return res.json({ success: true, data: { exportedAt: new Date().toISOString(), prompts } });
}));

app.post('/api/import', authRequired, asyncRoute(async (req, res) => {
  const format = String(req.body.format || 'markdown').toLowerCase();
  const autoAnalyze = req.body.autoAnalyze !== false;
  const items = parseImportContent(format, req.body.content).slice(0, 80);
  if (!items.length) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '没有可导入的内容' } });
  const summary = { imported: 0, skipped: 0, failed: 0, items: [], errors: [] };
  for (const item of items) {
    try {
      const prompt = await createPrompt(req.user.sub, {
        ...item,
        autoAnalyze,
        aiModel: req.body.aiModel,
        forceSave: Boolean(req.body.forceSave),
        title: item.title,
        summary: item.summary,
        contentType: item.contentType,
        categoryName: item.categoryName,
        tagNames: item.tagNames,
        markdownDoc: item.markdownDoc,
      });
      summary.imported++;
      summary.items.push(prompt);
    } catch (error) {
      if (error.code === 'DUPLICATE_PROMPT') {
        summary.skipped++;
        summary.errors.push({ title: item.title || makeTitle(item.content), message: error.message, code: error.code, matches: error.details?.matches || [] });
      } else {
        summary.failed++;
        summary.errors.push({ title: item.title || makeTitle(item.content), message: error.message, code: error.code || 'IMPORT_FAILED' });
      }
    }
  }
  res.json({ success: true, data: summary });
}));

app.post('/api/prompts', authRequired, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await createPrompt(req.user.sub, req.body) });
}));

app.post('/api/extension/save-selection', authRequired, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await createPrompt(req.user.sub, req.body) });
}));

function cleanPromptIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((item) => /^[0-9a-f-]{36}$/i.test(item)))].slice(0, 200);
}

app.post('/api/prompts/batch/categorize', authRequired, asyncRoute(async (req, res) => {
  const ids = cleanPromptIds(req.body.ids);
  if (!ids.length) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '请选择要整理的提示词' } });
  let categoryId = req.body.categoryId || '';
  if (!categoryId && req.body.categoryName) {
    const category = await findOrCreateUserCategory(req.user.sub, req.body.categoryName);
    categoryId = category.id;
  }
  const category = await pool.query(
    `SELECT * FROM categories WHERE id=$1 AND (user_id=$2 OR user_id IS NULL) LIMIT 1`,
    [categoryId, req.user.sub]
  );
  if (!category.rows[0]) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '分类不存在' } });
  const result = await pool.query(
    `UPDATE prompts
     SET category_id=$1, content_type='error', is_manual_confirmed=true, ai_status='completed', updated_at=now()
     WHERE user_id=$2 AND deleted_at IS NULL AND id=ANY($3::uuid[])
     RETURNING id`,
    [categoryId, req.user.sub, ids]
  );
  res.json({ success: true, data: { updated: result.rowCount, category: { id: category.rows[0].id, name: category.rows[0].name } } });
}));

app.post('/api/prompts/batch/reanalyze', authRequired, asyncRoute(async (req, res) => {
  const ids = cleanPromptIds(req.body.ids);
  if (!ids.length) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '请选择要整理的提示词' } });
  const result = await pool.query(
    'SELECT id, content FROM prompts WHERE user_id=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[])',
    [req.user.sub, ids]
  );
  for (const row of result.rows) {
    await applyAnalysis(row.id, req.user.sub, row.content, req.body.aiModel);
  }
  res.json({ success: true, data: { updated: result.rowCount } });
}));

app.post('/api/prompts/batch/mark-error', authRequired, asyncRoute(async (req, res) => {
  const ids = cleanPromptIds(req.body.ids);
  if (!ids.length) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: '请选择要整理的提示词' } });
  const category = await findCategoryByName('错误提示词');
  const result = await pool.query(
    `UPDATE prompts
     SET category_id=$1, is_manual_confirmed=true, ai_status='completed', updated_at=now()
     WHERE user_id=$2 AND deleted_at IS NULL AND id=ANY($3::uuid[])
     RETURNING id`,
    [category.id, req.user.sub, ids]
  );
  res.json({ success: true, data: { updated: result.rowCount, category: { id: category.id, name: category.name } } });
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
    `UPDATE prompts SET title=$1, content=$2, summary=$3, markdown_doc=$4, category_id=$5, is_manual_confirmed=$6, content_type=$7, updated_at=now() WHERE id=$8 AND user_id=$9`,
    [req.body.title || old.title, req.body.content || old.content, req.body.summary ?? old.summary, req.body.markdownDoc ?? old.markdown_doc, req.body.categoryId || old.category_id, Boolean(req.body.isManualConfirmed ?? old.is_manual_confirmed), normalizeContentType(req.body.contentType || old.content_type), req.params.id, req.user.sub]
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

app.post('/api/prompts/:id/use', authRequired, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE prompts SET usage_count=usage_count+1, last_used_at=now(), updated_at=now()
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
     RETURNING usage_count, last_used_at`,
    [req.params.id, req.user.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  res.json({ success: true, data: { usageCount: result.rows[0].usage_count, lastUsedAt: result.rows[0].last_used_at } });
}));

app.post('/api/prompts/:id/mark-error', authRequired, asyncRoute(async (req, res) => {
  const category = await findCategoryByName('错误提示词');
  const result = await pool.query(
    `UPDATE prompts SET category_id=$1, content_type='error', ai_status='completed', is_manual_confirmed=true, updated_at=now()
     WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL RETURNING id`,
    [category.id, req.params.id, req.user.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const prompt = await getPromptWithTagsForUser(req.user.sub, req.params.id);
  res.json({ success: true, data: prompt });
}));

app.post('/api/prompts/:id/move-review', authRequired, asyncRoute(async (req, res) => {
  const category = await findCategoryByName('待人工确认');
  const result = await pool.query(
    `UPDATE prompts SET category_id=$1, content_type='review', ai_status='need_review', is_manual_confirmed=false, updated_at=now()
     WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL RETURNING id`,
    [category.id, req.params.id, req.user.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '提示词不存在' } });
  const prompt = await getPromptWithTagsForUser(req.user.sub, req.params.id);
  res.json({ success: true, data: prompt });
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
