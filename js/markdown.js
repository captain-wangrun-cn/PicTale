// 显影 DEVELOP — 故事 Markdown 渲染
// 编辑页与画册页共用：段落、标题、列表、引用、分隔线，以及对话与加粗的色彩区分。
// 纯函数，不依赖 DOM API 之外的环境。

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function inlineMd(str) {
  let s = escapeHtml(str);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 对话上色：中文双引号（escapeHtml 后是 &quot;）与直角引号
  s = s.replace(/&quot;(.+?)&quot;/g, '<span class="story-say">&quot;$1&quot;</span>');
  s = s.replace(/「([^「」]+?)」/g, '<span class="story-say">「$1」</span>');
  return s;
}

// 相邻汉字/标点间的换行合并掉，其余换成空格
function joinLines(block) {
  return block.replace(/\n/g, (m, offset, str) => {
    const prev = str[offset - 1] || '';
    const next = str[offset + 1] || '';
    const cjk = /[一-龥，。！？；：、）」』】…—]/;
    return cjk.test(prev) && cjk.test(next) ? '' : ' ';
  });
}

function listHtml(lines, tag) {
  const items = lines
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ''))
    .map((l) => `<li>${inlineMd(l)}</li>`)
    .join('');
  return `<${tag} class="story-list">${items}</${tag}>`;
}

function renderBlock(block) {
  const b = block.trim();
  if (!b) return '';

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(b)) return '<hr class="story-hr">';

  const lines = b.split('\n');

  // 标题行独立渲染，其余行继续按块处理（标题后可能直接跟列表或段落）
  const h = lines[0].match(/^(#{1,6})\s+(.+)$/);
  if (h) {
    const rest = lines.slice(1).join('\n').trim();
    return `<h4 class="story-h">${inlineMd(h[2].trim())}</h4>` + (rest ? renderBlock(rest) : '');
  }

  if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return listHtml(lines, 'ul');
  if (lines.every((l) => /^\s*\d+[.、)]\s*/.test(l))) return listHtml(lines, 'ol');

  if (lines.every((l) => /^\s*>/.test(l))) {
    const quote = joinLines(lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'));
    return `<blockquote>${inlineMd(quote)}</blockquote>`;
  }

  return `<p>${inlineMd(joinLines(b))}</p>`;
}

export function mdToHtml(text) {
  const blocks = String(text || '').trim().split(/\n{2,}/);
  return blocks.map(renderBlock).filter(Boolean).join('');
}
