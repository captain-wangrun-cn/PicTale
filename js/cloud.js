// 显影 DEVELOP — 云端同步层（Cloudflare Worker：D1 存项目、R2 存帧图）
// 本地 IndexedDB 始终是工作副本；登录后启动时做一次双向合并
// （updatedAt 新者胜，删除用墓碑收敛），编辑过程中防抖推送当前项目。
// AI 接口配置（baseUrl / apiKey）只存在本机 localStorage，与本层无关。
//
// 本文件顶层的纯函数（packProject / unpackProject / planMerge 等）
// 不依赖 DOM，可在 Node 里直接跑测试；同步引擎部分由页面调用。

import { deleteProject, getProject, listProjects, saveProject } from './store.js';

export const CLOUD_ORIGIN =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('cloud')) ||
  'https://api.wris.me';

const UPLOAD_CACHE_KEY = 'develop.cloud.uploaded'; // 本机已知已上传的图片 key
const PENDING_DELETE_KEY = 'develop.cloud.pendingDeletes'; // 未确认的本地删除，下次同步重放
const PUSH_DELAY = 4000;
const TOMBSTONE_WINDOW = 90 * 24 * 3600 * 1000; // 与服务端墓碑保留期一致

// 云端项目 JSON 里帧图的引用格式：cf:<sha256>.<ext>
const IMG_REF = /^cf:([0-9a-f]{64})\.(jpg|png|webp|gif)$/;
const EXT_OF = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export class CloudError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* 登录态与状态广播（页面通过 attachUser 注入，避免本层依赖 auth 模块） */
/* ------------------------------------------------------------------ */

let activeUser = null;
let cloudState = { status: 'off', message: '', at: 0 }; // off | syncing | ok | error
const listeners = new Set();

export function attachUser(user) {
  activeUser = user || null;
}

export function cloudSnapshot() {
  return cloudState;
}

export function onCloudState(fn) {
  listeners.add(fn);
  fn(cloudState);
  return () => listeners.delete(fn);
}

function setState(patch) {
  cloudState = { ...cloudState, ...patch };
  listeners.forEach((fn) => fn(cloudState));
}

/* ------------------------------------------------------------------ */
/* 纯函数：图片引用 / 打包 / 解包 / 合并计划                            */
/* ------------------------------------------------------------------ */

export function extOfDataUrl(dataUrl) {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
  return m ? EXT_OF[m[1].toLowerCase()] || null : null;
}

// dataURL -> 内容寻址 key：<sha256>.<ext>；不是可识别的图片 dataURL 时返回 null
export async function imageKeyOf(dataUrl) {
  const ext = extOfDataUrl(dataUrl);
  if (!ext) return null;
  const base64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  digest.forEach((b) => {
    hex += b.toString(16).padStart(2, '0');
  });
  return `${hex}.${ext}`;
}

// 会话内 dataURL -> key 缓存，避免每次保存都重算整包哈希
const keyCache = new Map();

async function keyOf(dataUrl) {
  let key = keyCache.get(dataUrl);
  if (!key) {
    key = await imageKeyOf(dataUrl);
    if (key) keyCache.set(dataUrl, key);
  }
  return key || null;
}

/**
 * 本地项目记录 -> 云端格式：帧图 dataUrl 替换为 cf: 引用，收集待上传图片。
 * 不修改传入的 record。
 */
export async function packProject(record) {
  const data = JSON.parse(JSON.stringify(record?.data || {}));
  const images = [];
  const seen = new Map(); // dataUrl -> key

  for (const frame of Array.isArray(data.frames) ? data.frames : []) {
    const url = frame?.dataUrl;
    if (typeof url !== 'string' || !url.startsWith('data:')) continue;
    let key = seen.get(url);
    if (!key) {
      key = await keyOf(url);
      if (!key) continue; // 不认识的格式原样保留（服务端会拒绝内嵌图片，同步失败下次再试）
      seen.set(url, key);
      images.push({ key, dataUrl: url });
    }
    frame.dataUrl = 'cf:' + key;
  }

  return {
    body: {
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      data,
    },
    images,
  };
}

/**
 * 云端格式 -> 本地项目记录：cf: 引用换回 dataUrl（loadImage: key -> Promise<dataUrl>）。
 * 单张图片拉取失败时退回远程 URL（refUrl 生成），图片仍可在线显示，不阻塞同步。
 */
export async function unpackProject(rec, loadImage, refUrl) {
  const data = JSON.parse(JSON.stringify(rec?.data || {}));
  const frames = Array.isArray(data.frames) ? data.frames : [];

  const refs = new Set();
  frames.forEach((f) => {
    if (typeof f?.dataUrl === 'string' && IMG_REF.test(f.dataUrl)) refs.add(f.dataUrl);
  });

  const map = new Map(
    await Promise.all(
      [...refs].map(async (ref) => {
        const key = ref.slice(3);
        return [ref, await loadImage(key).catch(() => refUrl(key))];
      })
    )
  );

  frames.forEach((f) => {
    if (map.has(f.dataUrl)) f.dataUrl = map.get(f.dataUrl);
  });

  return { name: rec.name, createdAt: rec.createdAt, updatedAt: rec.updatedAt, data };
}

/**
 * 双向合并计划。localList 是本地元信息列表，cloud 是 GET /projects 的返回
 * （{ projects: [...], deleted: [{ id, deletedAt }] }）。
 * 规则：updatedAt 新者胜；墓碑比本地新 -> 本地删；本地比墓碑新 -> 重新推上去（复活）。
 */
export function planMerge(localList, cloud) {
  const live = (cloud && cloud.projects) || [];
  const tombs = (cloud && cloud.deleted) || [];
  const local = new Map((localList || []).map((p) => [p.id, p]));
  const remote = new Map(live.map((p) => [p.id, p]));

  const plan = { pull: [], push: [], removeLocal: [] };
  const dead = new Set();

  live.forEach((p) => {
    const mine = local.get(p.id);
    if (!mine || (p.updatedAt || 0) > (mine.updatedAt || 0)) plan.pull.push(p.id);
    else if ((mine.updatedAt || 0) > (p.updatedAt || 0)) plan.push.push(p.id);
  });

  tombs.forEach((t) => {
    const mine = local.get(t.id);
    if (!mine) return;
    if ((mine.updatedAt || 0) <= (t.deletedAt || 0)) {
      dead.add(t.id);
      plan.removeLocal.push(t.id);
    }
    // 本地比墓碑新：这台设备在别处删除之后又编辑过，走下面的 push 复活
  });

  local.forEach((mine, id) => {
    if (!remote.has(id) && !dead.has(id)) plan.push.push(id);
  });

  return plan;
}

/* ------------------------------------------------------------------ */
/* 同步引擎                                                            */
/* ------------------------------------------------------------------ */

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

// 本机已上传过的图片 key（省掉重复 check），只影响请求数量，不影响正确性
const uploaded = new Set(lsGet(UPLOAD_CACHE_KEY, []));
function rememberUploaded(keys) {
  keys.forEach((k) => uploaded.add(k));
  lsSet(UPLOAD_CACHE_KEY, [...uploaded].slice(-2000));
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'include' };
  if (body !== undefined) {
    if (body instanceof Blob) {
      init.body = body;
      init.headers = { 'content-type': body.type || 'application/octet-stream' };
    } else {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
  }
  let res;
  try {
    res = await fetch(CLOUD_ORIGIN + path, init);
  } catch {
    throw new CloudError('连不上云端服务');
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应按空处理 */
    }
  }
  if (!res.ok) throw new CloudError(data?.error?.message || `云端请求失败（${res.status}）`, res.status);
  return data;
}

// 上传列表里云端还没有的图片（check 接口一次最多 40 个，分批查）
async function ensureUploaded(images) {
  const need = images.filter((i) => !uploaded.has(i.key));
  if (!need.length) return;

  const missing = new Set();
  for (let i = 0; i < need.length; i += 40) {
    const res = await api('/img/check', {
      method: 'POST',
      body: { keys: need.slice(i, i + 40).map((x) => x.key) },
    });
    (res?.missing || []).forEach((k) => missing.add(k));
  }

  const done = [];
  for (const img of need) {
    if (!missing.has(img.key)) {
      done.push(img.key);
      continue;
    }
    const blob = await (await fetch(img.dataUrl)).blob();
    await api('/img/' + img.key, { method: 'PUT', body: blob });
    done.push(img.key);
  }
  rememberUploaded(done);
}

async function loadCloudImage(key) {
  const res = await fetch(`${CLOUD_ORIGIN}/img/${key}`);
  if (!res.ok) throw new CloudError('图片下载失败', res.status);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new CloudError('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}

export async function pushProject(id) {
  const rec = await getProject(id);
  if (!rec) return false;
  const { body, images } = await packProject(rec);
  await ensureUploaded(images);
  await api('/projects/' + encodeURIComponent(id), { method: 'PUT', body });
  rememberUploaded(images.map((i) => i.key));
  return true;
}

export async function pullProject(id) {
  const rec = await api('/projects/' + encodeURIComponent(id));
  const local = await unpackProject(
    rec,
    loadCloudImage,
    (key) => `${CLOUD_ORIGIN}/img/${key}`
  );
  await saveProject(id, local);
}

/* ---------- 删除：本地记录墓碑，登录后重放，保证最终到达云端 ---------- */

export function noteDelete(id) {
  if (!id) return;
  const list = lsGet(PENDING_DELETE_KEY, []).filter((t) => t.id !== id && Date.now() - t.at < TOMBSTONE_WINDOW);
  list.push({ id, at: Date.now() });
  lsSet(PENDING_DELETE_KEY, list.slice(-200));
}

export function deleteRemote(id) {
  if (!activeUser || !id) return; // 未登录：墓碑已记，登录后的同步会重放
  api('/projects/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {
    /* 失败没关系，墓碑在，下次同步重放 */
  });
}

async function replayDeletes() {
  let tombs = lsGet(PENDING_DELETE_KEY, []).filter((t) => Date.now() - t.at < TOMBSTONE_WINDOW);
  const rest = [];
  for (const t of tombs) {
    try {
      await api('/projects/' + encodeURIComponent(t.id), { method: 'DELETE' });
    } catch {
      rest.push(t);
    }
  }
  if (rest.length !== tombs.length) lsSet(PENDING_DELETE_KEY, rest);
}

/**
 * 启动时的双向合并。需要先 attachUser。返回
 * { ok, skipped?, pulled, pushed, removed, pulledIds, errors, error? }
 */
export async function syncAll() {
  if (!activeUser) {
    setState({ status: 'off', message: '' });
    return { ok: true, skipped: 'auth', pulled: 0, pushed: 0, removed: 0, pulledIds: [], errors: [] };
  }

  setState({ status: 'syncing', message: '' });
  const summary = { ok: true, pulled: 0, pushed: 0, removed: 0, pulledIds: [], errors: [] };

  try {
    await replayDeletes();
    const cloud = await api('/projects');
    const local = await listProjects();
    const plan = planMerge(local, cloud);

    for (const id of plan.removeLocal) {
      try {
        await deleteProject(id);
        summary.removed += 1;
      } catch {
        summary.errors.push(id);
      }
    }
    for (const id of plan.pull) {
      try {
        await pullProject(id);
        summary.pulled += 1;
        summary.pulledIds.push(id);
      } catch {
        summary.errors.push(id);
      }
    }
    for (const id of plan.push) {
      try {
        if (await pushProject(id)) summary.pushed += 1;
      } catch {
        summary.errors.push(id);
      }
    }

    if (summary.errors.length) {
      setState({ status: 'error', message: `同步完成，${summary.errors.length} 项失败`, at: Date.now() });
    } else {
      setState({ status: 'ok', message: '', at: Date.now() });
    }
  } catch (err) {
    summary.ok = false;
    summary.error = err.message || '云端同步失败';
    setState({ status: 'error', message: summary.error });
  }
  return summary;
}

/* ---------- 编辑过程中的防抖推送 ---------- */

const pushTimers = new Map();

export function queuePush(id) {
  if (!activeUser || !id) return;
  clearTimeout(pushTimers.get(id));
  pushTimers.set(
    id,
    setTimeout(() => {
      pushTimers.delete(id);
      pushProject(id).then(
        () => setState({ status: 'ok', message: '', at: Date.now() }),
        (err) => setState({ status: 'error', message: err.message })
      );
    }, PUSH_DELAY)
  );
}

// 离开页面前尽力把挂着的推送发出去；失败了也没关系，下次启动合并会补上
export async function flushPushes() {
  const ids = [...pushTimers.keys()];
  pushTimers.forEach((t) => clearTimeout(t));
  pushTimers.clear();
  if (!activeUser || !ids.length) return;
  await Promise.allSettled(ids.map((id) => pushProject(id)));
}
