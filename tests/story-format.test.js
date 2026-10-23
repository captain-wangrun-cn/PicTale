import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrief,
  buildFrameBrief,
  buildStoryContext,
  buildTimeline,
  injectAnchors,
  parseStory,
  rebuildStory,
  stripStoryAnchors,
} from '../js/story-format.js';

const sample = [
  '# 黄铜钥匙',
  '',
  '引子第一段。',
  '',
  '### F01',
  '她把钥匙放进抽屉。',
  '',
  '### F02',
  '雨停之后，抽屉被拉开了一半。',
  '',
  '### F03',
  '钥匙不见了，桌上只剩一圈水印。',
  '',
].join('\n');

const rep = (ch, n) => ch.repeat(n);

test('parse/rebuild 往返保持结构', () => {
  const parsed = parseStory(sample);
  assert.equal(parsed.title, '黄铜钥匙');
  assert.equal(parsed.intro, '引子第一段。');
  assert.deepEqual(
    parsed.sections.map((s) => s.frame),
    ['F01', 'F02', 'F03']
  );
  assert.equal(parsed.sections[0].text, '她把钥匙放进抽屉。');

  const round = parseStory(rebuildStory(parsed));
  assert.deepEqual(round, parsed);
  assert.equal(rebuildStory(parsed), sample);
});

test('无帧标稿原样保留为引子', () => {
  const raw = '# 标题\n\n只是普通段落。\n\n## 小节\n\n更多文字。\n';
  const parsed = parseStory(raw);
  assert.equal(parsed.title, '标题');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].frame, '');
  assert.equal(parsed.sections[0].heading, '小节');
  assert.equal(parsed.intro, '只是普通段落。');
});

test('半截流式不崩且保留已到内容', () => {
  const raw = '# 未写完\n\n### F01\n她伸手去拿';
  const parsed = parseStory(raw);
  assert.equal(parsed.title, '未写完');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].frame, 'F01');
  assert.equal(parsed.sections[0].text, '她伸手去拿');

  const justHeading = parseStory('### F02');
  assert.equal(justHeading.sections[0].frame, 'F02');
  assert.equal(justHeading.sections[0].text, '');

  assert.doesNotThrow(() => parseStory('### F'));
  assert.equal(parseStory('### F').sections[0].frame, '');
});

test('支持三位及以上帧号，两位照旧补零', () => {
  const parsed = parseStory('### F7\n甲\n\n### F123\n乙\n\n### 第 1000 帧\n丙\n');
  assert.deepEqual(
    parsed.sections.map((s) => s.frame),
    ['F07', 'F123', 'F1000']
  );
  const rebuilt = rebuildStory(parsed);
  // 原行为：重建沿用原标题文字，帧键保持至少两位
  assert.match(rebuilt, /### F7\n甲/);
  assert.match(rebuilt, /### F123\n乙/);
  assert.match(rebuilt, /### 第 1000 帧\n丙/);
  assert.equal(parseStory(rebuilt).sections[2].frame, 'F1000');
});

test('普通标题含 F01 不被当帧锚点', () => {
  const raw = '# T\n\n### F01 的往事\n旧事重提。\n\n### F02\n新的。\n';
  const parsed = parseStory(raw);
  assert.equal(parsed.sections[0].frame, '');
  assert.equal(parsed.sections[0].heading, 'F01 的往事');
  assert.equal(parsed.sections[1].frame, 'F02');
  assert.match(rebuildStory(parsed), /### F01 的往事/);
});

test('剥标只去帧锚点，普通标题与围栏保留', () => {
  const raw = [
    '# 标题',
    '',
    '### F01',
    '第一段。',
    '',
    '## 第2帧',
    '第二段。',
    '',
    '### F01 的往事',
    '这是普通标题。',
    '',
    '```md',
    '### F03',
    '围栏里的内容不能删。',
    '```',
    '',
  ].join('\n');

  const out = stripStoryAnchors(raw);
  assert.doesNotMatch(out, /^### F01$/m);
  assert.doesNotMatch(out, /^## 第2帧$/m);
  assert.match(out, /### F01 的往事/);
  assert.match(out, /```md\n### F03\n围栏里的内容不能删。\n```/);
  assert.match(out, /# 标题\n\n第一段。/);
  assert.match(out, /第二段。/);
});

test('剥标对无锚点文本完全不变', () => {
  const raw = '# 标题\r\n\r\n### 第一章\r\n\r\n正文 F01 提及。\r\n';
  assert.equal(stripStoryAnchors(raw), raw);
  assert.equal(stripStoryAnchors(''), '');
});

test('围栏状态只被同种足长围栏关闭，嵌套不误判', () => {
  const raw = [
    '### F01',
    '前文。',
    '',
    '````md',
    '```',
    '### F02',
    '内层围栏里的标题保留。',
    '```',
    '````',
    '',
    '### F02',
    '真正的外层结束之后。',
    '',
  ].join('\n');

  const out = stripStoryAnchors(raw);
  assert.match(out, /```\n### F02\n内层围栏里的标题保留。\n```/);
  assert.match(out, /真正的外层结束之后。/);
  assert.doesNotMatch(out, /^### F01$/m);

  const parsed = parseStory(raw);
  // 围栏内的 ### F02 不产生新节；只有围栏外真正的 F02
  assert.deepEqual(
    parsed.sections.map((s) => s.frame),
    ['F01', 'F02']
  );
  assert.match(parsed.sections[0].text, /### F02\n内层围栏里的标题保留。/);
});

test('parseStory 与 strip 一致忽略围栏内标题，重建不损坏', () => {
  const raw = [
    '# 标题',
    '',
    '### F01',
    '正文。',
    '',
    '~~~text',
    '### F09',
    '```',
    '### F10',
    '```',
    '~~~',
    '',
    '### F02',
    '结尾。',
    '',
  ].join('\n');

  const parsed = parseStory(raw);
  assert.deepEqual(
    parsed.sections.map((s) => s.frame),
    ['F01', 'F02']
  );
  const rebuilt = rebuildStory(parsed);
  const reparsed = parseStory(rebuilt);
  assert.deepEqual(reparsed, parsed);
  assert.match(stripStoryAnchors(raw), /### F09\n```\n### F10\n```/);
});

test('剥标不折叠围栏内空行', () => {
  const raw = [
    '### F01',
    '前文。',
    '',
    '```',
    '第一行',
    '',
    '',
    '第二行',
    '```',
    '',
    '### F02',
    '后文。',
    '',
  ].join('\n');

  const out = stripStoryAnchors(raw);
  assert.match(out, /```\n第一行\n\n\n第二行\n```/);
  assert.doesNotMatch(out, /^### F01$/m);
  assert.doesNotMatch(out, /^### F02$/m);
  assert.match(out, /后文。/);
});

test('timeline 按当前顺序生成 F 标，忽略旧 label', () => {
  const frames = [
    { label: 'F09', summary: '结尾', note: '雨后' },
    { label: 'F01', summary: '', note: '' },
    { label: 'F05', summary: '中段' },
  ];
  const out = buildTimeline(frames);
  const lines = out.split('\n');
  assert.equal(lines[0], 'F01｜摘要：结尾｜备注：雨后');
  assert.equal(lines[1], 'F02｜（无摘要）');
  assert.equal(lines[2], 'F03｜摘要：中段');
  assert.equal(buildTimeline([]), '');
});

test('单帧简报保留细节优先级与推测标记', () => {
  const frame = {
    summary: '桌上有一只杯子',
    note: '别写雨',
    details: [
      { type: 'object', title: '杯子', note: '白色，杯沿有缺口', emphasis: 'expand' },
      { type: 'person', title: '短发女人', note: '站在窗边', emphasis: 'mention' },
      { type: 'continuity', title: '水痕', note: '延伸到门口', emphasis: 'skip', confidence: 'inferred' },
    ],
  };
  const out = buildFrameBrief(frame, 2);
  assert.match(out, /【第 3 帧 · F03】/);
  assert.match(out, /用户备注：别写雨/);
  assert.match(out, /画面摘要：桌上有一只杯子/);
  assert.match(out, /\[展开\] 物品｜杯子：白色，杯沿有缺口/);
  assert.match(out, /\[提及\] 人物｜短发女人/);
  assert.match(out, /\[略过\] 线索｜水痕：延伸到门口（推测）/);
  assert.match(buildFrameBrief({}, 0), /没有细节清单/);
});

test('全篇简报先声明连续故事，再时间线，最后细节', () => {
  const frames = [
    { summary: '开始', details: [{ type: 'scene', title: '门', note: '半开', emphasis: 'expand' }] },
    { summary: '结束', details: [] },
  ];
  const out = buildBrief(frames);
  assert.match(out, /同一个故事的不同时刻/);
  assert.match(out, /不要重新开场/);
  assert.match(out, /共 2 帧/);
  const timelineAt = out.indexOf('【全篇时间线】');
  const firstFrameAt = out.indexOf('【第 1 帧 · F01】');
  assert.ok(timelineAt >= 0 && timelineAt < firstFrameAt);
  assert.match(out, /F02｜摘要：结束/);
  assert.match(out, /\[展开\] 场景｜门：半开/);
});

test('上下文预算均匀且不漏最后一节结尾', () => {
  const parsed = {
    title: '长故事',
    intro: '引子'.repeat(50),
    sections: [
      { frame: 'F01', text: `${rep('甲', 400)}一结` },
      { frame: 'F02', text: `${rep('乙', 400)}二结` },
      { frame: 'F03', text: `${rep('丙', 400)}终章收束` },
    ],
  };
  const ctx = buildStoryContext(parsed, { maxChars: 600 });
  assert.match(ctx, /# 长故事/);
  assert.match(ctx, /【F01】/);
  assert.match(ctx, /【F02】/);
  assert.match(ctx, /【F03】/);
  assert.match(ctx, /终章收束/);
  assert.match(ctx, /一结/);
  assert.ok(ctx.length <= 600, `上下文超预算：${ctx.length}`);
});

test('上下文严格服从 maxChars（含超长标题与引子）', () => {
  const parsed = {
    title: rep('题', 500),
    intro: rep('引', 500),
    sections: [
      { frame: 'F01', text: rep('甲', 300) },
      { frame: 'F02', text: rep('乙', 300) },
      { frame: 'F03', text: `${rep('丙', 300)}末尾句。` },
    ],
  };

  for (const maxChars of [0, 1, 5, 20, 60, 120, 200, 400, 800, 1800]) {
    const ctx = buildStoryContext(parsed, { maxChars });
    assert.ok(ctx.length <= maxChars, `maxChars=${maxChars} 实际 ${ctx.length}`);
    if (maxChars >= 200) assert.match(ctx, /末尾句。/);
  }

  assert.equal(buildStoryContext(parsed, { maxChars: 0 }), '');
  assert.ok(buildStoryContext(parsed, { maxChars: 60 }).length <= 60);
});

test('上下文低预算时省略中间帧并明确标注，末帧保留', () => {
  const sections = Array.from({ length: 100 }, (_, i) => ({
    frame: `F${String(i + 1).padStart(2, '0')}`,
    text: `${rep('字', 60)}第${i + 1}段尾。`,
  }));
  const parsed = { title: '百帧', intro: '开场。', sections };

  for (const maxChars of [120, 300, 600, 1800]) {
    const ctx = buildStoryContext(parsed, { maxChars });
    assert.ok(ctx.length <= maxChars, `maxChars=${maxChars} 实际 ${ctx.length}`);
    assert.match(ctx, /【F100】/);
    assert.match(ctx, /第100段尾。/);
  }

  const tight = buildStoryContext(parsed, { maxChars: 300 });
  assert.match(tight, /已省略 \d+ 段/);
  assert.doesNotMatch(tight, /【F50】/);
  assert.match(tight, /【F01】/);

  const roomy = buildStoryContext(parsed, { maxChars: 6000 });
  assert.doesNotMatch(roomy, /已省略/);
  assert.ok(roomy.length <= 6000);
  assert.match(roomy, /【F01】/);
  assert.match(roomy, /【F100】/);
});

test('上下文均匀分配：短节不挤占长节预算', () => {
  const parsed = {
    sections: [
      { frame: 'F01', text: '短。' },
      { frame: 'F02', text: rep('长', 500) },
      { frame: 'F03', text: rep('尾', 500) },
    ],
  };
  const ctx = buildStoryContext(parsed, { maxChars: 400 });
  assert.ok(ctx.length <= 400);
  assert.match(ctx, /短。/);
  assert.match(ctx, /【F02】/);
  assert.match(ctx, /【F03】/);
});

test('上下文在无标题无引子时也可用', () => {
  const ctx = buildStoryContext({ sections: [{ frame: 'F01', text: '只有一句。' }] });
  assert.equal(ctx, '【F01】\n只有一句。');
  assert.equal(buildStoryContext(null), '');
});

test('injectAnchors 把无锚点故事按帧补注，标题保留且可回读', () => {
  const raw = '# 夜行\n\n她上了车。\n\n车开动了。\n\n天亮了。';
  const out = injectAnchors(raw, 3);
  const p = parseStory(out);
  assert.equal(p.title, '夜行');
  assert.equal(p.sections.length, 3);
  assert.equal(p.sections[0].frame, 'F01');
  assert.ok(p.sections[2].text.includes('天亮了'));
  // 已有锚点的故事原样返回
  const anchored = '# A\n\n### F01\n\nx';
  assert.equal(injectAnchors(anchored, 2), anchored);
});
