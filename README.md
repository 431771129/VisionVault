# 🧠 AI 视觉云图库 · VisionVault

<p align="center">
  <img src="https://img.icons8.com/fluency/96/000000/artificial-intelligence.png" alt="AI Vision" width="120" height="120">
  <h3 align="center">智能图片管理 · 一键备份 · 实时检索 · 私有部署</h3>
</p>

<p align="center">
  <a href="#-功能特性">功能特性</a> •
  <a href="#-技术栈">技术栈</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-详细部署教程">详细部署</a> •
  <a href="#-telegram-备份配置">Telegram备份</a> •
  <a href="#-环境变量参考">环境变量</a> •
  <a href="#-使用指南">使用指南</a> •
  <a href="#-常见问题">常见问题</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-f6821f?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/R2-Storage-ff9900?logo=amazons3&logoColor=white" alt="R2">
  <img src="https://img.shields.io/badge/D1-Database-3b82f6?logo=sqlite&logoColor=white" alt="D1">
  <img src="https://img.shields.io/badge/AI-Llama%203.2%20Vision-8c5aff?logo=nvidia&logoColor=white" alt="Workers AI">
  <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white" alt="Telegram Bot">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## ✨ 功能特性

- 🔐 **账号密码登录** – 自定义用户名密码，JWT 令牌认证，保护您的私人图库免受未授权访问。
- 🖼️ **AI 自动打标** – 使用 Llama 3.2 Vision 模型分析每张图片，生成 5~8 个中文关键词，按 `|` 分隔存储，便于搜索。
- ☁️ **R2 对象存储** – 图片直接存入 Cloudflare R2，低成本、高可用，支持公开访问（可配置）。
- 📚 **D1 数据库** – 存储图片 URL 和 AI 标签，支持按关键词模糊搜索，并自动记录上传时间。
- 🏷️ **瀑布流布局** – 响应式卡片展示，标签采用胶囊样式，图片悬停可缩放预览。
- 📋 **便捷管理** – 复制图片链接、单张删除、批量上传（内置 2 秒冷却避免并发超时）。
- 📲 **Telegram 自动备份** – 每张上传的图片及其标签自动发送到指定 Telegram 聊天（可选，支持频道/群组/私聊）。
- 🚀 **零服务器运维** – 完全基于 Cloudflare 边缘网络，全球加速，无需管理基础设施。

---

## 🛠️ 技术栈

| 组件                | 技术选型                                           |
|---------------------|----------------------------------------------------|
| 前端                | HTML5 + Tailwind CSS（内嵌于 Worker）             |
| 后端 API            | Cloudflare Workers（JavaScript）                   |
| 图片存储            | Cloudflare R2（兼容 S3 的对象存储）                |
| 元数据数据库        | Cloudflare D1（基于 SQLite 的关系型数据库）        |
| AI 图片识别         | Cloudflare Workers AI（Llama 3.2 Vision 模型）     |
| 身份认证            | JWT（HMAC-SHA256，存储在 localStorage）            |
| 外部集成            | Telegram Bot API（可选，用于备份）                  |

---

## 🚀 快速开始

### 前置条件

- 一个 Cloudflare 账号（免费即可）
- 已开通 **R2 存储**、**D1 数据库**、**Workers AI**（部分服务需绑定支付方式以启用免费额度外的用量）

### 一键部署（手动配置）

本仓库提供完整的 Worker 代码，您只需在 Cloudflare 控制台依次创建资源并粘贴代码即可。

---

## 📋 详细部署教程

### 1. 创建 R2 存储桶

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com)
2. 左侧导航栏点击 **R2** → **创建存储桶**
3. 输入存储桶名称（例如 `ai-image-bucket`），选择区域，点击 **创建存储桶**
4. 创建成功后，点击存储桶名称进入详情页
5. 找到 **设置** → **公共访问**，点击 **允许访问**（开启后图片可通过公共 URL 访问）
6. 复制页面中显示的 **公共 R2.dev 域名**（形如 `https://pub-xxxxxxxxxxxxxx.r2.dev`），**保存备用**

### 2. 创建 D1 数据库

1. 左侧导航栏点击 **D1** → **创建数据库**
2. 输入数据库名称（例如 `image-database`），选择区域，点击 **创建**
3. 创建成功后，点击数据库名称进入详情页
4. 点击 **控制台** 或 **查询** 标签页，打开 SQL 执行界面
5. 执行以下 SQL 语句创建数据表：

```sql
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT NOT NULL,
    ai_tags TEXT,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
);