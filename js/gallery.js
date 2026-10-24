// 显影 DEVELOP — 画册页
// 左侧项目列表，右侧展示选中项目的图片与故事（图片在左、对应段落文字在右）。
// 上一个/下一个按钮与 ↑↓ 方向键可在多个项目之间快速切换。

import { getProject, listProjects } from './store.js';
import { injectAnchors, parseStory } from './story-format.js';
import { mdToHtml } from './markdown.js';
import { attachUser, syncAll } from './cloud.js';
import { fetchWrisUser } from './wris-auth.js';

const pad = (n) => String(n).padStart(2, '0');

const navEl = document.getElementById('galNav');
const countEl = document.getElementById('galCount');
const viewEl = document.getElementById('galView');
const emptyEl = document.getElementById('galleryEmpty');
const posEl = document.getElementById('galPos');
const prevBtn = document.getElementById('galPrev');
const nextBtn = document.getElementById('galNext');

const metas = [];
const cache = new Map(); // id -> 完整项目记录
let current = 0;

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function frameKeyOf(i) {
  return `F${pad(i + 1)}`;
}

function buildFig(frame, i) {
  const fig = el('figure', 'gal-fig');
  const img = el('img');
  img.src = frame.dataUrl;
  img.alt = frame.name || `第 ${i + 1} 帧`;
  img.loading = 'lazy';
  fig.append(img, el('figcaption', 'gal-no', frameKeyOf(i)));
  return fig;
}

/* ---------- 项目卡片 ---------- */

function firstThumb(data) {
  const frames = Array.isArray(data?.frames) ? data.frames : [];
  return frames[0]?.dataUrl || '';
}

function buildCard(meta, rec) {
  const data = rec?.data || {};
  const frames = Array.isArray(data.frames) ? data.frames : [];
  const raw = data.story?.raw || '';
  const has = raw.trim().length > 0;
  let parsed = parseStory(raw);
  // 旧项目的故事可能没有帧锚点：按帧数补注后再逐帧配对
  if (has && !parsed.sections.length && frames.length) {
    parsed = parseStory(injectAnchors(raw, frames.length));
  }

  const card = el('article', 'gal-project');
  card.append(el('h2', 'gal-name', meta.name || '未命名项目'));
  card.append(
    el(
      'p',
      'gal-meta',
      `${frames.length} 帧 · ${has ? '已生成故事' : '未生成故事'} · 更新于 ${fmtTime(meta.updatedAt)}`
    )
  );

  if (!has) {
    // 没有故事时只放图片墙
    const wall = el('div', 'gal-wall');
    frames.forEach((frame, i) => wall.append(buildFig(frame, i)));
    card.append(wall);
    return card;
  }

  if (parsed.title) card.append(el('h3', 'gal-title', parsed.title));
  if (parsed.intro) {
    const intro = el('div', 'gal-story gal-intro');
    intro.innerHTML = mdToHtml(parsed.intro);
    card.append(intro);
  }

  const byKey = new Map(parsed.sections.map((s) => [s.frame, s]));
  const used = new Set();

  frames.forEach((frame, i) => {
    const key = frameKeyOf(i);
    const sec = byKey.get(key) || parsed.sections[i] || null;
    if (sec) used.add(sec);

    const row = el('div', 'gal-row');

    // 文字在左，图片在右
    const text = el('div', 'gal-story');
    if (sec?.text) text.innerHTML = mdToHtml(sec.text);
    row.append(text);
    row.append(buildFig(frame, i));

    card.append(row);
  });

  // 段落比帧多时（模型跨锚点写作），剩下的段落按文字排在最后
  parsed.sections.forEach((sec) => {
    if (used.has(sec)) return;
    const text = el('div', 'gal-story gal-solo');
    text.innerHTML = mdToHtml(sec.text);
    card.append(text);
  });

  return card;
}

/* ---------- 切换与渲染 ---------- */

async function show(index) {
  current = Math.max(0, Math.min(metas.length - 1, index));
  const meta = metas[current];
  if (!meta) return;

  let rec = cache.get(meta.id);
  if (!rec) {
    rec = await getProject(meta.id);
    if (rec) cache.set(meta.id, rec);
  }

  viewEl.innerHTML = '';
  viewEl.append(buildCard(meta, rec || { data: {} }));

  $$('.gal-item', navEl).forEach((li, i) => li.classList.toggle('is-active', i === current));
  posEl.textContent = `${current + 1} / ${metas.length}`;
  prevBtn.disabled = current <= 0;
  nextBtn.disabled = current >= metas.length - 1;
  document.querySelector('.gallery-main').scrollTop = 0;
}

function buildNav() {
  navEl.innerHTML = '';
  metas.forEach((meta, i) => {
    const li = el('li', 'gal-item');
    li.dataset.index = String(i);
    const thumb = firstThumb(cache.get(meta.id)?.data);
    if (thumb) {
      const img = el('img', 'gal-item-thumb');
      img.src = thumb;
      img.alt = '';
      img.loading = 'lazy';
      li.append(img);
    }
    const main = el('div', 'gal-item-main');
    main.append(el('b', 'gal-item-name', meta.name || '未命名项目'));
    main.append(
      el('span', 'gal-item-meta', `${meta.frameCount || 0} 帧 · ${fmtTime(meta.updatedAt)}`)
    );
    li.append(main);
    navEl.append(li);
  });
  countEl.textContent = String(metas.length);
}

async function init() {
  const list = await listProjects();
  metas.push(...list);
  buildNav();
  bindNav();

  if (!metas.length) {
    emptyEl.hidden = false;
    posEl.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    await show(0);
  }

  syncFromCloud();
}

function bindNav() {
  navEl.addEventListener('click', (e) => {
    const li = e.target.closest('.gal-item');
    if (li) show(Number(li.dataset.index));
  });
  prevBtn.addEventListener('click', () => show(current - 1));
  nextBtn.addEventListener('click', () => show(current + 1));
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(current + 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      show(current - 1);
    }
  });
}

// 云端同步：登录用户的项目拉进本地存档后刷新列表；失败不影响本地画册
async function syncFromCloud() {
  try {
    const user = await fetchWrisUser();
    if (!user) return;
    attachUser(user);
    const summary = await syncAll();
    if (!summary.ok || !(summary.pulled || summary.removed)) return;
    metas.length = 0;
    metas.push(...(await listProjects()));
    cache.clear();
    buildNav();
    emptyEl.hidden = metas.length > 0;
    await show(Math.min(current, Math.max(0, metas.length - 1)));
  } catch {
    /* 云端不可用时保持本地列表 */
  }
}

init();
