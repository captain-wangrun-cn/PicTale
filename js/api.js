// 显影 DEVELOP — 接口层

const CONFIG_KEY = 'develop.config.v1';

export const EMPTY_CONFIG = {
  providers: [],
  chatModel: { providerId: '', model: '' },   // 写作模型：用哪个供应商的哪个模型
  visionModel: { providerId: '', model: '' }, // 视觉模型：留空则回退写作模型
  storyImages: false,                         // 写作时是否把原图传给写作模型
};

export class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

export function providerId() {
  return 'p-' + Math.random().toString(36).slice(2, 10);
}

function normalizeProvider(p, i) {
  return {
    id: typeof p?.id === 'string' && p.id ? p.id : providerId(),
    name: String(p?.name || '').trim().slice(0, 30) || `供应商 ${i + 1}`,
    baseUrl: String(p?.baseUrl || '').trim(),
    apiKey: String(p?.apiKey || '').trim(),
  };
}

function normalizeSelection(sel) {
  return {
    providerId: String(sel?.providerId || '').trim(),
    model: String(sel?.model || '').trim(),
  };
}

// 旧版单供应商配置（baseUrl/apiKey/chatModel 为字符串）迁移为多供应商结构
function migrateLegacy(raw) {
  const providers = [];
  if (raw?.baseUrl || raw?.apiKey) {
    let name = '';
    try {
      name = new URL(raw.baseUrl).hostname;
    } catch {
      name = '';
    }
    providers.push(normalizeProvider({ name, baseUrl: raw.baseUrl, apiKey: raw.apiKey }, 0));
  }
  return {
    providers,
    chatModel: { providerId: providers[0]?.id || '', model: String(raw?.chatModel || '').trim() },
    visionModel: raw?.visionModel
      ? { providerId: providers[0]?.id || '', model: String(raw.visionModel).trim() }
      : { providerId: '', model: '' },
    storyImages: false,
  };
}

function normalizeConfig(raw) {
  if (Array.isArray(raw?.providers)) {
    return {
      providers: raw.providers.map(normalizeProvider),
      chatModel: normalizeSelection(raw.chatModel),
      visionModel: normalizeSelection(raw.visionModel),
      storyImages: Boolean(raw.storyImages),
    };
  }
  return migrateLegacy(raw);
}

export { normalizeConfig };

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...EMPTY_CONFIG };
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(normalizeConfig(config)));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

function usableProvider(config, id) {
  const providers = config?.providers || [];
  // 先找选中的；它被删掉或没填全时回退到第一个可用的，避免配置悬空
  return (
    providers.find((p) => p.id === id && p.baseUrl && p.apiKey) ||
    providers.find((p) => p.baseUrl && p.apiKey) ||
    null
  );
}

/** 写作模型最终落点：{ provider, model }；没配好时返回 null。 */
export function chatTargetOf(config) {
  const sel = normalizeSelection(config?.chatModel);
  const provider = usableProvider(config, sel.providerId);
  if (!provider || !sel.model) return null;
  return { provider, model: sel.model };
}

/** 视觉模型最终落点；供应商或模型没选全时回退写作模型。 */
export function visionTargetOf(config) {
  const sel = normalizeSelection(config?.visionModel);
  const provider = usableProvider(config, sel.providerId);
  if (provider && sel.model) return { provider, model: sel.model };
  return chatTargetOf(config);
}

export function hasApi(config) {
  return Boolean(chatTargetOf(config));
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
  return new AppError('连不上后端服务。本地开发请运行 node server.mjs；线上部署请刷新页面重试。');
}

// —— 图片压缩：尽量无损地把图片压到请求体预算以内（Vercel 函数限制 4.5MB）——
// 顺序：预算内原图直接放行；先试无损 WebP；再试不降分辨率的高质量 JPEG；
// 只有仍然超预算才降低分辨率（视觉无损 → 更低）。

const IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;
const ENCODE_STEPS = [
  { maxSide: 4096, type: 'image/webp', quality: 1 },   // 无损
  { maxSide: 4096, type: 'image/jpeg', quality: 0.9 }, // 视觉无损，保留全部分辨率
  { maxSide: 2048, type: 'image/jpeg', quality: 0.85 },
  { maxSide: 1536, type: 'image/jpeg', quality: 0.75 },
  { maxSide: 1024, type: 'image/jpeg', quality: 0.7 },
];

function dataUrlBytes(url) {
  const i = String(url).indexOf(',');
  return i < 0 ? 0 : Math.floor((url.length - i - 1) * 3 / 4);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

async function encodeDataUrl(url, { maxSide, type, quality }) {
  const img = await loadImage(url);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const encoded = canvas.toDataURL(type, quality);
  // 不支持该编码格式的浏览器会退回 PNG，跳过避免白费
  if (type !== 'image/jpeg' && !encoded.startsWith('data:' + type)) {
    throw new Error('encoding not supported');
  }
  return encoded;
}

async function fitDataUrl(url, budget = IMAGE_BUDGET_BYTES) {
  if (typeof url !== 'string' || !url.startsWith('data:image/')) return url;
  if (dataUrlBytes(url) <= budget) return url;
  let smallest = url;
  for (const step of ENCODE_STEPS) {
    try {
      const encoded = await encodeDataUrl(url, step);
      if (dataUrlBytes(encoded) <= budget) return encoded;
      if (dataUrlBytes(encoded) < dataUrlBytes(smallest)) smallest = encoded;
    } catch {
      continue;
    }
  }
  return smallest;
}

async function fitImages(messages) {
  return Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message?.content)) return message;
    const content = await Promise.all(message.content.map(async (part) => {
      if (!part?.image_url?.url) return part;
      const url = await fitDataUrl(part.image_url.url);
      return url === part.image_url.url ? part : { ...part, image_url: { ...part.image_url, url } };
    }));
    return { ...message, content };
  }));
}

// 写作带图：帧可能有很多张，整包要过代理的 4.5MB 上限，
// 按张数分摊总预算（每张至少留 180KB），交给 chat() 里的 fitImages 兜底。
const STORY_IMAGE_TOTAL_BYTES = 2.5 * 1024 * 1024;

export async function fitStoryImages(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter(
    (u) => typeof u === 'string' && u.startsWith('data:image/')
  );
  if (!list.length) return [];
  const budget = Math.max(180 * 1024, Math.floor(STORY_IMAGE_TOTAL_BYTES / list.length));
  return Promise.all(list.map((url) => fitDataUrl(url, budget)));
}

/**
 * 调用 OpenAI 兼容的 /chat/completions。
 * provider 缺省时取写作模型配置的供应商；流式时通过 onDelta 增量回调，返回完整文本。
 */
export async function chat({
  config,
  provider,
  model,
  messages,
  stream = false,
  onDelta,
  signal,
  temperature = 0.7,
  maxTokens,
}) {
  const target =
    provider && provider.baseUrl && provider.apiKey
      ? provider
      : chatTargetOf(config)?.provider;
  if (!target?.baseUrl) throw new AppError('还没有配置供应商。点右上角「设置」。');
  if (!target?.apiKey) throw new AppError('这个供应商还没填 API Key。点右上角「设置」。');
  if (!model) throw new AppError('还没有填模型名称。点右上角「设置」。');

  const body = { model, messages: await fitImages(messages), temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;

  let res;
  try {
    res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: target.baseUrl, apiKey: target.apiKey, body, stream }),
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
  const target = chatTargetOf(config);
  if (!target) throw new AppError('先选一个供应商并填好它的接口地址、API Key，再填写作模型。');
  const reply = await chat({
    config,
    provider: target.provider,
    model: target.model,
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    temperature: 0,
    maxTokens: 12,
  });
  return String(reply).trim().slice(0, 40);
}
