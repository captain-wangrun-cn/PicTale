import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_CONFIG,
  chatTargetOf,
  hasApi,
  normalizeConfig,
  providerId,
  visionTargetOf,
} from '../js/api.js';

test('旧版单供应商配置迁移为多供应商结构', () => {
  const cfg = normalizeConfig({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old',
    chatModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o',
  });

  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.providers[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.providers[0].apiKey, 'sk-old');
  assert.equal(cfg.providers[0].name, 'api.openai.com');
  assert.equal(cfg.chatModel.providerId, cfg.providers[0].id);
  assert.equal(cfg.chatModel.model, 'gpt-4o-mini');
  assert.equal(cfg.visionModel.providerId, cfg.providers[0].id);
  assert.equal(cfg.visionModel.model, 'gpt-4o');
  assert.equal(cfg.storyImages, false);
});

test('旧版配置没有视觉模型时，视觉选择留空（运行时回退写作模型）', () => {
  const cfg = normalizeConfig({ baseUrl: 'https://a.com/v1', apiKey: 'k', chatModel: 'm' });
  assert.deepEqual(cfg.visionModel, { providerId: '', model: '' });
});

test('旧版配置没有接口地址时迁移出空供应商列表', () => {
  const cfg = normalizeConfig({ chatModel: 'gpt-4o-mini' });
  assert.deepEqual(cfg.providers, []);
  assert.deepEqual(cfg.chatModel, { providerId: '', model: 'gpt-4o-mini' });
});

test('多供应商配置原样保留，缺省字段补齐', () => {
  const cfg = normalizeConfig({
    providers: [
      { id: 'p-a', name: 'A', baseUrl: 'https://a.com/v1', apiKey: 'ka' },
      { name: '', baseUrl: '', apiKey: '' },
    ],
    chatModel: { providerId: 'p-a', model: 'm1' },
    visionModel: { providerId: 'p-b', model: 'm2' },
    storyImages: true,
  });

  assert.equal(cfg.providers[0].id, 'p-a');
  assert.match(cfg.providers[1].id, /^p-/); // 缺 id 自动生成
  assert.equal(cfg.providers[1].name, '供应商 2');
  assert.equal(cfg.visionModel.providerId, 'p-b');
  assert.equal(cfg.storyImages, true);
});

test('chatTargetOf 解析写作模型；指向的供应商不可用时回退到可用供应商', () => {
  const cfg = normalizeConfig({
    providers: [
      { id: 'p-a', name: 'A', baseUrl: 'https://a.com/v1', apiKey: 'ka' },
      { id: 'p-b', name: 'B', baseUrl: 'https://b.com/v1', apiKey: 'kb' },
    ],
    chatModel: { providerId: 'p-b', model: 'm-b' },
  });
  let target = chatTargetOf(cfg);
  assert.equal(target.provider.id, 'p-b');
  assert.equal(target.model, 'm-b');

  cfg.chatModel.providerId = 'p-missing';
  target = chatTargetOf(cfg);
  assert.equal(target.provider.id, 'p-a'); // 回退第一个可用供应商
  assert.equal(target.model, 'm-b');

  cfg.chatModel.model = '';
  assert.equal(chatTargetOf(cfg), null);
  assert.equal(hasApi(cfg), false);
});

test('visionTargetOf：留空回退写作模型，选全了用自己', () => {
  const cfg = normalizeConfig({
    providers: [
      { id: 'p-a', name: 'A', baseUrl: 'https://a.com/v1', apiKey: 'ka' },
      { id: 'p-b', name: 'B', baseUrl: 'https://b.com/v1', apiKey: 'kb' },
    ],
    chatModel: { providerId: 'p-a', model: 'chat-a' },
    visionModel: { providerId: '', model: '' },
  });

  let target = visionTargetOf(cfg);
  assert.equal(target.provider.id, 'p-a');
  assert.equal(target.model, 'chat-a');

  cfg.visionModel = { providerId: 'p-b', model: 'vision-b' };
  target = visionTargetOf(cfg);
  assert.equal(target.provider.id, 'p-b');
  assert.equal(target.model, 'vision-b');

  // 只选了供应商没填模型名 → 整体回退写作模型
  cfg.visionModel = { providerId: 'p-b', model: '' };
  target = visionTargetOf(cfg);
  assert.equal(target.provider.id, 'p-a');
  assert.equal(target.model, 'chat-a');
});

test('空配置没有可用目标', () => {
  assert.equal(chatTargetOf(EMPTY_CONFIG), null);
  assert.equal(visionTargetOf(EMPTY_CONFIG), null);
  assert.equal(hasApi(EMPTY_CONFIG), false);
  assert.match(providerId(), /^p-/);
});
