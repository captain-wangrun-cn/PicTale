// 显影 DEVELOP — 本地服务
// 静态文件 + 一个同源的 AI 接口转发（避免浏览器跨域限制）
// 运行：node server.mjs

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 64 * 1024 * 1024; // 单张图片 base64 也够用

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(),
  });
  res.end(body);
}

// 允许局域网内其他设备 / 任意来源的页面访问
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// https://api.openai.com/v1  ->  https://api.openai.com/v1/chat/completions
function endpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少接口地址');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

async function proxy(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, MAX_BODY));
  } catch (err) {
    sendJSON(res, 400, { error: { message: '请求解析失败：' + err.message } });
    return;
  }

  const { baseUrl, apiKey, body, stream } = payload || {};
  let target;
  try {
    target = new URL(endpoint(baseUrl));
  } catch {
    sendJSON(res, 400, { error: { message: '接口地址格式不正确' } });
    return;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    sendJSON(res, 400, { error: { message: '接口地址必须以 http(s):// 开头' } });
    return;
  }
  if (!apiKey) {
    sendJSON(res, 400, { error: { message: '缺少 API Key' } });
    return;
  }

  const controller = new AbortController();
  const timer = stream ? null : setTimeout(() => controller.abort(), 180000);
  req.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const msg = err.name === 'AbortError' ? '请求超时' : '无法连接模型服务：' + err.message;
    sendJSON(res, 502, { error: { message: msg } });
    return;
  }

  if (stream && upstream.ok) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...corsHeaders(),
    });
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
    } catch {
      /* 客户端中断 */
    }
    res.end();
    return;
  }

  const text = await upstream.text();
  if (timer) clearTimeout(timer);
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(),
  });
  res.end(text);
}

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length,
      ...corsHeaders(),
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (url.pathname === '/api/health') {
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/proxy') {
      if (req.method !== 'POST') {
        sendJSON(res, 405, { error: { message: '只支持 POST' } });
        return;
      }
      await proxy(req, res);
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    sendJSON(res, 500, { error: { message: err.message } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  显影 DEVELOP  →  http://localhost:${PORT}\n`);
  const addrs = [];
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const it of list || []) {
        if (it.family === 'IPv4' && !it.internal) addrs.push(`http://${it.address}:${PORT}`);
      }
    }
  }
  if (addrs.length) {
    console.log('  局域网访问：');
    for (const a of addrs) console.log(`    ${a}`);
  }
  console.log('\n  AI 接口通过本地转发调用，Key 只保存在浏览器里。');
  console.log('  停止服务：Ctrl + C\n');
});
