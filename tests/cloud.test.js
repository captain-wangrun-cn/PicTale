import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extOfDataUrl,
  imageKeyOf,
  packProject,
  planMerge,
  unpackProject,
} from '../js/cloud.js';
import { allowedOrigin, validImageKey, validProjectId } from '../worker/worker.js';

// 1x1 红色 PNG，已知内容稳定，用来做哈希与打包测试
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_SAME = PNG_1PX; // 同一张图
const JPG_1PX = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

test('extOfDataUrl 认识的图片格式', () => {
  assert.equal(extOfDataUrl(PNG_1PX), 'png');
  assert.equal(extOfDataUrl(JPG_1PX), 'jpg');
  assert.equal(extOfDataUrl('data:image/bmp;base64,AAAA'), null);
  assert.equal(extOfDataUrl('https://example.com/a.png'), null);
  assert.equal(extOfDataUrl(''), null);
});

test('imageKeyOf 生成内容寻址 key：格式、确定性、按内容区分', async () => {
  const key = await imageKeyOf(PNG_1PX);
  assert.match(key, /^[0-9a-f]{64}\.png$/);
  assert.equal(key, await imageKeyOf(PNG_SAME), '相同内容得到相同 key');
  assert.notEqual(key, (await imageKeyOf(JPG_1PX)).split('.')[0], '不同内容哈希不同');
  assert.equal(await imageKeyOf('data:image/bmp;base64,AAAA'), null, '不支持的格式返回 null');
});

test('packProject 把帧图换成 cf: 引用，去重、不改原记录', async () => {
  const record = {
    name: '测试项目',
    createdAt: 100,
    updatedAt: 200,
    data: {
      version: 2,
      frames: [
        { id: 'a', dataUrl: PNG_1PX, details: [] },
        { id: 'b', dataUrl: PNG_SAME, details: [] }, // 与 a 同图
        { id: 'c', dataUrl: 'cf:' + (await imageKeyOf(PNG_1PX)), details: [] }, // 已是引用
        { id: 'd', dataUrl: '', details: [] },
      ],
      activeId: 'a',
      settings: { mode: 'faithful' },
      story: { raw: '# 标题' },
    },
  };
  const snapshot = JSON.parse(JSON.stringify(record));

  const { body, images } = await packProject(record);

  assert.equal(images.length, 1, '同图只收集一次');
  assert.equal(images[0].key, await imageKeyOf(PNG_1PX));
  assert.equal(body.name, '测试项目');
  assert.match(body.data.frames[0].dataUrl, /^cf:[0-9a-f]{64}\.png$/);
  assert.equal(body.data.frames[1].dataUrl, body.data.frames[0].dataUrl, '同图引用相同');
  assert.equal(body.data.frames[3].dataUrl, '', '空 dataUrl 原样保留');
  assert.deepEqual(record, snapshot, '不修改传入的记录');
});

test('unpackProject 把引用换回 dataUrl，单图失败退回远程 URL', async () => {
  const key = await imageKeyOf(PNG_1PX);
  const cloud = {
    name: '云端项目',
    createdAt: 1,
    updatedAt: 2,
    data: {
      version: 2,
      frames: [
        { id: 'a', dataUrl: 'cf:' + key },
        { id: 'b', dataUrl: 'cf:' + (await imageKeyOf(JPG_1PX)) },
        { id: 'c', dataUrl: 'data:image/png;base64,AAAA' }, // 已是 dataURL，不动
      ],
    },
  };

  const rec = await unpackProject(
    cloud,
    (k) =>
      k === key
        ? Promise.resolve(PNG_1PX)
        : Promise.reject(new Error('下载失败')),
    (k) => `https://api.wris.me/img/${k}`
  );

  assert.equal(rec.data.frames[0].dataUrl, PNG_1PX);
  assert.equal(rec.data.frames[1].dataUrl, `https://api.wris.me/img/${await imageKeyOf(JPG_1PX)}`);
  assert.equal(rec.data.frames[2].dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(rec.name, '云端项目');
});

test('planMerge：云端新增 / 本地更新 / 各自更新 / 相同版本', () => {
  const plan = planMerge(
    [
      { id: 'both-remote-newer', updatedAt: 100 },
      { id: 'both-local-newer', updatedAt: 300 },
      { id: 'same', updatedAt: 200 },
      { id: 'local-only', updatedAt: 50 },
    ],
    {
      projects: [
        { id: 'both-remote-newer', updatedAt: 200 },
        { id: 'both-local-newer', updatedAt: 200 },
        { id: 'same', updatedAt: 200 },
        { id: 'cloud-only', updatedAt: 10 },
      ],
      deleted: [],
    }
  );
  assert.deepEqual(plan.pull.sort(), ['both-remote-newer', 'cloud-only'].sort());
  assert.deepEqual(plan.push.sort(), ['both-local-newer', 'local-only'].sort());
  assert.deepEqual(plan.removeLocal, []);
});

test('planMerge：墓碑比本地新则删本地，比本地旧则复活推送', () => {
  const plan = planMerge(
    [
      { id: 'deleted-elsewhere', updatedAt: 100 },
      { id: 'edited-after-delete', updatedAt: 500 },
      { id: 'untouched', updatedAt: 10 },
    ],
    {
      projects: [{ id: 'untouched', updatedAt: 10 }],
      deleted: [
        { id: 'deleted-elsewhere', deletedAt: 400 },
        { id: 'edited-after-delete', deletedAt: 200 },
        { id: 'never-seen', deletedAt: 999 },
      ],
    }
  );
  assert.deepEqual(plan.removeLocal, ['deleted-elsewhere']);
  assert.ok(plan.push.includes('edited-after-delete'), '删除后又编辑过的项目要重新推上去');
  assert.ok(!plan.push.includes('never-seen'), '本地不存在的墓碑不产生动作');
  assert.ok(!plan.pull.includes('deleted-elsewhere'), '墓碑项目不回拉');
});

test('planMerge：空云端与空本地', () => {
  assert.deepEqual(planMerge([], { projects: [], deleted: [] }), {
    pull: [],
    push: [],
    removeLocal: [],
  });
  assert.deepEqual(planMerge([{ id: 'x', updatedAt: 1 }], { projects: [], deleted: [] }), {
    pull: [],
    push: ['x'],
    removeLocal: [],
  });
});

/* ---------- Worker 纯函数 ---------- */

test('worker：合法的图片 key 与项目 id', () => {
  assert.ok(validImageKey('a'.repeat(64) + '.jpg'));
  assert.ok(validImageKey('0123456789abcdef'.repeat(4) + '.webp'));
  assert.ok(!validImageKey('A'.repeat(64) + '.jpg'), '大写不合法');
  assert.ok(!validImageKey('a'.repeat(63) + '.jpg'), '哈希长度不足');
  assert.ok(!validImageKey('a'.repeat(64) + '.bmp'), '扩展名不在白名单');
  assert.ok(!validImageKey('..%2Fetc%2Fpasswd'));

  assert.ok(validProjectId('0d0f2c88-1e2d-4c9f-9a33-a1b2c3d4e5f6'));
  assert.ok(validProjectId('id-1a2b3c4d'));
  assert.ok(!validProjectId('a/b'));
  assert.ok(!validProjectId(''));
  assert.ok(!validProjectId('x'.repeat(65)));
});

test('worker：跨域来源白名单（*.wris.me 与本机调试放行）', () => {
  const env = {};
  assert.ok(allowedOrigin('https://develop.wris.me', env));
  assert.ok(allowedOrigin('https://wris.me', env) === false, '裸域不属于子域');
  assert.ok(allowedOrigin('http://localhost:5173', env));
  assert.ok(allowedOrigin('http://127.0.0.1:5173', env));
  assert.ok(!allowedOrigin('https://evil.example.com', env));
  assert.ok(!allowedOrigin('https://sub.wris.me.evil.com', env), '后缀伪造不行');
  assert.ok(!allowedOrigin('ftp://develop.wris.me', env));
  assert.ok(!allowedOrigin('not a url', env));
  assert.ok(!allowedOrigin(null, env));

  assert.ok(allowedOrigin('https://foo.example.com', { ALLOWED_ORIGINS: 'https://foo.example.com, https://bar.example.com' }));
  assert.ok(!allowedOrigin('https://baz.example.com', { ALLOWED_ORIGINS: 'https://foo.example.com' }));
});
