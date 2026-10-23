// 显影 DEVELOP — 接口层

const CONFIG_KEY = 'develop.config.v1';

export const EMPTY_CONFIG = {
  baseUrl: '',
  apiKey: '',
  chatModel: '',
  visionModel: '',
};

export class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...EMPTY_CONFIG };
    return { ...EMPTY_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

export function hasApi(config) {
  return Boolean(config?.baseUrl && config?.apiKey && config?.chatModel);
}

export function visionModelOf(config) {
  return config?.visionModel?.trim() || config?.chatModel?.trim() || '';
}

export async function checkServer() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function hintFor(status) {
  switch (status) {
    case 400:
      return '请求被拒绝（400）。常见原因：模型不支持图片输入，或者模型名写错。';
    case 401:
      return 'API Key 无效或没有权限（401）。检查 Key 是否填错、是否过期。';
    case 403:
      return '没有访问权限（403）。可能这个 Key 不支持当前模型。';
    case 404:
      return '找不到接口（404）。接口地址可能少了 /v1，或者模型名不存在。';
    case 413:
      return '图片太大，被服务端拒绝（413）。换一张小一点的图。';
    case 422:
      return '请求参数不被接受（422）。检查模型是否支持图片输入。';
    case 429:
      return '请求太频繁或额度不足（429）。稍等一会儿再试。';
    default:
      return status >= 500
        ? `模型服务出错（${status}）。可以稍后重试，或换一个模型。`
        : `请求失败（${status}）。`;
  }
}

function serverMessage(text) {
  if (!text) return '';
  try {
    const data = JSON.parse(text);
    const msg = data?.error?.message || data?.message || data?.error;
    return typeof msg === 'string' ? msg : '';
  } catch {
    return String(text).slice(0, 240);
  }
}

function httpError(status, text) {
  const extra = serverMessage(text);
  return new AppError(hintFor(status) + (extra ? ` 服务端说：${extra}` : ''));
}

function networkError() {
  if (location.protocol === 'file:') {
    return new AppError('页面是以文件方式打开的。请运行 node server.mjs，再用 http://127.0.0.1:5173 打开。');
  }
  return new AppError('连不上本地服务。确认 node server.mjs 还在运行，然后刷新页面。');
}

/**
 * 调用 OpenAI 兼容的 /chat/completions。
 * 流式时通过 onDelta 增量回调，返回完整文本。
 */
export async function chat({
  config,
  messages,
  model,
  stream = false,
  onDelta,
  signal,
  temperature = 0.7,
  maxTokens,
}) {
  if (!config?.baseUrl) throw new AppError('还没有填接口地址。点右上角「设置」。');
  if (!config?.apiKey) throw new AppError('还没有填 API Key。点右上角「设置」。');
  if (!model) throw new AppError('还没有填模型名称。点右上角「设置」。');

  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;

  let res;
  try {
    res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey, body, stream }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw networkError();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw httpError(res.status, text);
  }

  if (!stream) {
    let data;
    try {
      data = await res.json();
    } catch {
      throw new AppError('模型返回的不是 JSON。检查接口地址是否指向 OpenAI 兼容服务。');
    }
    if (data?.error) {
      throw new AppError('模型返回错误：' + (data.error.message || JSON.stringify(data.error)));
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => p?.text || '').join('');
    return '';
  }

  return readStream(res, onDelta);
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return full;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json?.error) {
        throw new AppError('模型返回错误：' + (json.error.message || '未知错误'));
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }
  return full;
}

export async function testConnection(config) {
  const reply = await chat({
    config,
    model: config.chatModel,
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    temperature: 0,
    maxTokens: 12,
  });
  return String(reply).trim().slice(0, 40);
}
