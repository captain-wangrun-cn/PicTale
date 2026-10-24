import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  LENGTHS,
  PROMPT_PRESETS,
  STYLES,
  extractMessages,
  normalizeSettings,
  rewriteMessages,
  storyMessages,
  writingRules,
} from '../js/prompts.js';

test('默认设置完整且每次返回新对象', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    mode: 'polish',
    pov: 'third',
    length: 'medium',
    style: 'natural',
    promptPreset: 'default',
    customPrompt: '',
  });

  const a = normalizeSettings();
  const b = normalizeSettings();
  assert.deepEqual(a, DEFAULT_SETTINGS);
  assert.notEqual(a, b);
  assert.notEqual(a, DEFAULT_SETTINGS);
});

test('非法枚举与非法文本类型回退到默认值', () => {
  const s = normalizeSettings({
    mode: 'unknown',
    pov: 42,
    length: 'huge',
    style: 'fancy',
    promptPreset: 'nope',
    customPrompt: { text: 'x' },
  });
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('旧设置（缺少新字段）可迁移并保留原有值', () => {
  const s = normalizeSettings({ mode: 'free', pov: 'first', length: 'long' });
  assert.equal(s.mode, 'free');
  assert.equal(s.pov, 'first');
  assert.equal(s.length, 'long');
  assert.equal(s.style, DEFAULT_SETTINGS.style);
  assert.equal(s.promptPreset, DEFAULT_SETTINGS.promptPreset);
  assert.equal(s.customPrompt, '');
});

test('每种风格都有 label/hint 并生成对应规则', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label])),
    { natural: '自然', plain: '直白', artistic: '艺术', subtle: '委婉' }
  );

  for (const key of Object.keys(STYLES)) {
    const style = STYLES[key];
    assert.equal(typeof style.label, 'string');
    assert.equal(typeof style.hint, 'string');
    assert.ok(style.label.length > 0);
    assert.ok(style.hint.length > 0);
    assert.ok(style.rule.startsWith(`风格：${style.label}。`), `${key} 的 rule 与 label 不一致`);

    const rules = writingRules({ style: key });
    assert.ok(rules.includes(style.rule), `缺少 ${key} 的风格规则`);
  }
});

test('自定义文本：空、多行、原样保留不截断', () => {
  const empty = writingRules({ customPrompt: '' });
  assert.ok(!empty.includes('用户补充要求'));

  const multiline = '第一行要求\n第二行要求\n\n第四行要求';
  const rules = writingRules({ customPrompt: multiline });
  assert.ok(rules.includes(multiline));
  assert.ok(rules.includes('用户补充要求'));

  const long = '长'.repeat(5000);
  assert.ok(writingRules({ customPrompt: long }).includes(long));
});

test('预设只是 UI 填框来源，空 customPrompt 不偷换预设文本', () => {
  for (const key of Object.keys(PROMPT_PRESETS)) {
    const preset = PROMPT_PRESETS[key];
    assert.equal(typeof preset.label, 'string');
    assert.equal(typeof preset.text, 'string');
  }
  assert.equal(PROMPT_PRESETS.default.text, '');
  assert.equal(PROMPT_PRESETS.custom.text, '');
  const natural = PROMPT_PRESETS.natural.text;
  assert.ok(natural.includes('具体'));
  assert.ok(natural.includes('套话'));
  assert.ok(natural.includes('对话简洁'));
  assert.ok(natural.includes('同一个故事'));
  assert.ok(natural.includes('反复开场或收尾'));
  assert.ok(!/越狱|忽略.{0,4}规则|绕过|不设限|无限制|情色/i.test(natural));

  const rules = writingRules({ promptPreset: 'natural', customPrompt: '' });
  assert.ok(!rules.includes(PROMPT_PRESETS.natural.text));
  assert.ok(!rules.includes('用户补充要求'));

  const edited = writingRules({ promptPreset: 'natural', customPrompt: '我改过的要求' });
  assert.ok(edited.includes('我改过的要求'));
  assert.ok(!edited.includes(PROMPT_PRESETS.natural.text));
});

test('生成与重写使用同一套设置规则', () => {
  const settings = {
    mode: 'faithful',
    pov: 'narration',
    length: 'short',
    style: 'subtle',
    promptPreset: 'custom',
    customPrompt: '不要出现对白',
  };
  const rules = writingRules(settings);
  const gen = storyMessages({ brief: '素材', ...settings });
  const rew = rewriteMessages({
    frameKey: 'F02',
    target: '旧段落',
    before: '前文',
    after: '后文',
    storyContext: '整体',
    frameBrief: '画面',
    ...settings,
  });

  assert.ok(gen[1].content.includes(rules));
  for (const shared of [
    '方式：忠实。',
    '视角：旁白',
    STYLES.subtle.rule,
    '用户补充要求：\n不要出现对白',
  ]) {
    assert.ok(gen[1].content.includes(shared), `生成缺少：${shared}`);
    assert.ok(rew[1].content.includes(shared), `重写缺少：${shared}`);
  }
  assert.ok(rew[1].content.includes('重写后的这一段'));
  assert.ok(rew[0].content.includes('同一条故事时间线'));
});

test('篇幅非法值回退，生成按全篇而非每帧均分，重写保持比例', () => {
  const gen = writingRules({ length: 'huge' });
  assert.ok(gen.includes(LENGTHS.medium.total));
  assert.ok(gen.includes('整篇'));
  assert.ok(gen.includes('不要为每一帧平均切分'));
  assert.ok(!gen.includes(LENGTHS.medium.per));

  const rew = writingRules({ length: 'huge' }, { rewrite: true });
  assert.ok(rew.includes('大致相当'));
  assert.ok(rew.includes('比例'));
});

test('故事系统提示要求连续时间线与编辑锚点', () => {
  const system = storyMessages({ brief: '素材' })[0].content;
  assert.ok(system.includes('同一条故事时间线'));
  assert.ok(system.includes('只在最后一段收束'));
  assert.ok(system.includes('编辑锚点'));
  assert.ok(system.includes('跨锚点'));
  assert.ok(system.includes('不要为每帧写成一个独立小故事'));
  assert.ok(system.includes('正文里不要写'));
  assert.ok(system.includes('推测'));
  assert.ok(system.includes('至少两位帧号'));
  assert.ok(system.includes('超过 99 帧'));
  assert.ok(system.includes('以【写作要求】里的方式为准'));
  assert.ok(!system.includes('不要添加清单和用户备注之外的具名人物'));

  const free = writingRules({ mode: 'free' });
  assert.ok(free.includes('人名'));
  assert.ok(free.includes('不能和画面细节或用户要求相矛盾'));
  assert.ok(free.includes('推测内容仍不得写成事实'));

  const faithful = writingRules({ mode: 'faithful' });
  assert.ok(faithful.includes('不新增具名人物'));
  const polish = writingRules({ mode: 'polish' });
  assert.ok(polish.includes('不新增具名人物'));
});

test('重写：末段可收束，非末段不能结尾', () => {
  const last = rewriteMessages({ frameKey: 'F09', target: 't', isLast: true });
  assert.ok(last[0].content.includes('最后一段'));
  assert.ok(last[0].content.includes('可以收束故事'));

  const middle = rewriteMessages({
    frameKey: 'F02',
    target: 't',
    storyContext: '整体故事',
    frameBrief: 'F02 的画面',
  });
  assert.ok(middle[0].content.includes('不是最后一段'));
  assert.ok(middle[0].content.includes('不要写结尾'));

  assert.ok(middle[1].content.includes('【整体故事上下文】\n整体故事'));
  assert.ok(middle[1].content.includes('【这一段对应的画面依据】\nF02 的画面'));
});

test('识别请求包含连续故事规则且不混入自定义创作 prompt', () => {
  const custom = '这是创作要求：写成悬疑故事';
  const messages = extractMessages({
    index: 1,
    total: 3,
    prevSummary: '上一帧摘要',
    note: '说明',
    dataUrl: 'data:image/png;base64,AAAA',
  });
  const all = messages.map((m) => JSON.stringify(m)).join('\n');
  assert.ok(all.includes('同一个连续故事'));
  assert.ok(all.includes('上一帧摘要'));
  assert.ok(all.includes('不能仅凭'));

  const withSettings = extractMessages({
    index: 0,
    total: 1,
    dataUrl: 'data:image/png;base64,AAAA',
    ...normalizeSettings({ customPrompt: custom }),
  });
  assert.ok(!withSettings.map((m) => JSON.stringify(m)).join('\n').includes(custom));
});

test('storyMessages 不传图时用户消息保持纯文本', () => {
  const messages = storyMessages({ brief: '【简报】', mode: 'faithful' });
  assert.equal(messages.length, 2);
  assert.equal(typeof messages[1].content, 'string');
  assert.ok(messages[1].content.includes('【简报】'));
  assert.ok(!JSON.stringify(messages).includes('image_url'));
});

test('storyMessages 传图时按顺序附加原图并说明用途', () => {
  const images = [
    'data:image/jpeg;base64,AAAA',
    'data:image/jpeg;base64,BBBB',
  ];
  const messages = storyMessages({ brief: '【简报】', images, mode: 'faithful' });
  const content = messages[1].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, 'text');
  assert.ok(content[0].text.includes('F01、F02'));
  assert.equal(content.length, 3);
  assert.equal(content[1].image_url.url, images[0]);
  assert.equal(content[2].image_url.url, images[1]);
});

test('rewriteMessages 传图时附上该帧原图；不传时保持纯文本', () => {
  const base = {
    frameKey: 'F02',
    target: '第二段正文',
    before: '第一段结尾',
    after: '',
    note: '',
    storyContext: '整体',
    frameBrief: '画面依据',
  };
  const plain = rewriteMessages(base);
  assert.equal(typeof plain[1].content, 'string');

  const withImg = rewriteMessages({
    ...base,
    images: ['data:image/png;base64,CCCC'],
  });
  const content = withImg[1].content;
  assert.ok(Array.isArray(content));
  assert.ok(content[0].text.includes('末尾附有这一帧的原图'));
  assert.equal(content[1].image_url.url, 'data:image/png;base64,CCCC');
});
