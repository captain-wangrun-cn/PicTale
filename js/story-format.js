// 显影 DEVELOP — 故事文本纯函数
// 解析 / 重建、去除帧标、上下文预算、时间线与细节简报。
// 不依赖 DOM，可在浏览器与 node:test 中直接使用。

import { EMPHASIS, TYPES } from './prompts.js';

const pad = (n) => String(n).padStart(2, '0');
const SEP = '\n\n';
const MIN_SECTION_BODY = 12;

// 帧锚点必须整行匹配：F + 数字，或 第N帧。
// 不做包含式匹配，避免把「### F01 的往事」这类普通标题当帧标。
const ANCHOR_F = /^F\s?(\d+)$/i;
const ANCHOR_CN = /^第\s*(\d+)\s*帧$/;
const HEADING = /^(#{2,3})\s+(.+)$/;

function frameKeyOf(heading) {
  const h = String(heading || '').trim();
  const f = h.match(ANCHOR_F);
  if (f) return `F${pad(f[1])}`;
  const cn = h.match(ANCHOR_CN);
  if (cn) return `F${pad(cn[1])}`;
  return '';
}

function fenceToken(line) {
  const t = String(line ?? '').trim();
  const m = t.match(/^(`{3,}|~{3,})/);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length, rest: t.slice(m[1].length) };
}

// 围栏只在「同种字符、长度不短于开启围栏、后面没有信息串」时关闭。
// 不同种或更短的围栏行按普通内容处理，避免嵌套围栏被意外关闭。
function nextFenceState(state, token) {
  if (!token) return state;
  if (!state) return { char: token.char, len: token.len };
  if (token.char === state.char && token.len >= state.len && token.rest.trim() === '') {
    return null;
  }
  return state;
}

export function parseStory(raw) {
  const out = { title: '', intro: '', sections: [] };
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const intro = [];
  let cur = null;
  let fence = null;

  for (const line of lines) {
    const token = fenceToken(line);
    if (token) {
      fence = nextFenceState(fence, token);
      if (cur) cur.text += line + '\n';
      else intro.push(line);
      continue;
    }

    if (!fence) {
      const t = line.trim();

      if (!out.title && /^#\s+/.test(t) && !/^##/.test(t)) {
        out.title = t.replace(/^#\s+/, '').trim();
        continue;
      }

      const h = t.match(HEADING);
      if (h) {
        const heading = h[2].trim();
        cur = { frame: frameKeyOf(heading), heading, text: '' };
        out.sections.push(cur);
        continue;
      }
    }

    if (cur) cur.text += line + '\n';
    else intro.push(line);
  }

  out.intro = intro.join('\n').trim();
  out.sections.forEach((s) => {
    s.text = s.text.trim();
  });
  return out;
}

export function rebuildStory(parsed) {
  const p = parsed || {};
  const parts = [];
  if (p.title) parts.push(`# ${p.title}`);
  if (p.intro) parts.push(p.intro);
  const sections = Array.isArray(p.sections) ? p.sections : [];
  sections.forEach((s) => {
    parts.push(`### ${s.heading || s.frame || '片段'}\n${String(s.text || '').trim()}`);
  });
  return parts.join(SEP) + '\n';
}

// 只去掉已识别的帧标标题行；普通 Markdown 标题与代码围栏原样保留。
// 无帧标时返回原始文本（连换行风格也不动）。
export function stripStoryAnchors(raw) {
  const text = String(raw ?? '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let fence = null;
  let removed = false;

  for (const line of lines) {
    const token = fenceToken(line);
    if (token) {
      fence = nextFenceState(fence, token);
      kept.push(line);
      continue;
    }

    if (!fence) {
      const h = line.trim().match(HEADING);
      if (h && frameKeyOf(h[2].trim())) {
        removed = true;
        continue;
      }
    }

    kept.push(line);
  }

  if (!removed) return text;

  // 只在围栏外折叠连续空行，围栏内的空行原样保留。
  const out = [];
  let scanFence = null;
  for (const line of kept) {
    const token = fenceToken(line);
    if (token) {
      scanFence = nextFenceState(scanFence, token);
      out.push(line);
      continue;
    }
    if (!scanFence && line.trim() === '' && out.length && out[out.length - 1].trim() === '') {
      continue;
    }
    out.push(line);
  }

  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

// 在硬预算内截取一段文字；保留开头与结尾，末尾可加权。
function excerpt(text, budget, { tailBias = false } = {}) {
  const t = String(text ?? '').trim();
  const b = Math.max(0, Math.floor(budget));
  if (b <= 0) return '';
  if (t.length <= b) return t;
  if (b === 1) return t.slice(0, 1);

  const ell = '…';
  const room = b - ell.length;
  if (room < 2) return t.slice(0, b);

  let tail = Math.floor(room / 2);
  let head = room - tail;
  if (tailBias) {
    tail = Math.ceil(room * 0.6);
    head = room - tail;
  }
  return t.slice(0, head) + ell + t.slice(-tail);
}

// 均匀采样，始终包含第一段与最后一段。
function sampleIndices(n, k) {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k <= 0) return [];
  if (k === 1) return [n - 1];

  const out = [0];
  for (let j = 1; j < k - 1; j += 1) {
    const idx = Math.round((j * (n - 1)) / (k - 1));
    if (idx > out[out.length - 1] && idx < n - 1) out.push(idx);
  }
  if (n - 1 > out[out.length - 1]) out.push(n - 1);
  return out;
}

// 把总预算分给若干段：短段落吃满自己的长度，剩余预算再均分给长段落。
function allocateBudgets(lengths, budget) {
  const out = new Array(lengths.length).fill(0);
  let remaining = Math.max(0, Math.floor(budget));
  let active = lengths.map((_, i) => i);

  while (active.length && remaining > 0) {
    const per = Math.floor(remaining / active.length);
    if (per <= 0) break;

    const next = [];
    let assigned = false;
    for (const i of active) {
      if (lengths[i] <= per) {
        out[i] = lengths[i];
        remaining -= lengths[i];
        assigned = true;
      } else {
        next.push(i);
      }
    }

    if (!assigned) {
      let left = remaining - per * next.length;
      for (const i of next) {
        out[i] = per + (left > 0 ? 1 : 0);
        if (left > 0) left -= 1;
      }
      break;
    }
    active = next;
  }

  return out;
}

// 为改写单帧准备全篇上下文：标题、引子、每节首尾。
// 严格遵守 maxChars；帧多时均匀采样并明确标注省略，末段始终保留。
export function buildStoryContext(parsed, { maxChars = 1800 } = {}) {
  const p = parsed || {};
  const requested = Number(maxChars);
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 1800;
  if (limit <= 0) return '';

  const title = String(p.title || '').trim();
  const intro = String(p.intro || '').trim();
  const sections = Array.isArray(p.sections) ? p.sections : [];
  const n = sections.length;

  const labelOf = (i) => `【${sections[i]?.frame || `F${pad(i + 1)}`}】`;
  const textOf = (i) => String(sections[i]?.text || '').trim();

  // 标题 + 引子最多占 35%，单条都按硬上限截断。
  const headerBudget = Math.floor(limit * 0.35);
  let headers = [];
  if (title && headerBudget > 2) {
    const cap = Math.min(title.length, Math.max(0, Math.floor(headerBudget * 0.6) - 2));
    const t = excerpt(title, cap);
    if (t) headers.push(`# ${t}`);
  }
  if (intro) {
    const used = headers.reduce((a, b) => a + b.length, 0) + (headers.length ? SEP.length : 0);
    const cap = Math.min(intro.length, Math.max(0, headerBudget - used));
    const t = excerpt(intro, cap);
    if (t) headers.push(t);
  }

  let headerLen =
    headers.reduce((a, b) => a + b.length, 0) + Math.max(0, headers.length - 1) * SEP.length;
  let space = Math.max(0, limit - headerLen - (headers.length ? SEP.length : 0));

  if (!n) return headers.join(SEP);

  const lastLabel = labelOf(n - 1);
  const lastText = textOf(n - 1);
  const lastFixed = lastLabel.length + 1;

  // 预算不足以给末段留位置时，优先舍弃标题和引子。
  if (headers.length && space < lastFixed + MIN_SECTION_BODY) {
    headers = [];
    headerLen = 0;
    space = limit;
  }

  const sectionBlocks = (() => {
    if (space <= 0) return [];

    if (space < lastFixed) {
      const body = excerpt(lastText, space, { tailBias: true });
      return body ? [body] : [];
    }

    const makePlan = (idx, omitText) => {
      const labels = idx.reduce((a, i) => a + labelOf(i).length + 1, 0);
      const blocks = idx.length + (omitText ? 1 : 0);
      const fixed =
        labels + (omitText ? omitText.length : 0) + Math.max(0, blocks - 1) * SEP.length;
      return { idx, omitText, body: space - fixed };
    };

    const all = Array.from({ length: n }, (_, i) => i);
    const full = makePlan(all, '');
    let plan = full.body >= n * MIN_SECTION_BODY ? full : null;

    if (!plan) {
      const maxK = Math.min(n - 1, 48);
      for (let k = maxK; k >= 1; k -= 1) {
        const idx = sampleIndices(n, k);
        if (!idx.length) continue;
        const omitText = idx.length < n ? `（已省略 ${n - idx.length} 段）` : '';
        const candidate = makePlan(idx, omitText);
        if (candidate.body >= idx.length * MIN_SECTION_BODY) {
          plan = candidate;
          break;
        }
      }
    }

    if (!plan) {
      const body = excerpt(lastText, Math.max(0, space - lastFixed), { tailBias: true });
      return [body ? `${lastLabel}\n${body}` : lastLabel];
    }

    const texts = plan.idx.map(textOf);
    const budgets = allocateBudgets(
      texts.map((t) => t.length),
      Math.max(0, plan.body)
    );
    const blocks = plan.idx.map((i, j) => {
      const body = excerpt(texts[j], budgets[j], { tailBias: i === n - 1 });
      return body ? `${labelOf(i)}\n${body}` : labelOf(i);
    });
    if (plan.omitText) blocks.unshift(plan.omitText);
    return blocks;
  })();

  return [...headers, ...sectionBlocks].join(SEP);
}

// 故事缺少帧锚点时，按帧数把引子段落按文字量比例切成 F01…Fn，
// 让逐帧重写与画册图文配对可用。锚点只是编辑标记，导出时会剥掉。
export function injectAnchors(raw, frameCount) {
  const n = Math.max(1, Math.floor(Number(frameCount) || 1));
  const p = parseStory(raw);
  const paras = String(p.intro || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!paras.length) return String(raw ?? '');

  // 段落中点落在哪一帧的份额里就归哪一帧，长段不切开
  const blocks = Array.from({ length: n }, () => []);
  const total = paras.reduce((sum, s) => sum + s.length, 0);
  let acc = 0;
  paras.forEach((para) => {
    const mid = acc + para.length / 2;
    blocks[Math.min(n - 1, Math.floor((mid / total) * n))].push(para);
    acc += para.length;
  });

  const sections = blocks
    .map((b, i) => ({
      frame: `F${pad(i + 1)}`,
      heading: `F${pad(i + 1)}`,
      text: b.join('\n\n'),
    }))
    .filter((s) => s.text);

  if (!sections.length) return String(raw ?? '');
  return rebuildStory({ title: p.title, intro: '', sections });
}

// 按当前顺序列出 F 标、摘要与备注；不读取旧 label，也不补写因果。
export function buildTimeline(frames) {
  const list = Array.isArray(frames) ? frames : [];
  return list
    .map((frame, i) => {
      const f = frame || {};
      const label = `F${pad(i + 1)}`;
      const bits = [];
      const summary = String(f.summary || '').trim();
      const note = String(f.note || '').trim();
      if (summary) bits.push(`摘要：${summary}`);
      if (note) bits.push(`备注：${note}`);
      return `${label}｜${bits.length ? bits.join('｜') : '（无摘要）'}`;
    })
    .join('\n');
}

// 单帧细节简报，用于只重写目标帧。
export function buildFrameBrief(frame, index) {
  const f = frame || {};
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const lines = [`【第 ${i + 1} 帧 · F${pad(i + 1)}】`];

  const note = String(f.note || '').trim();
  const summary = String(f.summary || '').trim();
  if (note) lines.push(`用户备注：${note}`);
  if (summary) lines.push(`画面摘要：${summary}`);

  const details = Array.isArray(f.details) ? f.details : [];
  if (!details.length) {
    lines.push('（这一帧没有细节清单，只能依据画面摘要写。）');
    return lines.join('\n');
  }

  details.forEach((d) => {
    const detail = d || {};
    const type = TYPES[detail.type]?.label || '细节';
    const mark = detail.confidence === 'inferred' ? '（推测）' : '';
    const level = EMPHASIS[detail.emphasis]?.word || '提及';
    lines.push(`· [${level}] ${type}｜${detail.title || ''}：${detail.note || ''}${mark}`);
  });

  return lines.join('\n');
}

// 全篇简报：先说明这是同一故事的连续时刻，再时间线，最后逐帧细节。
export function buildBrief(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const timeline = buildTimeline(list);
  const lines = [
    `【故事设定】共 ${list.length} 帧，全部图片属于同一个故事的不同时刻，按画面顺序前后承接；` +
      '请顺着已有情节往下写，不要重新开场，也不要另起一个故事。',
  ];

  if (timeline) lines.push('', '【全篇时间线】', timeline);

  list.forEach((frame, i) => {
    lines.push('');
    lines.push(buildFrameBrief(frame, i));
  });

  return lines.join('\n');
}
