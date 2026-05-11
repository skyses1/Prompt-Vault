# Prompt Vault / 提示词金库

Prompt Vault（提示词金库）是一个用于保存、整理、搜索和复用 AI 提示词的轻量级系统。

它包含：

- 网页端提示词管理后台
- Chrome 插件采集器
- PostgreSQL 数据库存储
- 通义 / DashScope 兼容 OpenAI 接口的 AI 自动整理
- Markdown 知识卡片生成
- 重复 / 相似提示词检测
- 收藏提示词复制与插入

> 当前版本是 MVP，优先保证个人或小团队可以快速部署和使用。

## 当前版本

```text
Web / Backend: MVP
Chrome Extension: 0.4.0
```

版本 `0.4.0` 更新重点：

- 网页端支持 Markdown / JSON 导入导出。
- 网页端支持一键复制 Markdown 文档和原始提示词。
- 网页端支持把误保存内容快速归为“错误提示词”或转入“待人工确认”。
- Chrome 插件增加浏览器侧边栏。
- Chrome 插件插入 / 复制时支持 `{{变量名}}` 模板变量填写。
- 插件弹窗默认搜索全部提示词，不再只搜索收藏。
- 保留“只看收藏”开关。
- 支持页面内快捷搜索面板。
- 支持快捷键预设和自定义快捷键。
- 默认快捷键：`Ctrl+Shift+K`。
- 搜索结果点击或按 Enter 后，会同时复制到剪贴板并插入当前输入框。
- 针对 ChatGPT 输入框增加插入兜底逻辑：复制、模拟粘贴、直接插入多层处理。

## 功能特性

- 邮箱密码注册与登录
- 提示词新增、编辑、删除、搜索、收藏
- AI 自动生成标题、分类、标签、摘要和 Markdown 文档
- Markdown / JSON 导入导出
- 一键复制 Markdown 文档或原始提示词
- 自动识别重复 / 相似提示词，避免重复保存
- 支持“错误提示词”分类，用于归纳误选文本、错误日志、乱码或无意义片段
- Chrome 插件右键保存选中文本
- Chrome 插件搜索全部提示词，可切换为只看收藏，并插入到当前 AI 网站输入框
- Chrome 插件侧边栏
- 支持 `{{变量名}}` 形式的提示词变量模板
- 支持 PostgreSQL
- 支持 Ubuntu 裸机部署
- 支持 Docker Compose 部署

## 项目结构

```text
Prompt-Vault/
  backend/              # Node.js + Express API 和网页 UI
    src/server.js
    public/
    package.json
    Dockerfile
  extension/            # Chrome Manifest V3 插件
    manifest.json
    background.js
    popup.html
    sidepanel.html
    popup.js
    content.js
    styles.css
  docker-compose.yml
  .env.example
  README.md
```

## 访问端口

默认应用端口：

```text
8080
```

默认访问地址：

```text
http://服务器IP:8080
```

例如：

```text
http://10.10.10.68:8080
```

## 环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

示例：

```text
POSTGRES_DB=prompt_vault
POSTGRES_USER=prompt_user
POSTGRES_PASSWORD=please_change_me
DATABASE_URL=postgresql://prompt_user:please_change_me@127.0.0.1:5432/prompt_vault
JWT_SECRET=please_change_to_a_long_random_secret
JWT_EXPIRES_IN=7d
TONGYI_API_KEY=
TONGYI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
TONGYI_MODEL=Qwen3.6-Plus
TONGYI_MODELS=Qwen3.6-Plus,qwen3.6-max-preview
AI_TIMEOUT_MS=120000
PORT=8080
```

字段说明：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接地址 |
| `JWT_SECRET` | 登录令牌密钥，必须改成长随机字符串 |
| `TONGYI_API_KEY` | 通义 / DashScope API Key |
| `TONGYI_BASE_URL` | OpenAI 兼容接口 Base URL |
| `TONGYI_MODEL` | 默认 AI 整理模型 |
| `TONGYI_MODELS` | 页面和插件可选择的模型列表 |
| `AI_TIMEOUT_MS` | AI 整理超时时间，默认 120 秒 |
| `PORT` | Web 服务端口 |

注意：

```text
不要提交 .env 到 GitHub。
```

## 方式一：Ubuntu 裸机部署

适合场景：

- 你有一台 Ubuntu 服务器
- 希望不用 Docker，也能快速跑起来
- 想用 systemd 管理服务，服务器重启后自动恢复

### 1. 安装依赖

Ubuntu 22.04 / 24.04 推荐：

```bash
sudo apt update
sudo apt install -y curl git postgresql postgresql-contrib
```

安装 Node.js 20 或 22：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

检查版本：

```bash
node -v
npm -v
psql --version
```

### 2. 拉取代码

```bash
cd /opt
sudo git clone https://github.com/skyses1/Prompt-Vault.git prompt-vault
sudo chown -R $USER:$USER /opt/prompt-vault
cd /opt/prompt-vault
```

如果你的服务器没有安装 git，也可以下载 ZIP 后解压。

### 3. 创建 PostgreSQL 数据库

```bash
sudo -u postgres psql
```

进入 psql 后执行：

```sql
CREATE USER prompt_user WITH PASSWORD 'please_change_me';
CREATE DATABASE prompt_vault OWNER prompt_user;
GRANT ALL PRIVILEGES ON DATABASE prompt_vault TO prompt_user;
\q
```

### 4. 配置环境变量

```bash
cp .env.example .env
nano .env
```

修改至少这些字段：

```text
POSTGRES_PASSWORD=please_change_me
DATABASE_URL=postgresql://prompt_user:please_change_me@127.0.0.1:5432/prompt_vault
JWT_SECRET=换成一串很长的随机字符串
TONGYI_API_KEY=你的通义Key
PORT=8080
```

生成随机 JWT_SECRET 的一种方式：

```bash
openssl rand -base64 48
```

### 5. 安装后端依赖

```bash
cd /opt/prompt-vault/backend
npm install --omit=dev
```

### 6. 手动启动测试

```bash
cd /opt/prompt-vault/backend
set -a
. /opt/prompt-vault/.env
set +a
node src/server.js
```

浏览器访问：

```text
http://服务器IP:8080
```

健康检查：

```bash
curl http://127.0.0.1:8080/api/health
```

看到 `status: ok` 即可。

### 7. 使用 systemd 后台运行

创建服务文件：

```bash
sudo nano /etc/systemd/system/prompt-vault.service
```

写入：

```ini
[Unit]
Description=Prompt Vault
After=network.target postgresql.service

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/prompt-vault/backend
EnvironmentFile=/opt/prompt-vault/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

把 `YOUR_USER` 改成你的 Ubuntu 用户名，例如：

```text
ubuntu
```

或：

```text
skyses2
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now prompt-vault
sudo systemctl status prompt-vault --no-pager
```

查看日志：

```bash
sudo journalctl -u prompt-vault -f
```

重启服务：

```bash
sudo systemctl restart prompt-vault
```

## 方式二：Docker Compose 部署

适合场景：

- 希望数据库和应用都在容器里
- 希望部署方式更统一
- 不想手动安装 PostgreSQL

### 1. 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

重新登录服务器后检查：

```bash
docker --version
docker compose version
```

### 2. 拉取代码

```bash
cd /opt
sudo git clone https://github.com/skyses1/Prompt-Vault.git prompt-vault
sudo chown -R $USER:$USER /opt/prompt-vault
cd /opt/prompt-vault
```

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env
```

Docker Compose 默认使用容器名 `postgres` 作为数据库地址，所以 `.env` 中推荐：

```text
POSTGRES_DB=prompt_vault
POSTGRES_USER=prompt_user
POSTGRES_PASSWORD=please_change_me
DATABASE_URL=postgresql://prompt_user:please_change_me@postgres:5432/prompt_vault
JWT_SECRET=换成一串很长的随机字符串
TONGYI_API_KEY=你的通义Key
TONGYI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
TONGYI_MODEL=Qwen3.6-Plus
TONGYI_MODELS=Qwen3.6-Plus,qwen3.6-max-preview
AI_TIMEOUT_MS=120000
```

### 4. 启动

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f app
```

访问：

```text
http://服务器IP:8080
```

健康检查：

```bash
curl http://127.0.0.1:8080/api/health
```

### 5. 停止和重启

```bash
docker compose restart
```

```bash
docker compose down
```

如果要保留数据，不要删除 volume。

## 方式三：一键部署脚本（Ubuntu 裸机）

如果你想快速在 Ubuntu 上直接部署，可以使用下面的脚本。

> 使用前请先准备好你的 `TONGYI_API_KEY`。

```bash
cat > deploy_prompt_vault.sh <<'EOF'
#!/usr/bin/env bash
set -e

APP_DIR="/opt/prompt-vault"
REPO_URL="https://github.com/skyses1/Prompt-Vault.git"
APP_PORT="8080"
DB_NAME="prompt_vault"
DB_USER="prompt_user"
DB_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
JWT_SECRET="$(openssl rand -base64 48)"

read -rp "请输入通义 / DashScope API Key: " TONGYI_API_KEY

sudo apt update
sudo apt install -y curl git postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

sudo systemctl enable --now postgresql

sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

if [ ! -d "$APP_DIR" ]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
else
  cd "$APP_DIR"
  sudo git pull
fi

sudo chown -R "$USER:$USER" "$APP_DIR"

cat > "$APP_DIR/.env" <<ENV
POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${DB_PASS}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
TONGYI_API_KEY=${TONGYI_API_KEY}
TONGYI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
TONGYI_MODEL=Qwen3.6-Plus
TONGYI_MODELS=Qwen3.6-Plus,qwen3.6-max-preview
AI_TIMEOUT_MS=120000
PORT=${APP_PORT}
ENV

chmod 600 "$APP_DIR/.env"

cd "$APP_DIR/backend"
npm install --omit=dev

sudo tee /etc/systemd/system/prompt-vault.service >/dev/null <<SERVICE
[Unit]
Description=Prompt Vault
After=network.target postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable --now prompt-vault
sleep 3
sudo systemctl status prompt-vault --no-pager

echo ""
echo "部署完成："
echo "http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
EOF

chmod +x deploy_prompt_vault.sh
./deploy_prompt_vault.sh
```

## 方式四：一键 Docker Compose 部署

```bash
cat > deploy_prompt_vault_docker.sh <<'EOF'
#!/usr/bin/env bash
set -e

APP_DIR="/opt/prompt-vault"
REPO_URL="https://github.com/skyses1/Prompt-Vault.git"

read -rp "请输入通义 / DashScope API Key: " TONGYI_API_KEY
DB_PASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
JWT_SECRET="$(openssl rand -base64 48)"

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

if [ ! -d "$APP_DIR" ]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
else
  cd "$APP_DIR"
  sudo git pull
fi

sudo chown -R "$USER:$USER" "$APP_DIR"
cd "$APP_DIR"

cat > .env <<ENV
POSTGRES_DB=prompt_vault
POSTGRES_USER=prompt_user
POSTGRES_PASSWORD=${DB_PASS}
DATABASE_URL=postgresql://prompt_user:${DB_PASS}@postgres:5432/prompt_vault
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
TONGYI_API_KEY=${TONGYI_API_KEY}
TONGYI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
TONGYI_MODEL=Qwen3.6-Plus
TONGYI_MODELS=Qwen3.6-Plus,qwen3.6-max-preview
AI_TIMEOUT_MS=120000
ENV

chmod 600 .env
docker compose up -d --build

echo ""
echo "部署完成："
echo "http://$(hostname -I | awk '{print $1}'):8080"
EOF

chmod +x deploy_prompt_vault_docker.sh
./deploy_prompt_vault_docker.sh
```

## Chrome 插件安装

1. 打开 Chrome：

```text
chrome://extensions/
```

2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目里的 `extension` 目录。
5. 点击插件图标，填写：

```text
API 地址：http://服务器IP:8080/api
邮箱：你的账号邮箱
密码：你的账号密码
```

## Chrome 插件使用

保存提示词：

```text
选中文字 -> 右键 -> 保存到提示词金库
```

搜索并插入提示词：

```text
点击插件图标 -> 搜索全部提示词 -> 插入
```

浏览器侧边栏：

```text
点击插件图标 -> 打开浏览器侧边栏
```

变量模板：

```text
提示词中写入 {{主题}}、{{风格}} 等变量
点击插入 / 复制时，插件会提示填写变量值
```

只看收藏：

```text
插件弹窗 -> 勾选“只看收藏”
```

页面内快捷搜索：

```text
Ctrl + Shift + K
输入关键词
Enter 插入
Esc 关闭
↑ / ↓ 切换结果
```

快捷键设置：

```text
插件弹窗 -> 启用快捷键 -> 快捷键预设 / 自定义快捷键
```

内置预设：

```text
Ctrl+Shift+K
Ctrl+K
Alt+K
Alt+P
Ctrl+Shift+P
```

自定义示例：

```text
Ctrl+Alt+P
Alt+Shift+K
Ctrl+Shift+J
```

插入行为：

```text
点击结果 / 按 Enter
= 复制到剪贴板 + 插入到当前输入框
```

如果 ChatGPT 或其他网页阻止自动插入，内容仍然已经复制到剪贴板，可以直接 `Ctrl+V`。

注意：

- 插件弹窗默认搜索全部提示词。
- 右键保存会自动调用 AI 整理。
- 如果检测到相似提示词，插件会提示已经保存过类似内容。
- 更新插件后，需要在 `chrome://extensions/` 里点击“重新加载”，并刷新 ChatGPT 页面。

## 导入导出

网页端支持：

```text
导入 Markdown
导入 JSON
导出 Markdown
导出 JSON
```

导入 Markdown 时，可以直接粘贴单篇 Markdown，也可以用多个一级标题分隔多条提示词。

导入 JSON 支持数组或 `{ "prompts": [] }` 结构，常见字段包括：

```json
{
  "title": "提示词标题",
  "content": "提示词原文",
  "summary": "摘要",
  "markdownDoc": "# Markdown 知识卡片",
  "tags": ["写作", "营销"],
  "category": { "name": "商业营销" },
  "sourceUrl": "https://example.com"
}
```

## AI 自动整理说明

保存提示词后，系统会自动整理为 Markdown 文档：

```markdown
# 提示词标题

## 用途
说明这个提示词适合做什么。

## 适用场景
- 场景 1
- 场景 2

## 原始提示词
保存的原始内容。

## 使用方法
如何复用和修改。

## 标签
标签列表。

## 来源说明
来源网站或页面。
```

如果内容明显不是可复用提示词，例如错误日志、误选文本、乱码或无意义片段，系统会归类到：

```text
错误提示词
```

## 常用运维命令

Ubuntu systemd：

```bash
sudo systemctl status prompt-vault --no-pager
sudo systemctl restart prompt-vault
sudo journalctl -u prompt-vault -f
```

Docker Compose：

```bash
docker compose ps
docker compose logs -f app
docker compose restart
```

PostgreSQL 备份：

```bash
pg_dump "$DATABASE_URL" > prompt_vault_backup.sql
```

Docker 数据库备份：

```bash
docker compose exec postgres pg_dump -U prompt_user prompt_vault > prompt_vault_backup.sql
```

## 安全建议

- 不要提交 `.env`
- 不要把 API Key 写进前端或 Chrome 插件
- `JWT_SECRET` 必须使用长随机字符串
- 公开部署时建议配置 HTTPS
- 生产环境建议限制数据库端口只允许本机或容器网络访问

## 后续计划

- 团队空间和权限管理
- pgvector 语义搜索
- 提示词版本对比
- 错误提示词批量审核和恢复
- 插件侧边栏体验继续精修


