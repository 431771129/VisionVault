// =====================================================
// AI视觉图床 - Cloudflare Worker 完整版
// 功能：登录保护、AI自动打标、R2存储、D1数据库、Telegram备份
// 部署前必填环境变量：
//   - R2_PUBLIC_URL      : 您的R2桶公共访问地址，例如 https://pub-xxxx.r2.dev
//   - USERNAME           : (可选)登录用户名，默认 admin
//   - PASSWORD           : (可选)登录密码，默认 password
//   - SECRET             : JWT签名密钥，请设置为随机字符串，默认 default_secret_change_me
//   - TELEGRAM_BOT_TOKEN : (可选)Telegram Bot Token，用于图片备份
//   - TELEGRAM_CHAT_ID   : (可选)接收备份的频道/群组/用户ID
// 必须绑定以下资源：
//   - MY_BUCKET : R2 存储桶
//   - MY_DB     : D1 数据库
//   - AI        : Workers AI
// =====================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    // 静态 HTML 页面 (无需登录)
    if (method === 'GET' && path === '/') {
      const html = renderHTML();
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 登录 API (无需认证)
    if (method === 'POST' && path === '/api/login') {
      try {
        const { username, password } = await request.json();
        const validUser = env.USERNAME || 'admin';
        const validPass = env.PASSWORD || 'password';

        if (username !== validUser || password !== validPass) {
          return new Response(JSON.stringify({ error: '用户名或密码错误' }), {
            status: 401,
            headers: corsHeaders,
          });
        }

        const token = await createToken(username, env.SECRET || 'default_secret_change_me');
        return new Response(JSON.stringify({ success: true, token }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: '登录处理失败' }), {
          status: 400,
          headers: corsHeaders,
        });
      }
    }

    // 以下所有 /api/* 都需要认证
    if (path.startsWith('/api/')) {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '').trim();

      const payload = await verifyToken(token, env.SECRET || 'default_secret_change_me');
      if (!payload) {
        return new Response(JSON.stringify({ error: '未授权或登录已过期' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      // 上传图片
      if (method === 'POST' && path === '/api/upload') {
        return handleUpload(request, env, corsHeaders);
      }

      // 删除图片
      if (method === 'DELETE' && path === '/api/delete') {
        return handleDelete(url, env, corsHeaders);
      }

      // 获取图片列表 / 模型设置
      if (method === 'GET' && path === '/api/images') {
        if (url.searchParams.get('setup') === 'agree') {
          return handleSetup(env, corsHeaders);
        }
        return handleGetImages(url, env, corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'API 未找到' }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

// ---------- 工具函数：JWT 生成与验证 ----------
async function createToken(username, secret) {
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600; // 24小时
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: username, exp };

  const base64Encode = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const encodedHeader = base64Encode(header);
  const encodedPayload = base64Encode(payload);
  const message = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${message}.${encodedSignature}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const message = `${encodedHeader}.${encodedPayload}`;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBin = Uint8Array.from(
      atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBin, encoder.encode(message));
    if (!valid) return null;

    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- 处理上传 ----------
async function handleUpload(request, env, corsHeaders) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get('file');
    const thumbnailFile = formData.get('thumbnail') || imageFile;

    if (!imageFile) {
      return new Response(JSON.stringify({ error: '未提供图片文件' }), { status: 400, headers: corsHeaders });
    }

    const fileExt = imageFile.name.split('.').pop();
    const fileName = `${crypto.randomUUID()}.${fileExt}`;
    await env.MY_BUCKET.put(fileName, imageFile.stream());

    const publicR2Url = env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${fileName}` : `https://${fileName}`;

    // AI 识别
    const aiArrayBuffer = await thumbnailFile.arrayBuffer();
    const aiUint8Array = new Uint8Array(aiArrayBuffer);

    const aiResponse = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      image: [...aiUint8Array],
      prompt: '分析这张图片，提供5到8个描述图片的简体中文关键词，词语之间用 | 分隔。强制规则：仅返回中文关键词，禁止返回任何英文、前缀（如“关键词:”、“Tags:”）、特殊符号（如“*”）、句子或解释，只输出用逗号分隔的中文字符串。',
      max_tokens: 30,
      temperature: 0.1,
    });

    let tags = aiResponse.response.trim();
    if (/[\u4e00-\u9fa5]/.test(tags)) {
      tags = tags.replace(/^[^\u4e00-\u9fa5]+/, '');
    } else {
      tags = tags.replace(/^.*:\s*/, '');
    }
    tags = tags.replace(/[。！.]$/, '');
    if (!tags) tags = '未识别标签';

    await env.MY_DB.prepare('INSERT INTO images (image_url, ai_tags) VALUES (?, ?)')
      .bind(publicR2Url, tags)
      .run();

    // ---------- Telegram 自动备份 (异步，不影响响应) ----------
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      sendToTelegram(publicR2Url, tags, env).catch(err => {
        console.error('Telegram backup error:', err.message);
      });
    }

    return new Response(JSON.stringify({ success: true, url: publicR2Url, tags }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

// ---------- 发送图片到 Telegram ----------
async function sendToTelegram(imageUrl, tags, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const caption = `🖼️ 新图片备份\n标签: ${tags}\nURL: ${imageUrl}`;
  const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;

  const payload = {
    chat_id: chatId,
    photo: imageUrl,
    caption: caption.substring(0, 1024), // Telegram caption 上限 1024 字符
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${errText}`);
  }
}

// ---------- 处理删除 ----------
async function handleDelete(url, env, corsHeaders) {
  try {
    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) {
      return new Response(JSON.stringify({ error: '未提供图片 URL' }), { status: 400, headers: corsHeaders });
    }

    const fileName = imageUrl.substring(imageUrl.lastIndexOf('/') + 1);
    await env.MY_BUCKET.delete(fileName);
    await env.MY_DB.prepare('DELETE FROM images WHERE image_url = ?').bind(imageUrl).run();

    return new Response(JSON.stringify({ success: true, message: '删除成功' }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

// ---------- 获取图片列表 ----------
async function handleGetImages(url, env, corsHeaders) {
  const keyword = url.searchParams.get('keyword');
  let query = 'SELECT * FROM images ORDER BY upload_time DESC LIMIT 50';
  let params = [];

  if (keyword) {
    query = 'SELECT * FROM images WHERE ai_tags LIKE ? ORDER BY upload_time DESC';
    params = [`%${keyword}%`];
  }

  const { results } = await env.MY_DB.prepare(query).bind(...params).all();
  return new Response(JSON.stringify(results), { headers: corsHeaders });
}

// ---------- 模型激活 ----------
async function handleSetup(env, corsHeaders) {
  try {
    await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
    return new Response('Setup successful', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders },
    });
  } catch (e) {
    if (e.message.includes('Thank you for agreeing')) {
      return new Response('Setup completed successfully', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders },
      });
    }
    return new Response('Setup error: ' + e.message, { headers: corsHeaders });
  }
}

// ---------- 前端 HTML (包含完整界面和交互逻辑) ----------
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 视觉云图库</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        /* 核心瀑布流布局 */
        .masonry-container {
            column-count: 1;
            column-gap: 1.5rem;
        }
        @media (min-width: 640px) { .masonry-container { column-count: 2; } }
        @media (min-width: 1024px) { .masonry-container { column-count: 3; } }
        @media (min-width: 1280px) { .masonry-container { column-count: 4; } }

        .masonry-item {
            break-inside: avoid;
            margin-bottom: 1.5rem;
            transform: translateZ(0);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .glass-nav {
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
        }

        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #f1f1f1; }
        ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #999; }

        .hidden { display: none !important; }
        
        .tag-badge {
            transition: all 0.2s;
            background: #f3f4f6;
        }
        .tag-badge:hover {
            background: #e5e7eb;
            transform: translateY(-1px);
        }

        #dropZone {
            transition: all 0.3s ease;
        }
        .drag-active {
            border-color: #3b82f6 !important;
            background-color: #eff6ff !important;
            transform: scale(1.02);
        }
    </style>
</head>
<body class="bg-[#f8fafc] text-slate-900 font-sans min-h-screen">

    <!-- 登录界面 -->
    <div id="loginContainer" class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-50">
        <div class="max-w-md w-full bg-white p-8 rounded-3xl shadow-2xl border border-slate-100 text-center">
            <div class="inline-flex items-center justify-center w-20 h-20 bg-blue-50 text-blue-600 rounded-2xl text-4xl mb-6">📸</div>
            <h2 class="text-2xl font-black text-slate-800 mb-2">欢迎回来</h2>
            <p class="text-slate-500 mb-8 text-sm">请输入凭据以访问您的私人 AI 图库</p>
            <div class="space-y-4">
                <input type="text" id="loginUsername" placeholder="用户名" class="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition">
                <input type="password" id="loginPassword" placeholder="访问密码" class="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition">
                <button onclick="doLogin()" class="w-full bg-slate-900 text-white py-4 rounded-2xl font-bold hover:bg-black transition shadow-lg">进入系统</button>
                <p id="loginError" class="text-red-500 text-sm h-4"></p>
            </div>
        </div>
    </div>

    <!-- 主应用界面 -->
    <div id="appContainer" class="hidden">
        <nav class="glass-nav sticky top-0 z-40 border-b border-slate-200/50 px-6 py-4 mb-8">
            <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
                <div class="flex items-center gap-2">
                    <span class="text-2xl">⚡</span>
                    <h1 class="text-xl font-black tracking-tight uppercase">Vision Engine</h1>
                </div>
                <div class="flex-1 max-w-xl">
                    <div class="relative">
                        <input type="text" id="searchInput" placeholder="搜索 AI 标签..." 
                               class="w-full pl-12 pr-4 py-2.5 bg-slate-100 border-transparent rounded-xl focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none transition">
                        <span class="absolute left-4 top-3 text-slate-400">🔍</span>
                    </div>
                </div>
                <button onclick="logout()" class="text-sm font-bold text-slate-500 hover:text-red-600 transition">退出登出</button>
            </div>
        </nav>

        <main class="max-w-7xl mx-auto px-6">
            <!-- 上传区域 -->
            <div id="dropZone" class="bg-white rounded-3xl border-2 border-dashed border-slate-200 p-12 text-center hover:border-blue-400 hover:bg-blue-50/30 transition-all mb-10 group relative overflow-hidden">
                <input type="file" id="fileInput" class="hidden" accept="image/*" multiple>
                <div class="relative z-10">
                    <div class="text-5xl mb-4 group-hover:scale-110 transition-transform duration-300">📤</div>
                    <h2 class="text-xl font-bold text-slate-800 mb-1">点选或拖拽图片</h2>
                    <p class="text-slate-400 text-sm">AI 会自动为您标记内容</p>
                    <button onclick="document.getElementById('fileInput').click()" class="mt-6 bg-blue-600 text-white px-8 py-2.5 rounded-full font-bold hover:bg-blue-700 transition shadow-lg shadow-blue-200">开始上传</button>
                </div>
                <p id="uploadStatus" class="mt-4 text-sm font-semibold"></p>
            </div>

            <!-- 瀑布流图库 -->
            <div id="gallery" class="masonry-container"></div>
        </main>
    </div>

    <script>
        // ---------- 认证令牌管理 ----------
        const TOKEN_KEY = 'vision_image_bed_token';
        let authToken = localStorage.getItem(TOKEN_KEY) || null;

        (function init() {
            if (authToken) {
                document.getElementById('loginContainer').classList.add('hidden');
                document.getElementById('appContainer').classList.remove('hidden');
                loadImages();
                bindEvents();
            } else {
                document.getElementById('loginContainer').classList.remove('hidden');
                document.getElementById('appContainer').classList.add('hidden');
            }
        })();

        // 登录
        async function doLogin() {
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value.trim();
            const errorEl = document.getElementById('loginError');
            if (!username || !password) {
                errorEl.innerText = '请输入用户名和密码';
                return;
            }
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (res.ok && data.token) {
                    authToken = data.token;
                    localStorage.setItem(TOKEN_KEY, authToken);
                    document.getElementById('loginContainer').classList.add('hidden');
                    document.getElementById('appContainer').classList.remove('hidden');
                    loadImages();
                    bindEvents();
                } else {
                    errorEl.innerText = data.error || '登录失败';
                }
            } catch (e) {
                errorEl.innerText = '网络错误';
            }
        }

        // 登出
        function logout() {
            authToken = null;
            localStorage.removeItem(TOKEN_KEY);
            document.getElementById('loginContainer').classList.remove('hidden');
            document.getElementById('appContainer').classList.add('hidden');
        }

        // 绑定上传、搜索事件 (每次登录后调用)
        function bindEvents() {
            const dropZone = document.getElementById('dropZone');
            const fileInput = document.getElementById('fileInput');
            const searchInput = document.getElementById('searchInput');

            // 移除旧监听避免重复
            const newDropZone = dropZone.cloneNode(true);
            dropZone.parentNode.replaceChild(newDropZone, dropZone);
            const newFileInput = document.getElementById('fileInput');
            const newSearchInput = document.getElementById('searchInput');

            // 拖拽上传
            newDropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                newDropZone.classList.add('drag-active');
            });
            newDropZone.addEventListener('dragleave', () => newDropZone.classList.remove('drag-active'));
            newDropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                newDropZone.classList.remove('drag-active');
                if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
            });
            newFileInput.addEventListener('change', (e) => {
                if (e.target.files.length) handleFiles(e.target.files);
            });

            // 搜索回车
            newSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') loadImages();
            });
        }

        // 压缩图片供AI识别
        function compressImageForAI(file, maxWidth = 512) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                reader.onload = (event) => {
                    const img = new Image();
                    img.src = event.target.result;
                    img.onload = () => {
                        let width = img.width;
                        let height = img.height;
                        if (width > maxWidth) {
                            height = Math.round((height * maxWidth) / width);
                            width = maxWidth;
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        canvas.toBlob((blob) => {
                            resolve(new File([blob], 'thumb_' + file.name, { type: 'image/jpeg' }));
                        }, 'image/jpeg', 0.6);
                    };
                    img.onerror = reject;
                };
                reader.onerror = reject;
            });
        }

        // 处理上传 (带token)
        async function handleFiles(files) {
            const statusText = document.getElementById('uploadStatus');
            const total = files.length;
            let successCount = 0;
            let errorList = [];

            statusText.className = 'mt-4 text-blue-600 font-bold text-base';

            for (let i = 0; i < total; i++) {
                const file = files[i];
                statusText.innerText = \`正在处理第 \${i+1} / \${total} 张：\${file.name}...\`;

                let thumbnailFile = file;
                try {
                    thumbnailFile = await compressImageForAI(file);
                } catch (e) {
                    console.log('缩略图生成失败，使用原图', e);
                }

                const formData = new FormData();
                formData.append('file', file);
                formData.append('thumbnail', thumbnailFile);

                try {
                    const res = await fetch('/api/upload', {
                        method: 'POST',
                        headers: { 'Authorization': \`Bearer \${authToken}\` },
                        body: formData
                    });
                    const data = await res.json();
                    if (data.success) {
                        successCount++;
                        loadImages(); // 实时刷新
                    } else {
                        errorList.push(\`\${file.name}: \${data.error}\`);
                    }
                } catch (err) {
                    errorList.push(\`\${file.name}: 网络异常\`);
                }

                if (i < total - 1) {
                    statusText.innerText = '等待2秒冷却...';
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            if (errorList.length === 0) {
                statusText.className = 'mt-4 text-green-600 font-bold text-base';
                statusText.innerText = \`成功上传全部 \${successCount} 张图片。\`;
                setTimeout(() => statusText.innerText = '', 5000);
            } else {
                statusText.className = 'mt-4 text-orange-600 font-bold text-sm';
                statusText.innerHTML = \`成功 \${successCount} 张，失败 \${errorList.length} 张。<br>\${errorList.join('; ')}\`;
            }
        }

        // 加载图片 (带token)
        async function loadImages() {
            const keyword = document.getElementById('searchInput').value;
            const gallery = document.getElementById('gallery');
            gallery.innerHTML = '<p class="text-gray-500 col-span-full text-center py-10">数据加载中...</p>';

            try {
                const res = await fetch(\`/api/images?keyword=\${encodeURIComponent(keyword)}\`, {
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                if (res.status === 401) {
                    logout();
                    return;
                }
                const images = await res.json();

                gallery.innerHTML = '';
                if (images.length === 0) {
                    gallery.innerHTML = '<p class="text-gray-500 col-span-full text-center py-10">未查找到相关图片</p>';
                    return;
                }

                images.forEach(img => {
                    // 使用新样式的卡片
                    const tagsArray = img.ai_tags.split('|').map(t => t.trim()).filter(t => t);
                    const tagsHtml = tagsArray.map(t => 
                        \`<span class="tag-badge px-2 py-0.5 rounded text-[11px] font-bold text-slate-500 uppercase tracking-wider">\${t}</span>\`
                    ).join('');

                    const card = \`
                        <div class="masonry-item bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-xl group">
                            <div class="relative overflow-hidden">
                                <img src="\${img.image_url}" class="w-full h-auto block group-hover:scale-105 transition-transform duration-500">
                                <div class="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onclick="deleteImage('\${img.image_url}', this.closest('.masonry-item'))" class="p-2 bg-white/90 backdrop-blur rounded-full text-red-500 hover:bg-red-500 hover:text-white transition">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                    </button>
                                </div>
                            </div>
                            <div class="p-4">
                                <div class="flex flex-wrap gap-1.5 mb-3">
                                    \${tagsHtml}
                                </div>
                                <div class="flex justify-between items-center mt-4 pt-3 border-t border-slate-50">
                                    <span class="text-[10px] font-mono text-slate-400 uppercase">\${img.upload_time.split(' ')[0]}</span>
                                    <button onclick="copyToClipboard('\${img.image_url}', this)" class="text-xs font-bold text-blue-600 hover:text-blue-800">复制链接</button>
                                </div>
                            </div>
                        </div>
                    \`;
                    gallery.insertAdjacentHTML('beforeend', card);
                });
            } catch (err) {
                gallery.innerHTML = '<p class="text-red-500 col-span-full text-center py-10">加载失败，请重试</p>';
            }
        }

        // 复制链接
        window.copyToClipboard = function(url, btn) {
            navigator.clipboard.writeText(url);
            const original = btn.innerText;
            btn.innerText = '已复制';
            btn.classList.add('bg-green-100', 'text-green-700');
            setTimeout(() => {
                btn.innerText = original;
                btn.classList.remove('bg-green-100', 'text-green-700');
            }, 2000);
        };

        // 删除图片 (带token)
        window.deleteImage = async function(imageUrl, cardElement) {
            if (!confirm('确认永久删除该图片？')) return;

            const btn = cardElement.querySelector('.text-red-500');
            const original = btn.innerText;
            btn.innerText = '删除中...';
            btn.disabled = true;

            try {
                const res = await fetch(\`/api/delete?url=\${encodeURIComponent(imageUrl)}\`, {
                    method: 'DELETE',
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                const data = await res.json();
                if (data.success) {
                    cardElement.style.transition = 'all 0.3s';
                    cardElement.style.opacity = '0';
                    cardElement.style.transform = 'scale(0.9)';
                    setTimeout(() => cardElement.remove(), 300);
                } else {
                    alert('删除失败: ' + data.error);
                    btn.innerText = original;
                    btn.disabled = false;
                }
            } catch (err) {
                alert('删除异常');
                btn.innerText = original;
                btn.disabled = false;
            }
        };

        // 暴露函数供全局调用
        window.doLogin = doLogin;
        window.logout = logout;
    </script>
</body>
</html>`;
}
