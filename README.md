# Prompt Vault / 提示词金库

一个可部署到 Ubuntu 的提示词管理 MVP，支持网页端提示词管理、Chrome 插件采集、通义 AI 自动整理 Markdown 文档、收藏与插入常用提示词。

## 功能

- 邮箱密码注册与登录
- 提示词新增、编辑、删除、搜索、收藏
- AI 自动整理标题、分类、标签、摘要和 Markdown 文档
- 重复/相似提示词检测
- Chrome 插件右键保存选中文本
- Chrome 插件收藏提示词搜索、复制、插入
- PostgreSQL 数据库存储
- Ubuntu systemd 或 Docker Compose 部署

## 目录

```text
backend/      Node.js + Express API 和网页 UI
extension/    Chrome Manifest V3 插件
docker-compose.yml
.env.example
```

## 环境变量

复制 `.env.example` 为 `.env`，并填写真实配置。

```text
DATABASE_URL=
JWT_SECRET=
TONGYI_API_KEY=
TONGYI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
TONGYI_MODEL=Qwen3.6-Plus
TONGYI_MODELS=Qwen3.6-Plus,qwen3.6-max-preview
```

不要把 `.env` 提交到仓库。

## 本地运行

```bash
cd backend
npm install
npm start
```

默认服务端口由 `PORT` 环境变量控制。

## Chrome 插件

在 Chrome 中打开：

```text
chrome://extensions/
```

开启开发者模式，选择“加载已解压的扩展程序”，加载 `extension` 目录。

## 说明

这是第一版 MVP，优先保证核心闭环可用。后续可以继续升级团队空间、导入导出、语义搜索、权限管理和更完整的部署流程。
