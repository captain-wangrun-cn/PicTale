// AI 接口转发 — 同源代理，避免浏览器跨域限制
// 浏览器把 baseUrl / apiKey / 请求体一起发过来，Key 只保存在用户浏览器里

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

// https://api.openai.com/v1  ->  https://api.openai.com/v1/chat/completions
function endpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('缺少接口地址');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

export const maxDuration = 300;

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: { message: '只支持 POST' } });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (err) {
    return json(400, { error: { message: '请求解析失败：' + err.message } });
  }

  const { baseUrl, apiKey, body, stream } = payload || {};
  let target;
  try {
    target = new URL(endpoint(baseUrl));
  } catch {
    return json(400, { error: { message: '接口地址格式不正确' } });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json(400, { error: { message: '接口地址必须以 http(s):// 开头' } });
  }
  if (!apiKey) {
    return json(400, { error: { message: '缺少 API Key' } });
  }

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
    });
  } catch (err) {
    return json(502, { error: { message: '无法连接模型服务：' + err.message } });
  }

  if (stream && upstream.ok) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        ...CORS,
      },
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}
