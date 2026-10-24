// 显影 DEVELOP — 界面逻辑

import {
  AppError,
  chat,
  chatTargetOf,
  checkServer,
  fitStoryImages,
  hasApi,
  loadConfig,
  providerId,
  saveConfig,
  testConnection,
  visionTargetOf,
} from './api.js';
import { escapeHtml, mdToHtml } from './markdown.js';
import {
  DEFAULT_SETTINGS,
  EMPHASIS,
  MODES,
  POVS,
  PROMPT_PRESETS,
  STYLES,
  normalizeSettings,
  TYPES,
  continuityMessages,
  extractMessages,
  supplementMessages,
  rewriteMessages,
  storyMessages,
} from './prompts.js';
import {
  buildBrief,
  buildFrameBrief,
  buildStoryContext,
  buildTimeline,
  injectAnchors,
  parseStory,
  rebuildStory,
  stripStoryAnchors,
} from './story-format.js';
import {
  checkStorage,
  deleteProject,
  getProject,
  listProjects,
  loadLegacy,
  removeLegacy,
  renameProject,
  saveProject,
} from './store.js';
import { fetchWrisUser } from './wris-auth.js';
import {
  attachUser,
  cloudSnapshot,
  deleteRemote,
  flushPushes,
  noteDelete,
  onCloudState,
  queuePush,
  syncAll,
} from './cloud.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2, 10));
const pad = (n) => String(n).padStart(2, '0');
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round3 = (n) => Math.round(n * 1000) / 1000;

function focusSoon(selector) {
  requestAnimationFrame(() => {
    const el = typeof selector === 'string' ? $(selector) : selector;
    el?.focus?.();
  });
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  projectId: null,
  projectName: '',
  projectNamed: false,
  frames: [],
  activeId: null,
  focusId: null,
  filter: 'all',
  showBoxes: true,
  story: { raw: '', status: 'idle', error: '', sample: false, updatedAt: 0 },
  settings: { ...DEFAULT_SETTINGS },
  config: loadConfig(),
  panel: 'stage',
  serverOk: true,
  busy: false,
};

const ui = {
  projectCreatedAt: null,
  nameMode: 'save',
  nameTarget: null,
  editing: null,
  adding: false,
  hoverDetailId: null,
  dragId: null,
  genAbort: null,
  storyTimer: null,
  saveTimer: null,
};

const els = {
  frameCount: $('#frameCount'),
  frameList: $('#frameList'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  sampleBtn: $('#sampleBtn'),
  clearBtn: $('#clearBtn'),

  stageMeta: $('#stageMeta'),
  viewerPin: $('#viewerPin'),
  viewerEmpty: $('#viewerEmpty'),
  viewerFrame: $('#viewerFrame'),
  stageImage: $('#stageImage'),
  imgWrap: $('#imgWrap'),
  boxes: $('#boxes'),
  boxToggle: $('#boxToggle'),
  viewerNote: $('#viewerNote'),
  frameNote: $('#frameNote'),
  stageSummary: $('#stageSummary'),

  extractOneBtn: $('#extractOneBtn'),
  extractAllBtn: $('#extractAllBtn'),
  filterRow: $('#filterRow'),
  meter: $('#meter'),
  meterBar: $('#meterBar'),
  meterLegend: $('#meterLegend'),
  detailList: $('#detailList'),
  addDetail: $('#addDetail'),

  wordCount: $('#wordCount'),
  paperScroll: $('#paperScroll'),
  paperKicker: $('#paperKicker'),
  paperMeta: $('#paperMeta'),
  paperEmpty: $('#paperEmpty'),
  story: $('#story'),

  modeRow: $('.mode-row'),
  modeHint: $('#modeHint'),
  povSelect: $('#povSelect'),
  lengthSelect: $('#lengthSelect'),
  styleSelect: $('#styleSelect'),
  styleHint: $('#styleHint'),
  presetSelect: $('#presetSelect'),
  customPrompt: $('#customPrompt'),
  storyStale: $('#storyStale'),
  generateBtn: $('#generateBtn'),
  copyBtn: $('#copyBtn'),
  exportBtn: $('#exportBtn'),
  clearStoryBtn: $('#clearStoryBtn'),

  connBtn: $('#connBtn'),
  connText: $('#connText'),
  settingsBtn: $('#settingsBtn'),
  settings: $('#settings'),
  settingsForm: $('#settingsForm'),
  cfgProviders: $('#cfgProviders'),
  cfgAddProvider: $('#cfgAddProvider'),
  cfgChatProvider: $('#cfgChatProvider'),
  cfgVisionProvider: $('#cfgVisionProvider'),
  cfgChat: $('#cfgChat'),
  cfgVision: $('#cfgVision'),
  cfgStoryImages: $('#cfgStoryImages'),
  testBtn: $('#testBtn'),
  testStatus: $('#testStatus'),
  cancelCfg: $('#cancelCfg'),

  saveBtn: $('#saveBtn'),
  projChip: $('#projChip'),
  projChipName: $('#projChipName'),
  projectsDlg: $('#projectsDlg'),
  projectList: $('#projectList'),
  newProjectBtn: $('#newProjectBtn'),
  dupProjectBtn: $('#dupProjectBtn'),
  closeProjects: $('#closeProjects'),
  nameDlg: $('#nameDlg'),
  nameForm: $('#nameForm'),
  nameTitle: $('#nameTitle'),
  nameInput: $('#nameInput'),
  nameCancel: $('#nameCancel'),
  nameConfirm: $('#nameConfirm'),

  cloudState: $('#cloudState'),

  tabs: $('#tabs'),
  workspace: $('#workspace'),
  stage: $('#stage'),
  toast: $('#toast'),
};

const activeFrame = () => state.frames.find((f) => f.id === state.activeId) || null;
const frameIndex = (frame) => state.frames.indexOf(frame);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  bindEvents();
  renderConn();
  renderAll();

  await openLastProject();

  if (!state.frames.length && new URLSearchParams(location.search).has('sample')) {
    await loadSample({ silent: true });
  }

  state.serverOk = await checkServer();
  renderConn();
  renderAll();

  if (!state.serverOk) {
    showToast('后端服务没有响应。本地开发请运行 node server.mjs；线上部署请刷新页面重试。', true, 8000);
    initCloud(); // 云端同步只依赖账号服务，不依赖本站后端
    return;
  }
  const storageErr = await checkStorage();
  if (storageErr) {
    showToast(`浏览器存档不可用：${storageErr}`, true, 9000);
  }
  initCloud();
}

function restore(saved) {
  if (!saved || !Array.isArray(saved.frames)) return;
  state.frames = saved.frames.map((f) => ({
    ...f,
    details: Array.isArray(f.details) ? f.details : [],
    status: f.details?.length ? 'done' : 'idle',
    error: '',
  }));
  state.activeId = state.frames.some((f) => f.id === saved.activeId)
    ? saved.activeId
    : state.frames[0]?.id || null;
  state.settings = normalizeSettings(saved.settings);
  state.story = { raw: '', status: 'idle', error: '', sample: false, updatedAt: 0 };
  if (saved.story && typeof saved.story.raw === 'string') {
    state.story = {
      ...state.story,
      ...saved.story,
      status: saved.story.status === 'streaming' ? 'done' : saved.story.status || 'idle',
      error: '',
    };
  }
}

/* ------------------------------------------------------------------ */
/* projects                                                            */
/* ------------------------------------------------------------------ */

const LAST_KEY = 'develop.lastProject';

// localStorage 在部分环境（隐私模式、嵌入式 webview）会直接抛错，统一兜底
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 存不了就算了 */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};

function defaultProjectName(source = state) {
  const title = parseStory(source.story?.raw || '').title;
  if (title) return title.slice(0, 24);
  const first = Array.isArray(source.frames) ? source.frames[0] : null;
  if (first?.name) return String(first.name).slice(0, 24);
  return '未命名项目';
}

function applyProject(id, rec) {
  state.projectId = id;
  state.projectName = rec?.name || '未命名项目';
  ui.projectCreatedAt = rec?.createdAt || Date.now();
  restore(rec?.data || {});
  renderProjectBar();
}

async function openLastProject() {
  const lastId = ls.get(LAST_KEY);
  if (lastId) {
    const rec = await getProject(lastId);
    if (rec) {
      applyProject(lastId, rec);
      return;
    }
    ls.remove(LAST_KEY);
  }

  // 旧版本只有一份自动存档，迁移成第一个项目
  const legacy = await loadLegacy();
  if (legacy && Array.isArray(legacy.frames) && legacy.frames.length) {
    const id = uid();
    const rec = {
      name: defaultProjectName(legacy),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      data: {
        version: 2,
        frames: legacy.frames,
        activeId: legacy.activeId,
        settings: legacy.settings,
        story: legacy.story,
      },
    };
    if (await saveProject(id, rec)) {
      applyProject(id, rec);
      ls.set(LAST_KEY, id);
    }
    await removeLegacy();
  }
}

function renderProjectBar() {
  const name = state.projectName || '未命名项目';
  els.projChipName.textContent = name;
  els.projChip.title = `当前项目「${name}」，点击管理`;
  els.saveBtn.title = state.projectNamed
    ? `保存「${name}」（Ctrl S）`
    : '命名并保存当前项目（Ctrl S）';
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function persist() {
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(flushProject, 400);
}

async function flushProject() {
  ui.saveTimer = null;
  cloudDirty = true;
  if (!state.projectId) {
    // 工作区第一次有内容时，自动建一个项目档案
    if (!state.frames.length && !(state.story.raw || '').trim() &&
        JSON.stringify(state.settings) === JSON.stringify(DEFAULT_SETTINGS)) return false;
    state.projectId = uid();
    state.projectName = state.projectName || defaultProjectName();
    ui.projectCreatedAt = Date.now();
    renderProjectBar();
  }
  const ok = await saveProject(state.projectId, {
    name: state.projectName || '未命名项目',
    createdAt: ui.projectCreatedAt || Date.now(),
    updatedAt: Date.now(),
    data: {
      version: 2,
      frames: state.frames,
      activeId: state.activeId,
      settings: state.settings,
      story: {
        ...state.story,
        status: state.story.status === 'streaming' ? 'done' : state.story.status,
      },
    },
  });
  if (ok) {
    ls.set(LAST_KEY, state.projectId);
    if (els.projectsDlg.open) renderProjectList();
    queuePush(state.projectId); // 已登录时防抖推送云端；未登录内部直接跳过
  }
  return ok;
}

/* ------------------------------------------------------------------ */
/* cloud sync                                                          */
/* ------------------------------------------------------------------ */

// 本次会话是否动过当前项目：没动过时，启动同步拉到的新版本可以直接套用
let cloudDirty = false;

async function initCloud() {
  const user = await fetchWrisUser();
  attachUser(user);
  onCloudState(renderCloudState);
  renderCloudState(cloudSnapshot());
  if (!user) return;

  const summary = await syncAll();
  if (!summary.ok) {
    showToast(`云端同步失败：${summary.error}`, true, 6000);
    return;
  }

  // 当前项目被拉成了新版本、且这次会话还没编辑过，直接套用云端内容
  if (state.projectId && summary.pulledIds.includes(state.projectId) && !cloudDirty) {
    const rec = await getProject(state.projectId);
    if (rec) {
      applyProject(state.projectId, rec);
      renderAll();
    }
  }
  if (els.projectsDlg.open) renderProjectList();
  if (summary.pulled) {
    showToast(`已从云端同步 ${summary.pulled} 个项目。`);
  } else if (summary.removed) {
    showToast(`云端删除已同步（${summary.removed} 个项目）。`);
  }
}

function renderCloudState(cs) {
  const el = els.cloudState;
  if (!el) return;
  if (cs.status === 'off') {
    el.textContent = '未登录 · 项目只保存在本机浏览器';
    el.className = 'cloud-state';
  } else if (cs.status === 'syncing') {
    el.textContent = '正在与账号云端同步…';
    el.className = 'cloud-state';
  } else if (cs.status === 'ok') {
    el.textContent = cs.at ? `已同步到账号云端 · ${fmtTime(cs.at)}` : '已同步到账号云端';
    el.className = 'cloud-state is-ok';
  } else {
    el.textContent = `云端同步失败：${cs.message || '未知错误'}`;
    el.className = 'cloud-state is-err';
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderProjectBar();
  renderFrames();
  renderViewer();
  renderLedger();
  renderStory();
  renderComposer();
  renderConn();
  renderTabs();
}

function renderTabs() {
  els.workspace.dataset.panel = state.panel;
  $$('.tab', els.tabs).forEach((tab) => {
    const on = tab.dataset.panel === state.panel;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function renderFrames() {
  els.frameCount.textContent = pad(state.frames.length);
  els.frameList.innerHTML = '';

  state.frames.forEach((frame, i) => {
    const li = document.createElement('li');
    li.className = 'frame' + (frame.id === state.activeId ? ' is-active' : '');
    li.dataset.id = frame.id;
    li.draggable = true;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', frame.id === state.activeId ? 'true' : 'false');
    li.setAttribute('aria-label', `第 ${i + 1} 帧：${frame.name}`);

    const img = document.createElement('img');
    img.className = 'frame-thumb';
    img.src = frame.dataUrl;
    img.alt = '';
    img.draggable = false;
    li.append(img);

    const bar = document.createElement('div');
    bar.className = 'frame-bar';

    const no = document.createElement('span');
    no.className = 'frame-no';
    no.textContent = `F${pad(i + 1)}`;
    bar.append(no);

    if (frame.status === 'extracting') {
      const st = document.createElement('span');
      st.className = 'frame-state is-busy';
      st.textContent = '识别中';
      bar.append(st);
    } else if (frame.status === 'error') {
      const st = document.createElement('span');
      st.className = 'frame-state';
      st.textContent = '失败';
      st.title = frame.error || '';
      bar.append(st);
    } else {
      const dots = document.createElement('span');
      dots.className = 'frame-dots';
      const list = frame.details.slice(0, 8);
      if (!list.length) {
        for (let k = 0; k < 3; k += 1) dots.append(document.createElement('i'));
      } else {
        list.forEach((d) => {
          const dot = document.createElement('i');
          if (d.emphasis === 'expand') dot.className = 'e';
          else if (d.emphasis === 'mention') dot.className = 'm';
          dots.append(dot);
        });
      }
      bar.append(dots);
    }

    li.append(bar);

    const actions = document.createElement('div');
    actions.className = 'frame-actions';
    actions.innerHTML =
      '<button type="button" data-act="up" title="前移" aria-label="前移">↑</button>' +
      '<button type="button" data-act="down" title="后移" aria-label="后移">↓</button>' +
      '<button type="button" data-act="remove" title="移除这一帧" aria-label="移除这一帧">×</button>';
    li.append(actions);

    els.frameList.append(li);
  });
}

function renderViewer() {
  const frame = activeFrame();
  const has = Boolean(frame);

  els.viewerEmpty.hidden = has;
  els.viewerFrame.hidden = !has;
  els.viewerNote.hidden = !has;

  if (!has) {
    els.stageMeta.textContent = '—';
    els.stageSummary.textContent = '';
    els.stageSummary.classList.add('is-empty');
    els.boxes.innerHTML = '';
    return;
  }

  els.stageImage.src = frame.dataUrl;
  els.stageImage.alt = frame.name;
  els.stageMeta.textContent = `F${pad(frameIndex(frame) + 1)} / ${pad(state.frames.length)}`;

  if (document.activeElement !== els.frameNote) els.frameNote.value = frame.note || '';

  let summary = '';
  let empty = false;
  if (frame.status === 'extracting') {
    summary = '正在识别这一帧的细节…';
  } else if (frame.status === 'error') {
    summary = `识别失败：${frame.error || '未知错误'}`;
  } else if (frame.summary) {
    summary = frame.summary;
  } else {
    summary = '还没有识别这一帧。点下面的「识别这一帧」。';
    empty = true;
  }
  els.stageSummary.textContent = summary;
  els.stageSummary.classList.toggle('is-empty', empty);

  renderBoxes(frame);
}

function renderBoxes(frame) {
  els.boxes.innerHTML = '';
  els.boxes.classList.toggle('is-show-all', state.showBoxes);
  frame.details.forEach((d) => {
    if (!Array.isArray(d.box)) return;
    const [x, y, w, h] = d.box;
    const box = document.createElement('div');
    box.className = 'box';
    box.dataset.id = d.id;
    box.style.left = `${x * 100}%`;
    box.style.top = `${y * 100}%`;
    box.style.width = `${w * 100}%`;
    box.style.height = `${h * 100}%`;

    const label = document.createElement('span');
    label.className = 'box-label' + (y < 0.09 ? ' is-below' : '');
    label.textContent = `${TYPES[d.type]?.label || ''} · ${d.title}`;
    box.append(label);

    els.boxes.append(box);
  });
  applyBoxFocus();
}

function applyBoxFocus() {
  const frame = activeFrame();
  if (!frame) return;
  const id = ui.hoverDetailId || state.focusId;
  const detail = id ? frame.details.find((d) => d.id === id && Array.isArray(d.box)) : null;
  $$('.box', els.boxes).forEach((el) => {
    el.classList.toggle('is-on', Boolean(detail) && el.dataset.id === detail.id);
  });
}

function emphasisCounts(details) {
  const c = { skip: 0, mention: 0, expand: 0 };
  details.forEach((d) => {
    c[d.emphasis] = (c[d.emphasis] || 0) + 1;
  });
  return c;
}

function renderLedger() {
  const frame = activeFrame();
  const details = frame ? frame.details : [];

  renderFilters(frame, details);

  els.extractOneBtn.disabled = !frame || state.busy;
  els.extractAllBtn.disabled = state.busy || state.frames.length === 0;

  if (!details.length) {
    els.meter.hidden = true;
  } else {
    els.meter.hidden = false;
    const counts = emphasisCounts(details);
    els.meterBar.innerHTML = details
      .map((d) => {
        const cls = d.emphasis === 'expand' ? 'e' : d.emphasis === 'mention' ? 'm' : '';
        return `<i class="${cls}" title="${escapeHtml(d.title)}"></i>`;
      })
      .join('');
    els.meterLegend.innerHTML =
      `<span class="lg-e">展 <b>${counts.expand}</b></span>` +
      `<span class="lg-m">提 <b>${counts.mention}</b></span>` +
      `<span class="lg-s">略 <b>${counts.skip}</b></span>` +
      '<span class="lg-hint">点细节可在图上定位</span>';
  }

  els.detailList.innerHTML = '';

  if (!frame) {
    const empty = document.createElement('li');
    empty.className = 'ledger-empty';
    empty.innerHTML = '还没选中画面。<b>放几张图片</b>，或者点「载入示例」。';
    els.detailList.append(empty);
    renderAddDetail();
    return;
  }

  if (!details.length) {
    const empty = document.createElement('li');
    empty.className = 'ledger-empty';
    if (frame.status === 'extracting') {
      empty.innerHTML = '正在读这一帧……';
    } else {
      empty.innerHTML =
        '这一帧还没识别过，点<b>识别这一帧</b>。结果不对的直接点开改。';
    }
    els.detailList.append(empty);
    renderAddDetail();
    return;
  }

  const visible = state.filter === 'all' ? details : details.filter((d) => d.type === state.filter);

  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'ledger-empty';
    empty.innerHTML = '这个类型下没有细节。<button class="link-btn" type="button" data-act="clear-filter">看全部</button>';
    els.detailList.append(empty);
    renderAddDetail();
    return;
  }

  visible.forEach((d) => els.detailList.append(buildDetailRow(d)));
  renderAddDetail();
}

function renderFilters(frame, details) {
  els.filterRow.innerHTML = '';
  if (!frame) return;

  const counts = {};
  details.forEach((d) => {
    counts[d.type] = (counts[d.type] || 0) + 1;
  });

  const make = (key, label, count) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip' + (state.filter === key ? ' is-active' : '');
    btn.dataset.filter = key;
    btn.innerHTML = `${label}<i>${count}</i>`;
    btn.setAttribute('aria-pressed', state.filter === key ? 'true' : 'false');
    return btn;
  };

  els.filterRow.append(make('all', '全部', details.length));
  Object.keys(TYPES).forEach((key) => {
    if (!counts[key]) return;
    els.filterRow.append(make(key, TYPES[key].label, counts[key]));
  });
}

function buildDetailRow(d) {
  const li = document.createElement('li');
  li.className = `detail type-${d.type}` + (state.focusId === d.id ? ' is-focus' : '');
  li.dataset.id = d.id;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'type-chip';
  chip.dataset.act = 'focus';
  chip.title = `${TYPES[d.type]?.label || '细节'} · 在图上定位`;
  chip.setAttribute('aria-label', `${TYPES[d.type]?.label || '细节'}，在图上定位`);
  chip.textContent = TYPES[d.type]?.glyph || '·';
  li.append(chip);

  const main = document.createElement('div');
  main.className = 'detail-main';

  if (ui.editing === d.id) {
    main.append(buildEditForm(d));
  } else {
    const title = document.createElement('span');
    title.className = 'detail-title';
    title.dataset.act = 'focus';
    title.textContent = d.title;
    main.append(title);

    const note = document.createElement('p');
    note.className = 'detail-note';
    note.innerHTML =
      (d.confidence === 'inferred' ? '<span class="tag-inferred">推测</span>' : '') +
      escapeHtml(d.note || '');
    main.append(note);

    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    actions.innerHTML =
      '<button class="link-btn" type="button" data-act="edit">编辑</button>' +
      '<button class="link-btn is-danger" type="button" data-act="remove">删除</button>';
    main.append(actions);
  }
  li.append(main);

  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '讲解力度');
  Object.entries(EMPHASIS).forEach(([key, meta]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.em = key;
    btn.textContent = meta.label;
    btn.title = `${meta.word}：${meta.hint}`;
    btn.setAttribute('aria-pressed', d.emphasis === key ? 'true' : 'false');
    seg.append(btn);
  });
  li.append(seg);

  li.addEventListener('mouseenter', () => {
    ui.hoverDetailId = d.id;
    applyBoxFocus();
  });
  li.addEventListener('mouseleave', () => {
    ui.hoverDetailId = null;
    applyBoxFocus();
  });

  return li;
}

function buildEditForm(d) {
  const form = document.createElement('div');
  form.className = 'detail-edit';
  form.dataset.id = d.id;
  form.innerHTML =
    `<input data-field="title" maxlength="20" value="${escapeHtml(d.title)}" placeholder="细节名称" aria-label="细节名称">` +
    `<input data-field="note" maxlength="200" value="${escapeHtml(d.note || '')}" placeholder="具体描述" aria-label="具体描述">` +
    '<div class="edit-row">' +
    `<select data-field="type" aria-label="细节类型">${typeOptions(d.type)}</select>` +
    '<button class="btn-tiny is-primary" type="button" data-act="save">保存</button>' +
    '<button class="btn-tiny" type="button" data-act="cancel">取消</button>' +
    '</div>';
  focusSoon(form.querySelector('input'));
  return form;
}

function typeOptions(selected) {
  return Object.entries(TYPES)
    .map(
      ([key, meta]) =>
        `<option value="${key}"${key === selected ? ' selected' : ''}>${meta.label}</option>`
    )
    .join('');
}

function renderAddDetail() {
  els.addDetail.innerHTML = '';
  if (!activeFrame()) return;

  if (!ui.adding) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-btn';
    btn.textContent = '＋ 补充一个细节';
    btn.addEventListener('click', () => {
      ui.adding = true;
      renderLedger();
      focusSoon('#addTitle');
    });
    els.addDetail.append(btn);
    return;
  }

  const form = document.createElement('div');
  form.className = 'detail-edit';
  form.innerHTML =
    '<input id="addTitle" maxlength="20" placeholder="细节名称，例如：桌上的黄铜钥匙" aria-label="细节名称">' +
    '<input id="addNote" maxlength="200" placeholder="你看到了什么？想怎么用？" aria-label="具体描述">' +
    '<div class="edit-row">' +
    `<select id="addType" aria-label="细节类型">${typeOptions('object')}</select>` +
    '<button class="btn-tiny is-primary" type="button" data-act="add-save">加入清单</button>' +
    '<button class="btn-tiny" type="button" data-act="add-cancel">取消</button>' +
    '</div>';
  els.addDetail.append(form);
}

/* ------------------------------------------------------------------ */
/* story rendering                                                     */
/* ------------------------------------------------------------------ */

function countWords(text) {
  return String(text || '')
    .replace(/[#*`>\-_[\]()]/g, '')
    .replace(/\s/g, '').length;
}

function isNearBottom() {
  const el = els.paperScroll;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function renderStory() {
  const raw = state.story.raw || '';
  const parsed = parseStory(raw);
  const has = raw.trim().length > 0;
  const words = countWords(stripStoryAnchors(raw));
  els.storyStale.hidden = !has || !state.story.stale;

  els.paperEmpty.hidden = has;
  els.story.hidden = !has;
  els.wordCount.textContent = String(words);
  els.paperKicker.textContent =
    state.story.status === 'streaming'
      ? '显影中'
      : state.story.sample
        ? '示例故事'
        : has
          ? '已生成'
          : '未显影';
  els.paperMeta.textContent = has
    ? state.story.sample
      ? `${state.frames.length} 帧 · 示例`
      : `${state.frames.length} 帧 · ${MODES[state.settings.mode]?.label || ''} · ${STYLES[state.settings.style]?.label || ''} · ${POVS[state.settings.pov] || ''}`
    : '';

  els.story.innerHTML = '';
  if (!has) {
    renderStoryButtons();
    return;
  }

  if (parsed.title || state.story.status !== 'streaming') {
    const h1 = document.createElement('h1');
    h1.className = 'story-title';
    h1.contentEditable = 'true';
    h1.spellcheck = false;
    h1.textContent = parsed.title || '';
    h1.setAttribute('aria-label', '故事标题，可直接修改');
    els.story.append(h1);
  }

  if (parsed.intro) {
    const intro = document.createElement('div');
    intro.className = 'story-intro';
    intro.innerHTML = mdToHtml(parsed.intro);
    els.story.append(intro);
  }

  parsed.sections.forEach((sec, i) => {
    const wrap = document.createElement('section');
    wrap.className = 'story-sec';
    wrap.dataset.index = String(i);

    const margin = document.createElement('div');
    margin.className = 'sec-margin';
    const label = document.createElement('div');
    label.className = 'sec-label';
    label.textContent = sec.frame || '·';
    const rule = document.createElement('div');
    rule.className = 'sec-rule';
    const rewrite = document.createElement('button');
    rewrite.type = 'button';
    rewrite.className = 'sec-rewrite';
    rewrite.dataset.act = 'rewrite';
    rewrite.dataset.index = String(i);
    rewrite.textContent = '重写';
    rewrite.title = state.story.stale ? '图片顺序已变化，请先重新生成全文' : '保留前后情节，只重写这一段';
    rewrite.disabled = state.story.stale || state.story.status === 'streaming';
    margin.append(label, rule, rewrite);

    const body = document.createElement('div');
    body.className = 'sec-body';
    body.innerHTML = mdToHtml(sec.text) || '<p></p>';

    wrap.append(margin, body);
    els.story.append(wrap);
  });

  if (state.story.status === 'streaming') {
    const caret = document.createElement('span');
    caret.className = 'caret';
    const last = els.story.querySelector('.story-sec:last-child .sec-body') || els.story;
    last.append(caret);
  }

  if (state.story.error) {
    const err = document.createElement('p');
    err.className = 'story-error';
    err.textContent = state.story.error;
    els.story.append(err);
  }

  renderStoryButtons();
}

function renderStoryButtons() {
  const has = (state.story.raw || '').trim().length > 0;
  const streaming = state.story.status === 'streaming';
  els.copyBtn.disabled = !has;
  els.exportBtn.disabled = !has;
  els.clearStoryBtn.disabled = !has || streaming;
}

function scheduleStoryRender() {
  if (ui.storyTimer) return;
  ui.storyTimer = setTimeout(() => {
    ui.storyTimer = null;
    const stick = isNearBottom();
    renderStory();
    if (stick) els.paperScroll.scrollTop = els.paperScroll.scrollHeight;
  }, 90);
}

function renderComposer() {
  $$('.mode', els.modeRow).forEach((btn) => {
    const on = btn.dataset.mode === state.settings.mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  els.modeHint.textContent = MODES[state.settings.mode]?.hint || '';
  els.povSelect.value = state.settings.pov;
  els.lengthSelect.value = state.settings.length;
  els.styleSelect.value = state.settings.style;
  els.styleHint.textContent = STYLES[state.settings.style]?.hint || '';
  els.presetSelect.value = state.settings.promptPreset;
  if (els.customPrompt.value !== state.settings.customPrompt) {
    els.customPrompt.value = state.settings.customPrompt;
  }

  const streaming = state.story.status === 'streaming';
  [els.povSelect, els.lengthSelect, els.styleSelect, els.presetSelect, els.customPrompt,
    ...$$('.mode', els.modeRow)].forEach((control) => { control.disabled = streaming; });
  els.generateBtn.classList.toggle('is-stop', streaming);
  els.generateBtn.innerHTML = streaming
    ? '停止生成'
    : '生成故事 <span class="cta-key">Ctrl ↵</span>';
}

function renderConn() {
  const ready = hasApi(state.config);
  els.connBtn.classList.toggle('is-on', ready && state.serverOk);
  if (!state.serverOk) {
    els.connText.textContent = '服务未连接';
    els.connBtn.title = '请运行 node server.mjs';
  } else if (ready) {
    const target = chatTargetOf(state.config);
    const vendor = target.provider.name ? `${target.provider.name} · ` : '';
    els.connText.textContent = `${vendor}${target.model} · 已配置`;
    els.connBtn.title = '已配置，点击修改';
  } else {
    els.connText.textContent = '未连接';
    els.connBtn.title = '打开 AI 连接设置';
  }
}

/* ------------------------------------------------------------------ */
/* frames                                                              */
/* ------------------------------------------------------------------ */

function selectFrame(id, { scroll = true } = {}) {
  if (!state.frames.some((f) => f.id === id)) return;
  state.activeId = id;
  state.focusId = null;
  state.filter = 'all';
  ui.hoverDetailId = null;
  ui.editing = null;
  ui.adding = false;
  if (scroll) els.stage.scrollTop = 0;
  renderFrames();
  renderViewer();
  renderLedger();
  if (window.innerWidth <= 1080) setPanel('stage');
  persist();
}

function markStoryStale() {
  if (!state.story.raw && state.story.status !== 'streaming') return;
  state.story.stale = true;
  renderStory();
}

function moveFrame(fromId, toId) {
  const from = state.frames.findIndex((f) => f.id === fromId);
  const to = state.frames.findIndex((f) => f.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = state.frames.splice(from, 1);
  state.frames.splice(to, 0, item);
  markStoryStale();
  renderFrames();
  renderViewer();
  renderLedger();
  persist();
}

function removeFrame(id) {
  const frame = state.frames.find((f) => f.id === id);
  if (!frame) return;
  if (!confirm(`移除「${frame.name}」这一帧？`)) return;
  state.frames = state.frames.filter((f) => f.id !== id);
  markStoryStale();
  if (state.activeId === id) state.activeId = state.frames[0]?.id || null;
  if (!state.frames.length) state.focusId = null;
  renderAll();
  persist();
}

function shiftFrame(id, delta) {
  const from = state.frames.findIndex((f) => f.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.frames.length) return;
  const [item] = state.frames.splice(from, 1);
  state.frames.splice(to, 0, item);
  markStoryStale();
  renderFrames();
  renderViewer();
  persist();
  focusSoon(`.frame[data-id="${id}"]`);
}

/* ------------------------------------------------------------------ */
/* upload                                                              */
/* ------------------------------------------------------------------ */

function prepareImage(file, max = 1400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const isVector = file.type === 'image/svg+xml';
        const dataUrl = canvas.toDataURL(isVector ? 'image/png' : 'image/jpeg', 0.88);
        URL.revokeObjectURL(url);
        resolve({ dataUrl, w, h });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) {
    showToast('只能放入图片文件（jpg、png、webp、svg）。', true);
    return;
  }

  let added = 0;
  for (const file of files) {
    try {
      const { dataUrl, w, h } = await prepareImage(file);
      state.frames.push({
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '未命名帧',
        dataUrl,
        w,
        h,
        summary: '',
        note: '',
        details: [],
        status: 'idle',
        error: '',
      });
      added += 1;
    } catch {
      showToast(`读不了 ${file.name}，换一张试试。`, true);
    }
  }

  if (added) {
    markStoryStale();
    if (!state.activeId) state.activeId = state.frames[0].id;
    renderAll();
    persist();
    showToast(`已放入 ${added} 张图片。`);
  }
}

/* ------------------------------------------------------------------ */
/* extraction                                                          */
/* ------------------------------------------------------------------ */

function parseJsonLoose(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function normalizeBox(box, w, h) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [x, y, bw, bh] = box.map(Number);
  if (![x, y, bw, bh].every(Number.isFinite)) return null;

  if (Math.max(x, y, bw, bh) > 1.5) {
    if (!w || !h) return null;
    x /= w;
    y /= h;
    bw /= w;
    bh /= h;
  }

  x = clamp01(x);
  y = clamp01(y);
  bw = clamp01(bw);
  bh = clamp01(bh);
  if (bw > 1 - x) bw = 1 - x;
  if (bh > 1 - y) bh = 1 - y;
  if (bw < 0.02 || bh < 0.02) return null;
  return [round3(x), round3(y), round3(bw), round3(bh)];
}

function applyExtraction(frame, data) {
  const previousEmphasis = new Map(frame.details.map((d) => [d.title, d.emphasis]));
  const manual = frame.details.filter((d) => d.source === 'manual');
  const list = Array.isArray(data?.details) ? data.details : [];

  const ai = [];
  list.slice(0, 24).forEach((raw) => {
    const title = String(raw?.title || '').trim().slice(0, 20);
    const note = String(raw?.note || '').trim().slice(0, 200);
    if (!title && !note) return;
    const type = TYPES[raw?.type] ? raw.type : 'object';
    ai.push({
      id: uid(),
      type,
      title: title || note.slice(0, 10),
      note,
      confidence: raw?.confidence === 'inferred' ? 'inferred' : 'seen',
      box: normalizeBox(raw?.box, frame.w, frame.h),
      emphasis: previousEmphasis.get(title) || 'mention',
      source: 'ai',
    });
  });

  frame.details = [...ai, ...manual];
  frame.summary = String(data?.summary || '').trim().slice(0, 120);
  return ai.length;
}

async function extractFrame(frame, { quiet = false } = {}) {
  if (!frame) return;
  if (!hasApi(state.config)) {
    openSettings();
    showToast('先在设置里填接口地址、API Key 和模型。');
    return;
  }

  const idx = frameIndex(frame);
  frame.status = 'extracting';
  frame.error = '';
  renderFrames();
  renderViewer();
  renderLedger();
  persist();

  try {
    const messages = extractMessages({
      index: idx,
      total: state.frames.length,
      prevSummary: state.frames[idx - 1]?.summary || '',
      note: frame.note || '',
      otherNotes: state.frames
        .map((f, i) => ({ label: `F${pad(i + 1)}`, note: (f.note || '').trim() }))
        .filter((x, i) => x.note && i !== idx),
      dataUrl: frame.dataUrl,
    });
    const text = await chat({
      config: state.config,
      provider: visionTargetOf(state.config).provider,
      model: visionTargetOf(state.config).model,
      messages,
      temperature: 0.25,
      maxTokens: 3200,
    });
    const data = parseJsonLoose(text);
    const n = applyExtraction(frame, data);
    if (!n && !frame.summary) throw new AppError('模型没有返回可用的细节，换一个视觉模型试试。');
    frame.status = 'done';
    if (n < 10) await supplementFrame(frame);
    if (!quiet) {
      showToast(`识别出 ${frame.details.length} 条细节。标为「展」的会写具体。`);
    }
  } catch (err) {
    frame.status = 'error';
    frame.error = err.message || '识别失败';
    if (!quiet) showToast(frame.error, true, 6000);
  } finally {
    renderAll();
    persist();
  }
}

const normTitle = (t) => String(t || '').replace(/[\s·・、，。：:；;（）()《》"'“”]/g, '').toLowerCase();

async function supplementFrame(frame) {
  try {
    const found = frame.details
      .filter((d) => d.source === 'ai')
      .map((d) => ({ title: d.title, note: d.note }));
    const messages = supplementMessages({
      found,
      index: frameIndex(frame),
      total: state.frames.length,
      dataUrl: frame.dataUrl,
    });
    const text = await chat({
      config: state.config,
      provider: visionTargetOf(state.config).provider,
      model: visionTargetOf(state.config).model,
      messages,
      temperature: 0.35,
      maxTokens: 2000,
    });
    const data = parseJsonLoose(text);
    const existing = new Set(frame.details.map((d) => normTitle(d.title)));
    let added = 0;

    (Array.isArray(data?.details) ? data.details : []).slice(0, 8).forEach((raw) => {
      if (frame.details.length >= 24) return;
      const title = String(raw?.title || '').trim().slice(0, 20);
      const note = String(raw?.note || '').trim().slice(0, 200);
      if (!title || !note || existing.has(normTitle(title))) return;
      existing.add(normTitle(title));
      frame.details.push({
        id: uid(),
        type: TYPES[raw?.type] ? raw.type : 'object',
        title,
        note,
        confidence: raw?.confidence === 'inferred' ? 'inferred' : 'seen',
        box: normalizeBox(raw?.box, frame.w, frame.h),
        emphasis: 'mention',
        source: 'ai',
      });
      added += 1;
    });

    if (added) {
      renderAll();
      persist();
    }
  } catch {
    /* 补漏是加分项，失败不影响第一遍结果 */
  }
}

async function extractAll() {
  if (state.busy) return;
  if (!state.frames.length) {
    showToast('先放入图片。');
    return;
  }
  if (!hasApi(state.config)) {
    openSettings();
    showToast('先在设置里填接口地址、API Key 和模型。');
    return;
  }

  state.busy = true;
  renderLedger();
  const targets = state.frames.slice();
  const label = els.extractAllBtn.textContent;
  let failed = 0;
  let done = 0;

  try {
    // 并发识别：4 路同时请求，说明共享弥补了顺序摘要的缺失
    const queue = targets.slice();
    const worker = async () => {
      while (queue.length) {
        const frame = queue.shift();
        const before = frame.status;
        await extractFrame(frame, { quiet: true });
        if (frame.status === 'error' && before !== 'error') failed += 1;
        done += 1;
        els.extractAllBtn.textContent = `识别中 ${done}/${targets.length}`;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, () => worker())
    );
    await findContinuity();
    showToast(
      failed
        ? `识别完成，${failed} 帧失败。点开失败的帧看原因。`
        : `全部识别完成，共 ${targets.reduce((n, f) => n + f.details.length, 0)} 条细节。`,
      failed > 0
    );
  } finally {
    state.busy = false;
    els.extractAllBtn.textContent = label;
    renderAll();
    persist();
  }
}

async function findContinuity() {
  const done = state.frames.filter((f) => f.status === 'done' && f.summary);
  if (done.length < 2) return;

  const payload = done.map((f) => ({
    label: `F${pad(state.frames.indexOf(f) + 1)}`,
    summary: f.summary,
    details: f.details,
  }));

  try {
    const text = await chat({
      config: state.config,
      provider: chatTargetOf(state.config).provider,
      model: chatTargetOf(state.config).model,
      messages: continuityMessages({ frames: payload }),
      temperature: 0.3,
      maxTokens: 800,
    });
    const data = parseJsonLoose(text);
    const links = Array.isArray(data?.links) ? data.links.slice(0, 5) : [];
    let added = 0;

    links.forEach((link) => {
      const nums = Array.isArray(link?.frames) ? link.frames.map(Number).filter(Number.isFinite) : [];
      const target = state.frames[nums[0] - 1];
      const title = String(link?.title || '').trim().slice(0, 20);
      if (!target || !title) return;
      if (target.details.some((d) => d.type === 'continuity' && d.title === title)) return;
      target.details.push({
        id: uid(),
        type: 'continuity',
        title,
        note: String(link?.note || '').trim().slice(0, 160),
        confidence: 'inferred',
        box: null,
        emphasis: 'mention',
        source: 'ai',
      });
      added += 1;
    });

    if (added) {
      renderAll();
      showToast(`找到 ${added} 条跨图线索，已放进对应的帧里。`);
    }
  } catch {
    /* 跨图线索是加分项，失败不打断流程 */
  }
}

/* ------------------------------------------------------------------ */
/* story generation                                                    */
/* ------------------------------------------------------------------ */

async function generateStory() {
  if (state.story.status === 'streaming') {
    ui.genAbort?.abort();
    return;
  }
  if (!state.frames.length) {
    showToast('先放入图片，再生成故事。');
    return;
  }
  if (!hasApi(state.config)) {
    openSettings();
    showToast('先在设置里填接口地址、API Key 和模型。');
    return;
  }
  if (!state.frames.some((f) => f.details.length)) {
    showToast('先识别至少一帧的细节，故事才有依据。');
    return;
  }

  const settings = normalizeSettings(state.settings);
  const { mode } = settings;
  const target = chatTargetOf(state.config);
  const images = state.config.storyImages
    ? await fitStoryImages(state.frames.map((f) => f.dataUrl))
    : [];
  const messages = storyMessages({ brief: buildBrief(state.frames), images, ...settings });
  const controller = new AbortController();
  ui.genAbort = controller;

  state.story = { raw: '', status: 'streaming', error: '', sample: false, updatedAt: Date.now() };
  renderStory();
  renderComposer();
  els.paperScroll.scrollTop = 0;

  try {
    const text = await chat({
      config: state.config,
      provider: target.provider,
      model: target.model,
      messages,
      temperature: mode === 'faithful' ? 0.55 : mode === 'free' ? 0.95 : 0.8,
      stream: true,
      signal: controller.signal,
      onDelta: (delta) => {
        state.story.raw += delta;
        scheduleStoryRender();
      },
    });
    state.story.raw = text || state.story.raw;
    // 模型偶尔不写帧锚点：补注后再入库，保证逐帧重写与画册配对可用
    if (!parseStory(state.story.raw).sections.length && state.frames.length) {
      state.story.raw = injectAnchors(state.story.raw, state.frames.length);
    }
    state.story.status = 'done';
    state.story.updatedAt = Date.now();
  } catch (err) {
    if (err?.name === 'AbortError') {
      state.story.status = 'done';
      showToast('已停止生成。');
    } else {
      state.story.status = 'error';
      state.story.error = err.message || '生成失败';
      showToast(state.story.error, true, 7000);
    }
  } finally {
    ui.genAbort = null;
    if (ui.storyTimer) {
      clearTimeout(ui.storyTimer);
      ui.storyTimer = null;
    }
    renderStory();
    renderComposer();
    persist();
  }
}

async function rewriteSection(index, btn) {
  if (state.story.status === 'streaming') return;
  if (!hasApi(state.config)) {
    openSettings();
    return;
  }
  if (state.story.stale) {
    showToast('图片顺序变了，原稿还在。重新生成全文后才能按图重写。', true, 6000);
    return;
  }
  const parsed = parseStory(state.story.raw);
  const sec = parsed.sections[index];
  if (!sec) return;

  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  const prev = parsed.sections[index - 1];
  const next = parsed.sections[index + 1];
  const frameIndex = sec.frame ? Number(sec.frame.slice(1)) - 1 : -1;
  const frame = state.frames[frameIndex];
  const originalRaw = state.story.raw;
  const originalProjectId = state.projectId;
  const settings = normalizeSettings(state.settings);

  try {
    const target = chatTargetOf(state.config);
    const images = state.config.storyImages && frame
      ? await fitStoryImages([frame.dataUrl])
      : [];
    const text = await chat({
      config: state.config,
      provider: target.provider,
      model: target.model,
      messages: rewriteMessages({
        frameKey: sec.frame || sec.heading || 'F01',
        target: sec.text,
        before: prev ? prev.text.slice(-900) : parsed.intro.slice(-900),
        after: next ? next.text.slice(0, 900) : '',
        note: '',
        storyContext: buildStoryContext(parsed) + '\n\n' + buildTimeline(state.frames),
        frameBrief: frame ? buildFrameBrief(frame, frameIndex) : '',
        images,
        isLast: index === parsed.sections.length - 1,
        ...settings,
      }),
      temperature: 0.8,
    });
    const clean = String(text)
      .replace(/^\s*```[a-z]*\s*/i, '')
      .replace(/```\s*$/, '')
      .replace(/^\s*#{2,3}\s*[^\n]*\n/, '')
      .trim();
    if (!clean) throw new AppError('模型没有返回内容，再试一次。');
    if (state.projectId !== originalProjectId || state.story.raw !== originalRaw || state.story.stale) {
      throw new AppError('故事或图片顺序已变化，未覆盖当前内容。请重新选择段落重写。');
    }
    sec.text = clean;
    state.story.raw = rebuildStory(parsed);
    state.story.sample = false;
    renderStory();
    persist();
    showToast('这一段已重写。');
  } catch (err) {
    showToast(err.message, true, 6000);
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function providerRowHtml(p) {
  return `
    <div class="provider-row" data-id="${escapeHtml(p.id)}">
      <div class="provider-row-head">
        <input class="pr-name" type="text" maxlength="30" autocomplete="off" spellcheck="false"
               placeholder="名称（如 OpenAI）" value="${escapeHtml(p.name)}" aria-label="供应商名称">
        <button class="pr-del link-btn" type="button" title="删除这个供应商">删除</button>
      </div>
      <input class="pr-base" type="url" autocomplete="off" spellcheck="false"
             placeholder="接口地址，如 https://api.openai.com/v1" value="${escapeHtml(p.baseUrl)}" aria-label="接口地址">
      <input class="pr-key" type="password" autocomplete="off" spellcheck="false"
             placeholder="API Key（sk-…）" value="${escapeHtml(p.apiKey)}" aria-label="API Key">
      <em>填到 <code>/v1</code> 为止即可，会自动补上 <code>/chat/completions</code>。</em>
    </div>`;
}

function rebuildProviderOptions({ chatId, visionId } = {}) {
  const rows = $$('.provider-row', els.cfgProviders);
  const options = rows.map((row, i) => {
    const name = $('.pr-name', row).value.trim();
    let host = '';
    try {
      host = new URL($('.pr-base', row).value.trim()).hostname;
    } catch {
      host = '';
    }
    const label = name || host || `供应商 ${i + 1}`;
    return `<option value="${escapeHtml(row.dataset.id)}">${escapeHtml(label)}</option>`;
  }).join('');

  const prevChat = chatId ?? els.cfgChatProvider.value;
  const prevVision = visionId ?? els.cfgVisionProvider.value;
  els.cfgChatProvider.innerHTML = options || '<option value="">（先添加供应商）</option>';
  els.cfgVisionProvider.innerHTML = '<option value="">同写作模型</option>' + options;

  const ids = rows.map((r) => r.dataset.id);
  els.cfgChatProvider.value = ids.includes(prevChat) ? prevChat : ids[0] || '';
  els.cfgVisionProvider.value = ids.includes(prevVision) ? prevVision : '';
}

function openSettings() {
  els.cfgProviders.innerHTML = state.config.providers.map(providerRowHtml).join('');
  rebuildProviderOptions({
    chatId: state.config.chatModel.providerId,
    visionId: state.config.visionModel.providerId,
  });
  els.cfgChat.value = state.config.chatModel.model || '';
  els.cfgVision.value = state.config.visionModel.model || '';
  els.cfgStoryImages.checked = Boolean(state.config.storyImages);
  els.testStatus.textContent = '';
  els.testStatus.className = 'sstatus';
  if (typeof els.settings.showModal === 'function') els.settings.showModal();
}

function readConfigForm() {
  const providers = $$('.provider-row', els.cfgProviders).map((row, i) => {
    const name = $('.pr-name', row).value.trim();
    let host = '';
    try {
      host = new URL($('.pr-base', row).value.trim()).hostname;
    } catch {
      host = '';
    }
    return {
      id: row.dataset.id,
      name: name || host || `供应商 ${i + 1}`,
      baseUrl: $('.pr-base', row).value.trim(),
      apiKey: $('.pr-key', row).value.trim(),
    };
  });
  return {
    providers,
    chatModel: {
      providerId: els.cfgChatProvider.value,
      model: els.cfgChat.value.trim(),
    },
    visionModel: {
      providerId: els.cfgVisionProvider.value,
      model: els.cfgVision.value.trim(),
    },
    storyImages: els.cfgStoryImages.checked,
  };
}

async function runTest() {
  const cfg = readConfigForm();
  const selected = cfg.providers.find((p) => p.id === cfg.chatModel.providerId);
  if (!cfg.providers.some((p) => p.baseUrl && p.apiKey)) {
    els.testStatus.textContent = '至少要有一个供应商填好接口地址和 API Key。';
    els.testStatus.className = 'sstatus is-err';
    return;
  }
  if (!selected?.baseUrl || !selected?.apiKey) {
    els.testStatus.textContent = '写作模型选的供应商还没填好接口地址和 API Key。';
    els.testStatus.className = 'sstatus is-err';
    return;
  }
  if (!cfg.chatModel.model) {
    els.testStatus.textContent = '写作模型的模型名要填。';
    els.testStatus.className = 'sstatus is-err';
    return;
  }
  els.testBtn.disabled = true;
  els.testStatus.textContent = '正在连接…';
  els.testStatus.className = 'sstatus';
  try {
    const reply = await testConnection(cfg);
    els.testStatus.textContent = `连接成功，模型回复：${reply || '（空）'}`;
    els.testStatus.className = 'sstatus is-ok';
  } catch (err) {
    els.testStatus.textContent = err.message;
    els.testStatus.className = 'sstatus is-err';
  } finally {
    els.testBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

function exportMarkdown() {
  const raw = stripStoryAnchors(state.story.raw || '').trim();
  if (!raw) return;
  const title = (parseStory(raw).title || '故事').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const blob = new Blob([raw + '\n'], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || '故事'}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast('已导出 Markdown。');
}

async function copyStory() {
  const raw = stripStoryAnchors(state.story.raw || '').trim();
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    showToast('已复制全文。');
  } catch {
    showToast('浏览器不允许写剪贴板，试试导出 Markdown。', true);
  }
}

/* ------------------------------------------------------------------ */
/* project management                                                  */
/* ------------------------------------------------------------------ */

function fmtTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  const d = new Date(ts);
  if (d.getFullYear() === new Date().getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hasContent() {
  return state.frames.length > 0 || (state.story.raw || '').trim().length > 0;
}

function saveNow() {
  if (els.nameDlg.open) return;
  if (!hasContent()) {
    showToast('项目还是空的，先放入图片或生成故事。');
    return;
  }
  if (state.projectNamed) {
    flushProject().then((ok) =>
      showToast(ok ? `已保存「${state.projectName}」。` : '保存失败，浏览器存储可能不可用。', !ok)
    );
    return;
  }
  openNameDialog('save');
}

function openNameDialog(mode, targetId, currentName) {
  ui.nameMode = mode;
  ui.nameTarget = targetId || null;
  if (mode === 'rename') {
    els.nameTitle.textContent = '重命名项目';
    els.nameInput.value = currentName || '';
    els.nameConfirm.textContent = '重命名';
  } else if (mode === 'dup') {
    els.nameTitle.textContent = '另存为新项目';
    els.nameInput.value = `${state.projectName || defaultProjectName()} 副本`.slice(0, 24);
    els.nameConfirm.textContent = '另存';
  } else {
    els.nameTitle.textContent = '保存项目';
    els.nameInput.value = state.projectNamed ? state.projectName : defaultProjectName();
    els.nameConfirm.textContent = '保存';
  }
  if (typeof els.nameDlg.showModal === 'function') els.nameDlg.showModal();
  requestAnimationFrame(() => {
    els.nameInput.focus();
    els.nameInput.select();
  });
}

async function duplicateAs(name) {
  state.projectId = uid();
  state.projectName = name;
  state.projectNamed = true;
  ui.projectCreatedAt = Date.now();
  renderProjectBar();
  const ok = await flushProject();
  showToast(ok ? `已另存为新项目「${name}」。` : '另存失败，浏览器存储可能不可用。', !ok);
  if (ok && els.projectsDlg.open) renderProjectList();
}

async function renderProjectList() {
  const list = await listProjects();
  els.projectList.innerHTML = '';

  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'project-empty';
    li.textContent = '还没有保存的项目。放入图片开始，内容会自动保存成项目。';
    els.projectList.append(li);
    return;
  }

  list.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'project-row' + (p.id === state.projectId ? ' is-current' : '');
    li.dataset.id = p.id;

    const main = document.createElement('div');
    main.className = 'pr-main';
    const nm = document.createElement('b');
    nm.className = 'pr-name';
    nm.textContent = p.name || '未命名项目';
    const meta = document.createElement('span');
    meta.className = 'pr-meta';
    meta.textContent = `${p.frameCount || 0} 帧 · ${p.hasStory ? '有故事' : '未生成'} · ${fmtTime(p.updatedAt)}`;
    main.append(nm, meta);

    const acts = document.createElement('div');
    acts.className = 'pr-acts';
    acts.innerHTML =
      `<button class="link-btn" type="button" data-act="open">${p.id === state.projectId ? '当前' : '打开'}</button>` +
      '<button class="link-btn" type="button" data-act="rename">重命名</button>' +
      '<button class="link-btn is-danger" type="button" data-act="del">删除</button>';

    li.append(main, acts);
    els.projectList.append(li);
  });
}

async function openProject(id) {
  if (id === state.projectId) {
    els.projectsDlg.close();
    return;
  }
  if (state.story.status === 'streaming') {
    showToast('故事正在生成，先停止或等它完成。', true);
    return;
  }
  if (ui.saveTimer) {
    clearTimeout(ui.saveTimer);
    if (!(await flushProject())) {
      showToast('当前项目保存失败，未切换项目。', true);
      return;
    }
  }
  const rec = await getProject(id);
  if (!rec) {
    showToast('这个项目读不出来。', true);
    return;
  }
  applyProject(id, rec);
  ui.editing = null;
  ui.adding = false;
  renderAll();
  els.projectsDlg.close();
  showToast(`已打开「${state.projectName}」。`);
}

async function newProject() {
  if (state.story.status === 'streaming') {
    showToast('故事正在生成，先停止或等它完成。', true);
    return;
  }
  const msg = hasContent()
    ? `新建空项目？当前项目「${state.projectName || '未命名项目'}」会先保存，随时可以再打开。`
    : '新建一个空项目？';
  if (!confirm(msg)) return;
  clearTimeout(ui.saveTimer);
  ui.saveTimer = null;
  if (hasContent() || state.projectId ||
      JSON.stringify(state.settings) !== JSON.stringify(DEFAULT_SETTINGS)) {
    if (!(await flushProject())) {
      showToast('当前项目保存失败，未新建项目。', true);
      return;
    }
  }

  state.projectId = null;
  state.projectName = '';
  state.projectNamed = false;
  ui.projectCreatedAt = null;
  state.frames = [];
  state.activeId = null;
  state.focusId = null;
  state.filter = 'all';
  state.story = { raw: '', status: 'idle', error: '', sample: false, updatedAt: 0 };
  state.settings = { ...DEFAULT_SETTINGS };
  ui.editing = null;
  ui.adding = false;
  ls.remove(LAST_KEY);
  renderAll();
  els.projectsDlg.close();
  showToast('已新建空项目。');
}

async function removeProject(id, name) {
  if (!confirm(`删除项目「${name}」？图片和故事都会一起删除，无法恢复。`)) return;
  const ok = await deleteProject(id);
  if (!ok) {
    showToast('删除失败。', true);
    return;
  }
  // 先记墓碑再尝试推送：就算这次没推到云端，下次同步也会重放这条删除
  noteDelete(id);
  deleteRemote(id);
  if (id === state.projectId) {
    // 桌面上的内容保留，之后的改动会存成一个新项目
    state.projectId = null;
    state.projectNamed = false;
    ui.projectCreatedAt = null;
    ls.remove(LAST_KEY);
    renderProjectBar();
    showToast('项目已删除。当前内容仍留在桌面上，改动会存成一个新项目。', false, 5200);
  } else {
    showToast('项目已删除。');
  }
  renderProjectList();
}

/* ------------------------------------------------------------------ */
/* toast & tabs                                                        */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function showToast(message, isError = false, ms = 3800) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-err', isError);
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-on');
    setTimeout(() => {
      els.toast.hidden = true;
    }, 260);
  }, ms);
}

function setPanel(panel) {
  state.panel = panel;
  renderTabs();
}

/* ------------------------------------------------------------------ */
/* emphasis / detail edits                                             */
/* ------------------------------------------------------------------ */

function setEmphasis(detail, emphasis) {
  if (!EMPHASIS[emphasis]) return;
  detail.emphasis = emphasis;
  renderFrames();
  renderLedger();
  renderStoryButtons();
  persist();
  focusSoon(`.detail[data-id="${detail.id}"] [data-em="${emphasis}"]`);
}

function toggleFocus(detail) {
  state.focusId = state.focusId === detail.id ? null : detail.id;
  renderLedger();
  applyBoxFocus();
}

function saveEdit(form, detail) {
  const title = form.querySelector('[data-field="title"]').value.trim().slice(0, 20);
  const note = form.querySelector('[data-field="note"]').value.trim().slice(0, 160);
  const type = form.querySelector('[data-field="type"]').value;
  if (!title && !note) {
    showToast('至少写一个名称或描述。', true);
    return;
  }
  detail.title = title || note.slice(0, 10);
  detail.note = note;
  detail.type = TYPES[type] ? type : detail.type;
  ui.editing = null;
  renderAll();
  persist();
  focusSoon(`.detail[data-id="${detail.id}"] .detail-title`);
}

function addManualDetail() {
  const frame = activeFrame();
  if (!frame) return;
  const title = ($('#addTitle')?.value || '').trim().slice(0, 20);
  const note = ($('#addNote')?.value || '').trim().slice(0, 200);
  const type = $('#addType')?.value || 'object';
  if (!title && !note) {
    showToast('至少写一个名称或描述。', true);
    return;
  }
  frame.details.push({
    id: uid(),
    type: TYPES[type] ? type : 'object',
    title: title || note.slice(0, 10),
    note,
    confidence: 'seen',
    box: null,
    emphasis: 'mention',
    source: 'manual',
  });
  ui.adding = false;
  renderAll();
  persist();
  showToast('已加入清单。');
}

/* ------------------------------------------------------------------ */
/* sample project                                                      */
/* ------------------------------------------------------------------ */

const SAMPLE_STORY = `# 末班车之后

### F01
雨从傍晚下到十一点，站牌上"末班车"三个字被水汽泡得发白。她把伞往电线杆边挪了挪，红色的伞面在路灯下像一小片不肯熄灭的火。

车没有来。她也不着急，右手把伞柄握在胸前，站得很稳，只看着路的尽头。对面楼里有一扇窗一直亮着——她数过，那家人每晚十一点十分关灯。**今晚，那扇窗还亮着。**

湿透的路面把灯和伞的影子揉在一起，雨还在下。

### F02
回到屋里，雨还没有停。台灯只照亮桌面这一小块地方，其余的都沉在暗处。

她拆开信封，动作慢得像在拆一件易碎品。信纸从里面露出一截，上面是父亲的字，笔画很重，纸背都被压出了印子。

信里没有解释，只有一句话，和一把很小的黄铜钥匙。**齿口很新，像是刚配好的。**

旁边那杯茶早就凉了，杯口浮着一层薄薄的膜。她看了三遍，才想起来自己一直站着。

### F03
天亮的时候，站台上还留着夜里的凉气。太阳刚离开楼群，天边是橘粉色。

她提着一只旧箱子，箱角磨白了，轮子在水泥地上发出细碎的响声。她没有回头。

第一班车从雾气里滑进来，银灰色的车厢，车窗一格一格地亮着，像一列被人点亮的抽屉。最近的一扇窗里能看见空着的座位。

她跨过那条被踩得发灰的黄色安全线。**广播报出终点站的名字，那是信里写的地方。**`;

const SAMPLE_FRAMES = [
  {
    file: 'samples/frame-1.svg',
    name: '雨夜，末班车',
    summary: '雨夜的公交站，一个女人撑着红伞等末班车，对面有一扇窗一直亮着。',
    details: [
      {
        type: 'person',
        title: '红伞下的女人',
        note: '深色外套配一条暗红围巾，右手举着伞，站得很稳，身体微微朝站牌一侧',
        confidence: 'seen',
        box: [0.46, 0.51, 0.09, 0.43],
        emphasis: 'expand',
      },
      {
        type: 'object',
        title: '红色雨伞',
        note: '伞面是褪了色的红，伞骨撑得很满，边缘还在往下滴水',
        confidence: 'seen',
        box: [0.36, 0.27, 0.29, 0.2],
        emphasis: 'expand',
      },
      {
        type: 'object',
        title: '末班车站牌',
        note: '蓝灰色站牌，写着"末班车 23:40"和 17 路，字被雨汽打湿',
        confidence: 'seen',
        box: [0.763, 0.304, 0.117, 0.229],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '一直亮着的窗',
        note: '对面楼里唯一亮着的窗，暖黄色，十字窗棂，是整幅画面里最暖的地方',
        confidence: 'seen',
        box: [0.171, 0.245, 0.058, 0.101],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '湿漉漉的路面',
        note: '积水映着路灯和伞的影子，雨点在水面上打出细小的圈',
        confidence: 'seen',
        box: [0.3, 0.84, 0.45, 0.14],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '路灯与雨丝',
        note: '路灯把雨照成一层斜着落下的亮线，光锥一直落到地面',
        confidence: 'seen',
        box: [0.575, 0.2, 0.13, 0.16],
        emphasis: 'mention',
      },
      {
        type: 'action',
        title: '等待',
        note: '她站了很久，没有看手机，只看着路的尽头',
        confidence: 'inferred',
        box: [0.44, 0.42, 0.16, 0.5],
        emphasis: 'mention',
      },
      {
        type: 'continuity',
        title: '同一场雨',
        note: '第 1 帧的雨夜与第 2 帧的深夜连着，雨一直没停',
        confidence: 'inferred',
        box: null,
        emphasis: 'mention',
      },
      {
        type: 'continuity',
        title: '伞与箱子',
        note: '第 1 帧她撑着伞，第 3 帧只提着箱子——伞被留在了家里',
        confidence: 'inferred',
        box: null,
        emphasis: 'mention',
      },
    ],
  },
  {
    file: 'samples/frame-2.svg',
    name: '桌上的信',
    summary: '深夜的桌面：拆开的信封、露出的一截信纸、一把黄铜钥匙和一杯凉掉的茶。',
    details: [
      {
        type: 'object',
        title: '拆开的信封',
        note: '牛皮纸信封，封口已经拆开，边角被手指捏得发软',
        confidence: 'seen',
        box: [0.28, 0.6, 0.35, 0.36],
        emphasis: 'expand',
      },
      {
        type: 'object',
        title: '露出的信纸',
        note: '信纸从信封里露出一截，上面是手写的横线，纸色偏黄',
        confidence: 'seen',
        box: [0.27, 0.585, 0.36, 0.12],
        emphasis: 'mention',
      },
      {
        type: 'object',
        title: '黄铜钥匙',
        note: '一把很小的黄铜钥匙，齿口很新，就放在信封旁边',
        confidence: 'seen',
        box: [0.575, 0.87, 0.085, 0.06],
        emphasis: 'expand',
      },
      {
        type: 'object',
        title: '凉掉的茶',
        note: '白瓷杯，茶汤已经凉透，杯口浮着一层薄膜，还有一点热气',
        confidence: 'seen',
        box: [0.658, 0.66, 0.16, 0.23],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '台灯的光',
        note: '台灯只照亮桌面这一小块，其余的地方沉在暗处',
        confidence: 'seen',
        box: [0.74, 0.09, 0.12, 0.14],
        emphasis: 'mention',
      },
      {
        type: 'text',
        title: '信上的字',
        note: '笔画很重的字迹，纸背都被压出了印子，只看得清开头一行',
        confidence: 'seen',
        box: [0.325, 0.76, 0.1, 0.11],
        emphasis: 'mention',
      },
      {
        type: 'object',
        title: '旧邮票',
        note: '暗红色的旧邮票贴在信封右上角，盖着模糊的邮戳',
        confidence: 'seen',
        box: [0.55, 0.66, 0.045, 0.082],
        emphasis: 'mention',
      },
    ],
  },
  {
    file: 'samples/frame-3.svg',
    name: '清晨，站台',
    summary: '清晨的站台，一个女人提着旧箱子站在黄色安全线边，列车正进站。',
    details: [
      {
        type: 'person',
        title: '提箱子的女人',
        note: '深褐色长外套，头发挽在脑后，背对镜头站着，肩线很紧',
        confidence: 'seen',
        box: [0.245, 0.4, 0.09, 0.47],
        emphasis: 'expand',
      },
      {
        type: 'object',
        title: '旧行李箱',
        note: '深棕色皮箱，箱角磨白了，有两只轮子和一道旧皮带',
        confidence: 'seen',
        box: [0.18, 0.68, 0.085, 0.18],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '进站的列车',
        note: '银灰色车厢，车头灯亮着，车窗一格一格亮着暖光',
        confidence: 'seen',
        box: [0.5, 0.347, 0.5, 0.4],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '车窗的灯',
        note: '最近的一扇车窗亮着，能看见里面空着的座位',
        confidence: 'seen',
        box: [0.54, 0.424, 0.08, 0.083],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '站台黄线',
        note: '黄色安全线横过整个站台，边缘被踩得发灰',
        confidence: 'seen',
        box: [0, 0.78, 1, 0.02],
        emphasis: 'mention',
      },
      {
        type: 'scene',
        title: '低处的太阳',
        note: '太阳刚离开楼群，天边是橘粉色，站台上还留着凉气',
        confidence: 'seen',
        box: [0.165, 0.415, 0.09, 0.13],
        emphasis: 'mention',
      },
      {
        type: 'action',
        title: '没有回头',
        note: '她面朝车门站着，没有回头的动作',
        confidence: 'inferred',
        box: [0.245, 0.42, 0.12, 0.35],
        emphasis: 'mention',
      },
    ],
  },
];

async function loadSample({ silent = false } = {}) {
  if (state.story.status === 'streaming') {
    showToast('故事正在生成，先停止或等它完成，再载入示例。', true);
    return;
  }
  if (!silent && state.frames.length && !confirm('载入示例会替换当前项目，继续？')) return;
  if (!silent) showToast('正在准备示例图片…');

  try {
    const frames = [];
    for (const sample of SAMPLE_FRAMES) {
      const res = await fetch(sample.file);
      if (!res.ok) throw new Error('示例图片缺失');
      const blob = await res.blob();
      const file = new File([blob], sample.file.split('/').pop(), { type: 'image/svg+xml' });
      const { dataUrl, w, h } = await prepareImage(file);
      frames.push({
        id: uid(),
        name: sample.name,
        dataUrl,
        w,
        h,
        summary: sample.summary,
        note: '',
        status: 'done',
        error: '',
        details: sample.details.map((d) => ({
          ...d,
          id: uid(),
          emphasis: d.emphasis || 'mention',
          source: 'sample',
        })),
      });
    }

    state.frames = frames;
    state.activeId = frames[0].id;
    state.focusId = null;
    state.filter = 'all';
    state.story = { raw: SAMPLE_STORY, status: 'done', error: '', sample: true, updatedAt: Date.now() };
    renderAll();
    persist();
    showToast('示例已载入，接上 AI 就能重新识别。', false, 5000);
  } catch (err) {
    showToast('示例载入失败：' + err.message, true);
  }
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  /* frames */
  els.frameList.addEventListener('click', (e) => {
    const li = e.target.closest('.frame');
    if (!li) return;
    const id = li.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') return removeFrame(id);
    if (act === 'up') return shiftFrame(id, -1);
    if (act === 'down') return shiftFrame(id, 1);
    selectFrame(id);
  });

  els.frameList.addEventListener('keydown', (e) => {
    const li = e.target.closest('.frame');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectFrame(li.dataset.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = state.frames.findIndex((f) => f.id === li.dataset.id);
      if (state.frames[i + 1]) {
        selectFrame(state.frames[i + 1].id);
        focusSoon(`.frame[data-id="${state.frames[i + 1].id}"]`);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = state.frames.findIndex((f) => f.id === li.dataset.id);
      if (state.frames[i - 1]) {
        selectFrame(state.frames[i - 1].id);
        focusSoon(`.frame[data-id="${state.frames[i - 1].id}"]`);
      }
    }
  });

  els.frameList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.frame');
    if (!li) return;
    ui.dragId = li.dataset.id;
    li.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', li.dataset.id);
    } catch {
      /* ignore */
    }
  });

  els.frameList.addEventListener('dragend', () => {
    ui.dragId = null;
    $$('.frame', els.frameList).forEach((el) => el.classList.remove('is-dragging', 'is-drop'));
  });

  els.frameList.addEventListener('dragover', (e) => {
    const li = e.target.closest('.frame');
    if (!li || !ui.dragId) return;
    e.preventDefault();
    $$('.frame.is-drop', els.frameList).forEach((el) => el.classList.remove('is-drop'));
    if (li.dataset.id !== ui.dragId) li.classList.add('is-drop');
  });

  els.frameList.addEventListener('drop', (e) => {
    const li = e.target.closest('.frame');
    if (!li || !ui.dragId) return;
    e.preventDefault();
    const from = ui.dragId;
    ui.dragId = null;
    $$('.frame', els.frameList).forEach((el) => el.classList.remove('is-dragging', 'is-drop'));
    moveFrame(from, li.dataset.id);
  });

  /* upload */
  els.fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('is-over');
    });
  });
  els.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* viewer note */
  els.frameNote.addEventListener('input', () => {
    const frame = activeFrame();
    if (!frame) return;
    frame.note = els.frameNote.value;
    persist();
  });

  /* extraction */
  els.extractOneBtn.addEventListener('click', () => {
    const frame = activeFrame();
    if (!frame) return showToast('先选一帧。');
    if (state.busy) return;
    extractFrame(frame);
  });
  els.extractAllBtn.addEventListener('click', extractAll);

  /* 全部细节框的显示开关（图片右上角） */
  els.boxToggle.addEventListener('click', () => {
    state.showBoxes = !state.showBoxes;
    els.boxToggle.textContent = state.showBoxes ? '隐藏框' : '显示框';
    els.boxToggle.setAttribute('aria-pressed', String(state.showBoxes));
    els.boxes.classList.toggle('is-show-all', state.showBoxes);
    applyBoxFocus();
  });

  /* filters */
  els.filterRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderLedger();
  });

  /* details */
  els.detailList.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="clear-filter"]')) {
      state.filter = 'all';
      renderLedger();
      return;
    }

    const li = e.target.closest('.detail');
    if (!li) return;
    const frame = activeFrame();
    const detail = frame?.details.find((d) => d.id === li.dataset.id);
    if (!detail) return;

    const em = e.target.closest('[data-em]')?.dataset.em;
    if (em) return setEmphasis(detail, em);

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') {
      ui.editing = detail.id;
      renderLedger();
      return;
    }
    if (act === 'remove') {
      frame.details = frame.details.filter((d) => d.id !== detail.id);
      if (state.focusId === detail.id) state.focusId = null;
      renderAll();
      persist();
      return;
    }
    if (act === 'save') {
      const form = e.target.closest('.detail-edit');
      if (form) saveEdit(form, detail);
      return;
    }
    if (act === 'cancel') {
      ui.editing = null;
      renderLedger();
      return;
    }
    if (act === 'focus') return toggleFocus(detail);
  });

  els.detailList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.detail-edit input')) {
      e.preventDefault();
      const form = e.target.closest('.detail-edit');
      const detail = activeFrame()?.details.find((d) => d.id === form.dataset.id);
      if (detail) saveEdit(form, detail);
    }
    if (e.key === 'Escape' && ui.editing) {
      ui.editing = null;
      renderLedger();
    }
  });

  /* add detail */
  els.addDetail.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-save') return addManualDetail();
    if (act === 'add-cancel') {
      ui.adding = false;
      renderLedger();
    }
  });
  els.addDetail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      addManualDetail();
    }
    if (e.key === 'Escape' && ui.adding) {
      ui.adding = false;
      renderLedger();
    }
  });

  /* story */
  els.story.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="rewrite"]');
    if (btn) rewriteSection(Number(btn.dataset.index), btn);
  });

  els.story.addEventListener('keydown', (e) => {
    if (e.target.closest('.story-title') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });

  els.story.addEventListener(
    'blur',
    (e) => {
      const title = e.target.closest?.('.story-title');
      if (!title) return;
      const parsed = parseStory(state.story.raw);
      const next = (title.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (next === parsed.title) return;
      parsed.title = next;
      state.story.raw = rebuildStory(parsed);
      state.story.sample = false;
      renderStory();
      persist();
    },
    true
  );

  /* composer */
  els.modeRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode');
    if (!btn) return;
    state.settings.mode = btn.dataset.mode;
    renderComposer();
    persist();
  });

  els.povSelect.addEventListener('change', () => {
    state.settings.pov = els.povSelect.value;
    persist();
  });
  els.lengthSelect.addEventListener('change', () => {
    state.settings.length = els.lengthSelect.value;
    persist();
  });

  els.styleSelect.addEventListener('change', () => {
    state.settings.style = els.styleSelect.value;
    renderComposer();
    renderStory();
    persist();
  });
  els.presetSelect.addEventListener('change', () => {
    const key = els.presetSelect.value;
    const preset = PROMPT_PRESETS[key];
    if (key !== 'custom') {
      const current = state.settings.customPrompt;
      const original = PROMPT_PRESETS[state.settings.promptPreset]?.text || '';
      if (current && current !== original && current !== preset.text &&
          !confirm('应用预设会替换编辑框中的自定义内容，继续？')) {
        els.presetSelect.value = state.settings.promptPreset;
        return;
      }
      state.settings.customPrompt = preset.text;
    }
    state.settings.promptPreset = key;
    renderComposer();
    persist();
  });
  els.customPrompt.addEventListener('input', () => {
    state.settings.customPrompt = els.customPrompt.value;
    state.settings.promptPreset = 'custom';
    els.presetSelect.value = 'custom';
    persist();
  });

  els.generateBtn.addEventListener('click', generateStory);
  els.copyBtn.addEventListener('click', copyStory);
  els.exportBtn.addEventListener('click', exportMarkdown);
  els.clearStoryBtn.addEventListener('click', () => {
    if (!state.story.raw) return;
    if (!confirm('清除当前故事？细节清单会保留。')) return;
    state.story = { raw: '', status: 'idle', error: '', sample: false, updatedAt: 0 };
    renderStory();
    renderComposer();
    persist();
  });

  /* settings */
  els.settingsBtn.addEventListener('click', openSettings);
  els.connBtn.addEventListener('click', () => {
    if (!state.serverOk) {
      showToast('后端服务没有响应。本地开发请运行 node server.mjs；线上部署请刷新页面重试。', true, 8000);
      return;
    }
    openSettings();
  });
  els.cancelCfg.addEventListener('click', () => els.settings.close());
  els.testBtn.addEventListener('click', runTest);
  els.cfgAddProvider.addEventListener('click', () => {
    els.cfgProviders.insertAdjacentHTML('beforeend', providerRowHtml({ id: providerId() }));
    rebuildProviderOptions();
  });
  els.cfgProviders.addEventListener('click', (e) => {
    const btn = e.target.closest('.pr-del');
    if (!btn) return;
    btn.closest('.provider-row').remove();
    rebuildProviderOptions();
  });
  // 名称/地址改动时刷新下拉里的供应商显示名
  els.cfgProviders.addEventListener('input', () => rebuildProviderOptions());

  els.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = readConfigForm();
    state.config = next;
    saveConfig(next);
    renderConn();
    els.settings.close();
    showToast('设置已保存。');
  });

  /* projects */
  els.saveBtn.addEventListener('click', saveNow);
  els.projChip.addEventListener('click', () => {
    renderProjectList();
    if (typeof els.projectsDlg.showModal === 'function') els.projectsDlg.showModal();
  });
  els.closeProjects.addEventListener('click', () => els.projectsDlg.close());
  els.newProjectBtn.addEventListener('click', newProject);
  els.dupProjectBtn.addEventListener('click', () => {
    if (!hasContent()) {
      showToast('没有可另存的内容。');
      return;
    }
    openNameDialog('dup');
  });
  els.projectList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const li = btn?.closest('.project-row');
    if (!li) return;
    const id = li.dataset.id;
    const name = li.querySelector('.pr-name')?.textContent || '';
    if (btn.dataset.act === 'open') openProject(id);
    else if (btn.dataset.act === 'rename') openNameDialog('rename', id, name);
    else if (btn.dataset.act === 'del') removeProject(id, name);
  });
  els.nameCancel.addEventListener('click', () => els.nameDlg.close());
  els.nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim().slice(0, 24);
    if (!name) {
      showToast('给项目起个名字。', true);
      return;
    }
    els.nameDlg.close();

    if (ui.nameMode === 'save') {
      state.projectName = name;
      state.projectNamed = true;
      renderProjectBar();
      flushProject().then((ok) =>
        showToast(ok ? `已保存「${name}」。` : '保存失败，浏览器存储可能不可用。', !ok)
      );
    } else if (ui.nameMode === 'dup') {
      duplicateAs(name);
    } else if (ui.nameMode === 'rename' && ui.nameTarget) {
      const target = ui.nameTarget;
      renameProject(target, name).then((ok) => {
        if (ok && target === state.projectId) {
          state.projectName = name;
          state.projectNamed = true;
          renderProjectBar();
        }
        if (ok) queuePush(target);
        if (els.projectsDlg.open) renderProjectList();
        showToast(ok ? '已重命名。' : '重命名失败。', !ok);
      });
    }
  });

  /* sample / clear */
  els.sampleBtn.addEventListener('click', () => loadSample());
  els.clearBtn.addEventListener('click', () => {
    if (state.story.status === 'streaming') {
      showToast('故事正在生成，先停止或等它完成，再清空项目。', true);
      return;
    }
    if (!state.frames.length && !state.story.raw) {
      showToast('项目已经是空的。');
      return;
    }
    if (!confirm('清空当前项目？图片、细节和故事都会删除。')) return;
    state.frames = [];
    state.activeId = null;
    state.focusId = null;
    state.filter = 'all';
    state.story = { raw: '', status: 'idle', error: '', sample: false, updatedAt: 0 };
    ui.editing = null;
    ui.adding = false;
    renderAll();
    if (state.projectId) persist();
  });

  /* tabs */
  els.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    setPanel(tab.dataset.panel);
  });

  /* shortcuts */
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (e.target === els.customPrompt) return;
      e.preventDefault();
      generateStory();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveNow();
    }
  });

  /* 离开前尽量保存；推送不出去也没关系，下次启动的合并会补上 */
  window.addEventListener('pagehide', () => {
    if (ui.saveTimer) {
      clearTimeout(ui.saveTimer);
      ui.saveTimer = null;
    }
    if (!state.projectId && !hasContent() &&
        JSON.stringify(state.settings) === JSON.stringify(DEFAULT_SETTINGS)) return;
    flushProject();
    flushPushes();
  });
}

/* 所有声明就绪后再启动，避免暂时性死区 */
init();
