// wris-data — wris.me 账号云端数据 API（Cloudflare Worker + D1 + R2）
// 项目数据（不含图片的 JSON）存 D1，帧图按内容哈希存 R2，部署步骤见 worker/README.md。
// 鉴权复用 auth.wris.me 的会话 Cookie（种在 .wris.me，跨子域自动携带）。
//
// 路由：
//   GET    /                 健康检查
//   GET    /projects         项目列表（含删除墓碑，供客户端做双向合并）
//   GET    /projects/:id     单个项目全文
//   PUT    /projects/:id     新建/更新项目（updatedAt 落后于云端时不覆盖）
//   DELETE /projects/:id     软删除（打墓碑，让删除在多台设备间同步）
//   GET    /img/:key         读图片（公开；key 是内容的 sha256，可永久缓存）
//   PUT    /img/:key         传图片（校验内容哈希与 key 一致）
//   POST   /img/check        批量查询尚未上传的图片 key
//   GET    /usage            当前用户的存储用量与配额

const DEFAULTS = {
  AUTH_ORIGIN: 'https://auth.wris.me',
  QUOTA_MB: 512,
  MAX_IMAGE_MB: 20,
  MAX_PROJECT_KB: 2048,
};

const MB = 1024 * 1024;
const IMAGE_KEY = /^[0-9a-f]{64}\.(jpg|png|webp|gif)$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_OF = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const SESSION_TTL = 60_000;
const TOMBSTONE_WINDOW = 90 * 24 * 3600 * 1000; // 墓碑只保留 90 天，过期视为从未存在

export function validImageKey(key) {
  return IMAGE_KEY.test(String(key || ''));
}

export function validProjectId(id) {
  return PROJECT_ID.test(String(id || ''));
}

// 允许的跨域来源：*.wris.me、本机调试，以及环境变量 ALLOWED_ORIGINS 里额外配置的来源。
// 带凭证的跨域请求不能回 *，必须逐个列出。
export function allowedOrigin(origin, env) {
  if (!origin) return false;
  let host;
  let protocol;
  try {
    ({ hostname: host, protocol } = new URL(origin));
  } catch {
    return false;
  }
  if (protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') return false;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.wris.me')) return true;
  const extra = String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

/* ---------- 鉴权：转发 Cookie 给 auth.wris.me /api/me ---------- */

const sessions = new Map(); // cookie -> { uid, exp }，Worker 实例内存缓存，减轻 auth 压力

export async function authUser(req, env) {
  const cookie = req.headers.get('cookie') || '';
  if (!cookie) return null;
  const hit = sessions.get(cookie);
  if (hit && hit.exp > Date.now()) return { id: hit.uid };

  let user = null;
  try {
    const res = await fetch((env.AUTH_ORIGIN || DEFAULTS.AUTH_ORIGIN) + '/api/me', {
      headers: { cookie },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const u = data?.user;
      // 优先用稳定 id；auth 服务没有 id 字段时退回 GitHub login
      const id = u ? (u.id ?? u.sub ?? u.login) : null;
      if (id) user = { id: String(id) };
    }
  } catch {
    /* auth 服务不可达时按未登录处理 */
  }
  if (user) {
    if (sessions.size > 500) sessions.clear();
    sessions.set(cookie, { uid: user.id, exp: Date.now() + SESSION_TTL });
  }
  return user;
}

/* ---------- 通用响应 ---------- */

function cors(req, env) {
  const origin = req.headers.get('origin');
  if (!allowedOrigin(origin, env)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(req, env, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors(req, env),
    },
  });
}

const err = (message) => ({ error: { message } });

// 浏览器发起的写请求一定带 Origin；无 Origin 视为非浏览器请求（curl 等），放行
function originAllowedForMutation(req, env) {
  const origin = req.headers.get('origin');
  return !origin || allowedOrigin(origin, env);
}

function num(env, key) {
  return Number(env[key]) || DEFAULTS[key];
}

/* ---------- 入口 ---------- */

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      const ok = allowedOrigin(req.headers.get('origin'), env);
      return new Response(null, { status: ok ? 204 : 403, headers: cors(req, env) });
    }
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/' || pathname === '/health') {
        return json(req, env, 200, { ok: true, service: 'wris-data' });
      }
      if (pathname === '/img/check') return handleCheck(req, env);
      if (pathname.startsWith('/img/')) return handleImage(req, env, pathname.slice(5));
      if (pathname === '/projects') return handleList(req, env);
      if (pathname === '/usage') return handleUsage(req, env);
      const m = pathname.match(/^\/projects\/([^/]+)$/);
      if (m) return handleProject(req, env, decodeURIComponent(m[1]));
      return json(req, env, 404, err('没有这个接口'));
    } catch (e) {
      return json(req, env, 500, err('服务内部错误：' + (e?.message || e)));
    }
  },
};

/* ---------- 图片 ---------- */

async function handleImage(req, env, key) {
  if (!validImageKey(key)) return json(req, env, 400, err('图片 key 不合法'));
  const objectKey = 'img/' + key;

  if (req.method === 'GET') {
    const obj = await env.BUCKET.get(objectKey);
    if (!obj) return json(req, env, 404, err('图片不存在'));
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType || MIME_OF[key.split('.')[1]] || 'application/octet-stream',
        // key 就是内容哈希，内容永不变更，可以永久缓存
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${key.split('.')[0]}"`,
        ...cors(req, env),
      },
    });
  }

  if (req.method === 'PUT') {
    if (!originAllowedForMutation(req, env)) return json(req, env, 403, err('来源不被允许'));
    const user = await authUser(req, env);
    if (!user) return json(req, env, 401, err('请先登录'));

    // 内容寻址：同图只存一份，重复上传直接成功
    if (await env.BUCKET.head(objectKey)) return json(req, env, 200, { ok: true, existed: true });

    const buf = await req.arrayBuffer();
    if (buf.byteLength > num(env, 'MAX_IMAGE_MB') * MB) {
      return json(req, env, 413, err('单张图片超过大小限制'));
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== key.split('.')[0]) return json(req, env, 400, err('图片内容与 key 不符'));

    const quota = num(env, 'QUOTA_MB') * MB;
    const row = await env.DB.prepare('SELECT bytes FROM usage WHERE user_id = ?').bind(user.id).first();
    if (Number(row?.bytes || 0) + buf.byteLength > quota) {
      return json(req, env, 413, err('云端空间已满，请删除一些项目后再试'));
    }

    await env.BUCKET.put(objectKey, buf, {
      httpMetadata: { contentType: MIME_OF[key.split('.')[1]] },
    });
    await env.DB.prepare(
      `INSERT INTO usage (user_id, bytes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET bytes = bytes + excluded.bytes, updated_at = excluded.updated_at`
    ).bind(user.id, buf.byteLength, Date.now()).run();
    return json(req, env, 200, { ok: true });
  }

  return json(req, env, 405, err('只支持 GET / PUT'));
}

async function handleCheck(req, env) {
  if (req.method !== 'POST') return json(req, env, 405, err('只支持 POST'));
  if (!originAllowedForMutation(req, env)) return json(req, env, 403, err('来源不被允许'));
  const user = await authUser(req, env);
  if (!user) return json(req, env, 401, err('请先登录'));

  let keys;
  try {
    keys = (await req.json())?.keys;
  } catch {
    return json(req, env, 400, err('请求解析失败'));
  }
  if (!Array.isArray(keys) || !keys.length) return json(req, env, 400, err('缺少 keys'));
  // Workers 每个请求的子请求有上限，一次最多查 40 个，客户端自行分批
  keys = keys.filter(validImageKey).slice(0, 40);

  const missing = [];
  await Promise.all(
    keys.map(async (k) => {
      if (!(await env.BUCKET.head('img/' + k))) missing.push(k);
    })
  );
  return json(req, env, 200, { missing });
}

/* ---------- 项目 ---------- */

async function handleList(req, env) {
  if (req.method !== 'GET') return json(req, env, 405, err('只支持 GET'));
  const user = await authUser(req, env);
  if (!user) return json(req, env, 401, err('请先登录'));

  const live = await env.DB.prepare(
    `SELECT id, name, updated_at, frame_count, has_story FROM projects
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 500`
  ).bind(user.id).all();
  const dead = await env.DB.prepare(
    `SELECT id, deleted_at FROM projects
     WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?
     LIMIT 500`
  ).bind(user.id, Date.now() - TOMBSTONE_WINDOW).all();

  return json(req, env, 200, {
    projects: (live.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      updatedAt: Number(r.updated_at),
      frameCount: Number(r.frame_count),
      hasStory: Boolean(r.has_story),
    })),
    deleted: (dead.results || []).map((r) => ({ id: r.id, deletedAt: Number(r.deleted_at) })),
  });
}

async function handleProject(req, env, id) {
  if (!validProjectId(id)) return json(req, env, 400, err('项目 id 不合法'));
  if (req.method !== 'GET' && !originAllowedForMutation(req, env)) {
    return json(req, env, 403, err('来源不被允许'));
  }
  const user = await authUser(req, env);
  if (!user) return json(req, env, 401, err('请先登录'));
  const uid = user.id;

  if (req.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT name, created_at, updated_at, data FROM projects WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
    ).bind(uid, id).first();
    if (!row) return json(req, env, 404, err('项目不存在'));
    let data = null;
    try {
      data = JSON.parse(row.data);
    } catch {
      /* 数据损坏时返回空数据，客户端按空项目处理 */
    }
    return json(req, env, 200, {
      name: row.name,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      data,
    });
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json(req, env, 400, err('请求解析失败'));
    }
    if (!body?.data || typeof body.data !== 'object') return json(req, env, 400, err('缺少项目数据'));

    const dataJson = JSON.stringify(body.data);
    if (dataJson.length > num(env, 'MAX_PROJECT_KB') * 1024) {
      return json(req, env, 413, err('项目数据太大，图片应先上传再引用'));
    }
    // 防御：图片必须先上传为引用（cf:hash.ext），不允许内嵌 baseURL 进 D1
    if (/data:image\//i.test(dataJson)) return json(req, env, 400, err('项目里还有内嵌图片，请先上传图片'));

    const now = Date.now();
    const updatedAt = Number(body.updatedAt) || now;
    const existing = await env.DB.prepare(
      'SELECT updated_at FROM projects WHERE user_id = ? AND id = ?'
    ).bind(uid, id).first();
    if (existing && Number(existing.updated_at) > updatedAt) {
      // 云端已是更新版本（别的设备先推了），本次过期推送不覆盖
      return json(req, env, 200, { ok: true, stale: true });
    }

    const frames = Array.isArray(body.data.frames) ? body.data.frames : [];
    const hasStory = Boolean(body.data.story && String(body.data.story.raw || '').trim());
    await env.DB.prepare(
      `INSERT INTO projects (user_id, id, name, created_at, updated_at, frame_count, has_story, data, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (user_id, id) DO UPDATE SET
         name = excluded.name,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         frame_count = excluded.frame_count,
         has_story = excluded.has_story,
         data = excluded.data,
         deleted_at = NULL`
    )
      .bind(
        uid,
        id,
        String(body.name || '未命名项目').slice(0, 120),
        Number(body.createdAt) || now,
        updatedAt,
        frames.length,
        hasStory ? 1 : 0,
        dataJson
      )
      .run();
    return json(req, env, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE projects SET deleted_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
    ).bind(Date.now(), uid, id).run();
    return json(req, env, 200, { ok: true });
  }

  return json(req, env, 405, err('只支持 GET / PUT / DELETE'));
}

/* ---------- 用量 ---------- */

async function handleUsage(req, env) {
  if (req.method !== 'GET') return json(req, env, 405, err('只支持 GET'));
  const user = await authUser(req, env);
  if (!user) return json(req, env, 401, err('请先登录'));
  const row = await env.DB.prepare('SELECT bytes FROM usage WHERE user_id = ?').bind(user.id).first();
  return json(req, env, 200, {
    used: Number(row?.bytes || 0),
    quota: num(env, 'QUOTA_MB') * MB,
  });
}
