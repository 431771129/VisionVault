# AI 视觉云图库 · Cloudflare Worker 版

<p align="center">
  <img src="https://img.icons8.com/fluency/96/000000/artificial-intelligence.png" alt="AI Vision" width="120" height="120">
  <h3 align="center">智能图片管理 · 一键备份 · 实时检索</h3>
</p>

<p align="center">
  <a href="#-功能特性">功能特性</a> •
  <a href="#-技术栈">技术栈</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-详细部署步骤">详细部署</a> •
  <a href="#-telegram-备份配置">Telegram备份</a> •
  <a href="#-环境变量参考">环境变量</a> •
  <a href="#-常见问题">常见问题</a>
</p>

## ✨ 功能特性

- 🔐 **账号密码登录** – 支持自定义用户名密码，JWT 令牌认证，保护您的私人图库
- 🖼️ **AI 自动打标** – 使用 Llama 3.2 Vision 模型分析图片，生成5~8个中文关键词，按 `|` 分隔存储
- ☁️ **R2 对象存储** – 图片直接存入 Cloudflare R2，低成本、高可用，支持公开访问
- 📚 **D1 数据库** – 存储图片URL和AI标签，支持按关键词模糊搜索
- 🏷️ **瀑布流布局** – 响应式卡片展示，标签采用胶囊样式，图片可缩放预览
- 📋 **便捷管理** – 复制图片链接、单张删除、批量上传（带冷却）
- 📲 **Telegram 自动备份** – 每张上传的图片及标签自动发送到指定 Telegram 聊天（可选）
- 🚀 **零服务器运维** – 完全基于 Cloudflare 边缘网络，全球加速

## 🛠️ 技术栈

- **Cloudflare Workers** – 无服务器计算，托管前端页面及 API
- **Cloudflare R2** – 对象存储，存放图片文件
- **Cloudflare D1** – 关系型数据库，存储图片元数据
- **Cloudflare Workers AI** – Llama 3.2 Vision 模型，图片识别
- **Tailwind CSS** – 前端样式，快速构建现代化界面
- **JWT** – 用户登录令牌

## 🚀 快速开始

### 前置条件

- 拥有 Cloudflare 账号（免费即可）
- 已开通 R2、D1、Workers AI 服务（大部分免费套餐可用）

### 一键部署（手动配置）

本仓库提供完整的 Worker 代码，您只需在 Cloudflare 控制台依次创建资源并粘贴代码即可。

## 📋 详细部署步骤

### 1. 创建 R2 存储桶

1. 进入 Cloudflare 控制台 → **R2**
2. 点击 **创建存储桶**，输入名称（如 `ai-image-bucket`）
3. 创建后进入存储桶设置，在 **公共访问** 中启用，复制 **公共 R2.dev 域名**（形如 `https://pub-xxxxxxxxxxxxxx.r2.dev`）

### 2. 创建 D1 数据库

1. 进入 **D1** → **创建数据库**，输入名称（如 `image-database`）
2. 创建后点击数据库名称，进入 **控制台** 执行以下 SQL 创建表：

```sql
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT NOT NULL,
    ai_tags TEXT,
    upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
