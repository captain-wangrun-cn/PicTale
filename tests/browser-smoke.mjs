// 显影 DEVELOP — 真实浏览器冒烟测试
// 只依赖 Node 24 内置能力（fetch / WebSocket / node:test），通过本机 Edge/Chrome 的
// CDP 驱动真实页面。所有 /api/proxy 请求由 CDP Fetch 拦截到进程内的 mock 服务，
// 不会转发到任何真实模型 API；使用一次性临时 profile，不读取用户数据。
//
// 运行：node tests/browser-smoke.mjs
// 可选：BROWSER_PATH=/path/to/msedge.exe

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = process.env.SMOKE_DEBUG === '1';
const dbg = (...args) => {
  if (DEBUG) console.log('[dbg]', ...args);
};

const CUSTOM_PROMPT = 'SMOKE-CUSTOM：只写雨声、伞和钥匙，不要解释人物内心。';

const FULL_STORY =
  '# 雨停之前\n\n' +
  '### F01\n' +
  '第一段测试正文：红伞靠在站牌边，雨顺着伞骨往下滴，她没有看手机。\n\n' +
  '### F02\n' +
  '第二段测试正文：信封拆开一半，黄铜钥匙压在信纸边上，茶已经凉了。\n\n' +
  '### F03\n' +
  '第三段测试正文：清晨的站台起雾，列车进站，她提着旧箱子跨过黄线。';

/* ------------------------------------------------------------------ */
/* mock 上游（SSE / JSON），只被 CDP 重定向到这里                     */
/* ------------------------------------------------------------------ */

function sseData(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}

function chunkify(text, parts) {
  const size = Math.ceil(text.length / parts);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function startMock() {
  const streams = new Map();
  const hits = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://mock');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === '/sse' || /^\/stream\/\d+\/chat\/completions$/.test(url.pathname)) {
      const sid = url.pathname === '/sse' ? Number(url.searchParams.get('sid')) : Number(url.pathname.split('/')[2]);
      const st = streams.get(sid);
      dbg('mock sse hit', sid, req.method, !!st);
      req.resume();
      if (!st) {
        res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
        res.end('unknown stream');
        return;
      }
      res.writeHead(200, {
        ...cors,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      });
      st.started = true;
      st.res = res;
      res.on('close', () => {
        if (!st.finished) st.aborted = true;
        st.release?.();
      });

      const splitAt = FULL_STORY.indexOf('### F02');
      const pre = FULL_STORY.slice(0, splitAt);
      const post = FULL_STORY.slice(splitAt);
      for (const chunk of chunkify(pre, 3)) {
        if (st.aborted || res.writableEnded) return;
        res.write(sseData(chunk));
        await sleep(25);
      }
      await new Promise((resolve) => {
        st.release = resolve;
        if (st.aborted || st.released) resolve();
      });
      if (st.aborted || res.writableEnded) return;
      for (const chunk of chunkify(post, 3)) {
        if (st.aborted || res.writableEnded) break;
        res.write(sseData(chunk));
        await sleep(20);
      }
      if (!st.aborted && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        st.finished = true;
        res.end();
      }
      return;
    }

    if (url.pathname === '/release') {
      const sid = Number(url.searchParams.get('sid'));
      streams.get(sid)?.release?.();
      res.writeHead(200, { ...cors, 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/state') {
      const sid = Number(url.searchParams.get('sid'));
      const st = streams.get(sid);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(st ? { started: st.started, aborted: st.aborted, finished: st.finished } : null));
      return;
    }

    if (url.pathname === '/chat/completions') {
      let body = '';
      for await (const c of req) body += c;
      hits.push({ path: url.pathname, body });
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '可用' } }] }));
      return;
    }

    res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    register(sid) {
      streams.set(sid, { started: false, aborted: false, finished: false, release: null, res: null });
    },
    release(sid) {
      const st = streams.get(sid);
      if (st) st.released = true;
      st?.release?.();
    },
    state(sid) {
      const st = streams.get(sid);
      return st ? { started: st.started, aborted: st.aborted, finished: st.finished } : null;
    },
    async close() {
      for (const st of streams.values()) st.release?.();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ------------------------------------------------------------------ */
/* 子进程 / 端口 / 浏览器                                               */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || '';
}

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    k.once('exit', () => resolve());
    k.once('error', () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

async function waitHttp(url, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return res;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

/* ------------------------------------------------------------------ */
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

test('真实浏览器冒烟：示例 / 风格 / Prompt / 生成 / 重写 / 项目 / 移动端', { timeout: 300000 }, async (t) => {
  const cleanup = [];
  const shots = await mkdtemp(path.join(tmpdir(), 'xianying-smoke-'));
  const profile = await mkdtemp(path.join(tmpdir(), 'xianying-profile-'));
  const screenshotPaths = [];
  const uncaught = [];

  let cdp;
  let sid;
  let pageSend;
  let evalJS;
  let waitFor;
  let click;
  let setValue;
  let selectValue;
  let goto;
  let shot;
  let dialogPolicy = { accept: true };
  let mock;
  let serverProc;

  const captures = { generate: [], rewrite: [], other: [] };
  const streamSeq = { n: 0 };
  const blocked = new Set();

  const classify = (messages) => {
    const sys = typeof messages?.[0]?.content === 'string' ? messages[0].content : '';
    if (sys.includes('极其挑剔的视觉编辑')) return 'extract';
    if (sys.includes('第二遍补漏')) return 'supplement';
    if (sys.includes('你是图片编辑')) return 'continuity';
    if (sys.includes('你在修改一篇')) return 'rewrite';
    if (sys.includes('只回复两个字')) return 'ping';
    return 'unknown';
  };

  const mockContent = (kind) => {
    switch (kind) {
      case 'extract':
        return JSON.stringify({
          summary: '冒烟测试摘要',
          details: [{ type: 'object', title: '测试物件', note: '左侧，灰色，完好', confidence: 'seen' }],
        });
      case 'supplement':
        return '{"details":[]}';
      case 'continuity':
        return '{"links":[]}';
      case 'ping':
        return '可用';
      case 'rewrite':
        return '### F02\n这是重写后的第二段正文，只有这一段被替换。';
      default:
        return '{}';
    }
  };

  try {
    /* ---------- 静态服务（真实 server.mjs，随机端口） ---------- */
    const appPort = await freePort();
    const appBase = `http://127.0.0.1:${appPort}`;
    serverProc = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup.push(() => killTree(serverProc));
    await waitHttp(`${appBase}/api/health`);

    /* ---------- mock 上游 ---------- */
    mock = await startMock();
    cleanup.push(() => mock.close());

    /* ---------- 浏览器（临时 profile） ---------- */
    const browserPath = findBrowser();
    assert.ok(browserPath, '未找到 Edge/Chrome，可用 BROWSER_PATH 指定');
    const debugPort = await freePort();
    const browserProc = spawn(
      browserPath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-features=Translate,OptimizationHints,MediaRouter,msEdgeSidebarV2,msEdgeCollections',
        '--mute-audio',
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debugPort}`,
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    cleanup.push(() => killTree(browserProc));
    let browserErr = '';
    browserProc.stderr.on('data', (d) => {
      browserErr = (browserErr + d.toString()).slice(-4000);
    });

    const versionRes = await waitHttp(`http://127.0.0.1:${debugPort}/json/version`, 20000).catch((err) => {
      throw new Error(`${err.message}\n浏览器 stderr:\n${browserErr}`);
    });
    const version = await versionRes.json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    cleanup.push(() => {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sid = attached.sessionId;
    pageSend = (method, params) => cdp.send(method, params, sid);

    evalJS = async (expression) => {
      const r = await pageSend('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error('页面脚本异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result?.value;
    };

    waitFor = async (expression, { timeout = 12000, label = expression } = {}) => {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try {
          const v = await evalJS(expression);
          if (v) return v;
          last = v;
        } catch (err) {
          last = err.message;
        }
        await sleep(80);
      }
      throw new Error(`等待超时：${label}（最后结果 ${JSON.stringify(last)}）`);
    };

    const centerOf = async (selector, index = 0) => {
      const info = await evalJS(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = els[${index}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x, y, w: r.width, h: r.height,
          tag: el.tagName,
          hit: hit ? (el === hit || el.contains(hit) ? 'self' : hit.tagName + '.' + hit.className) : 'none',
        };
      })()`);
      if (!info) throw new Error(`找不到元素：${selector}`);
      return info;
    };

    click = async (selector, index = 0) => {
      const info = await centerOf(selector, index);
      if (info.w <= 0 || info.h <= 0) throw new Error(`元素不可见：${selector}`);
      await pageSend('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1,
      });
      await pageSend('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1,
      });
      return info;
    };

    setValue = async (selector, value) => {
      const ok = await evalJS(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        if (el.select) el.select();
        else if (el.setSelectionRange) el.setSelectionRange(0, el.value.length);
        return true;
      })()`);
      if (!ok) throw new Error(`找不到输入框：${selector}`);
      await pageSend('Input.insertText', { text: value });
      await sleep(60);
    };

    selectValue = async (selector, value) => {
      await evalJS(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      })()`);
      await sleep(60);
    };

    goto = async (url) => {
      await pageSend('Page.navigate', { url });
      await waitFor(`document.readyState === 'complete'`, { timeout: 20000, label: '页面加载' });
      await waitFor(`!!document.querySelector('#frameCount')`, { timeout: 20000 });
    };

    shot = async (name) => {
      const { data } = await pageSend('Page.captureScreenshot', { format: 'png' });
      const p = path.join(shots, `${name}.png`);
      await writeFile(p, Buffer.from(data, 'base64'));
      screenshotPaths.push(p);
      return p;
    };

    /* ---------- CDP 事件：弹窗、代理拦截 ---------- */
    cdp.on((msg) => {
      if (msg.sessionId !== sid) return;

      if (msg.method === 'Page.javascriptDialogOpening') {
        pageSend('Page.handleJavaScriptDialog', { accept: dialogPolicy.accept }).catch(() => {});
        return;
      }

      if (msg.method === 'Runtime.exceptionThrown') {
        uncaught.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'unknown');
        return;
      }

      if (msg.method === 'Network.requestWillBeSent') {
        const u = msg.params.request.url;
        if (u.includes('/sse') || u.includes('/api/proxy')) dbg('requestWillBeSent', u);
        return;
      }

      if (msg.method === 'Network.loadingFailed') {
        dbg('loadingFailed', msg.params.errorText, msg.params.blockedReason || '', msg.params.type);
        return;
      }

      if (msg.method === 'Runtime.consoleAPICalled') {
        dbg('console', msg.params.type, msg.params.args.map((a) => a.value ?? a.description).join(' '));
        return;
      }

      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        dbg('paused', request.method, request.url);
        (async () => {
          let u;
          try {
            u = new URL(request.url);
          } catch {
            await pageSend('Fetch.continueRequest', { requestId });
            return;
          }

          if (u.pathname !== '/api/proxy') {
            await pageSend('Fetch.continueRequest', { requestId });
            return;
          }

          let payload;
          try {
            payload = JSON.parse(request.postData || '{}');
          } catch {
            await pageSend('Fetch.fulfillRequest', {
              requestId,
              responseCode: 400,
              responseHeaders: [{ name: 'content-type', value: 'application/json' }],
              body: Buffer.from(JSON.stringify({ error: { message: 'bad mock payload' } })).toString('base64'),
            });
            return;
          }

          const messages = payload?.body?.messages || [];
          const kind = classify(messages);

          if (payload.stream) {
            const mockSid = ++streamSeq.n;
            mock.register(mockSid);
            dbg('stream intercept', mockSid, kind, `${mock.base}/sse?sid=${mockSid}`);
            captures.generate.push({
              sid: mockSid,
              kind,
              model: payload.body.model,
              stream: payload.stream,
              baseUrl: payload.baseUrl,
              messages,
            });
            payload.baseUrl = `${mock.base}/stream/${mockSid}`;
            await pageSend('Fetch.continueRequest', {
              requestId,
              postData: Buffer.from(JSON.stringify(payload)).toString('base64'),
            });
            return;
          }

          if (kind === 'rewrite') captures.rewrite.push({ messages, model: payload.body.model });
          else captures.other.push({ kind, messages });

          const content = mockContent(kind);
          const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
          await pageSend('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'content-type', value: 'application/json; charset=utf-8' },
              { name: 'access-control-allow-origin', value: '*' },
            ],
            body: Buffer.from(body, 'utf8').toString('base64'),
          });
        })().catch((err) => {
          blocked.add(String(err.message));
          pageSend('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        });
      }
    });

    await pageSend('Page.enable');
    await pageSend('Runtime.enable');
    await pageSend('Network.enable');
    await pageSend('Network.setBlockedURLs', {
      urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'],
    });
    await pageSend('Fetch.enable', {
      patterns: [{ urlPattern: '*api/proxy*', requestStage: 'Request' }],
    });
    await pageSend('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    /* ============================================================ */
    await t.test('?sample 载入 3 图与示例故事', async () => {
      await goto(`${appBase}/?sample`);
      await waitFor(`document.querySelectorAll('#frameList .frame').length === 3`, {
        timeout: 20000,
        label: '示例 3 图',
      });
      assert.equal(await evalJS(`document.querySelector('#frameCount').textContent`), '03');
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);
      assert.equal(await evalJS(`document.querySelector('#paperKicker').textContent`), '示例故事');
      assert.equal(await evalJS(`document.querySelector('#stageMeta').textContent`), 'F01 / 03');
      await shot('01-sample-desktop');
    });

    await t.test('4 种风格 + details 内 textarea 可编辑 + 预设改框变 custom + 取消覆盖不丢输入', async () => {
      assert.equal(
        await evalJS(`[...document.querySelectorAll('#styleSelect option')].map((o) => o.value).join(',')`),
        'natural,plain,artistic,subtle'
      );

      await click('#promptMore summary');
      await waitFor(`document.querySelector('#promptMore').open === true`);

      const ta = await evalJS(`(() => {
        const t = document.querySelector('#customPrompt');
        const r = t.getBoundingClientRect();
        return { tag: t.tagName, w: r.width, h: r.height, readOnly: t.readOnly, disabled: t.disabled };
      })()`);
      assert.equal(ta.tag, 'TEXTAREA');
      assert.ok(ta.w > 80 && ta.h > 30, `textarea 尺寸异常：${JSON.stringify(ta)}`);
      assert.ok(!ta.readOnly && !ta.disabled);

      // 预设填入编辑框
      await selectValue('#presetSelect', 'natural');
      assert.equal(await evalJS(`document.querySelector('#presetSelect').value`), 'natural');
      assert.ok((await evalJS(`document.querySelector('#customPrompt').value.length`)) > 20);

      // 直接编辑 -> custom
      await setValue('#customPrompt', CUSTOM_PROMPT);
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), CUSTOM_PROMPT);
      assert.equal(await evalJS(`document.querySelector('#presetSelect').value`), 'custom');

      // 取消覆盖
      dialogPolicy.accept = false;
      await selectValue('#presetSelect', 'default');
      await sleep(200);
      assert.equal(await evalJS(`document.querySelector('#presetSelect').value`), 'custom');
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), CUSTOM_PROMPT);
      dialogPolicy.accept = true;

      // 风格切换生效
      await selectValue('#styleSelect', 'artistic');
      assert.equal(await evalJS(`document.querySelector('#styleSelect').value`), 'artistic');
      assert.equal(await evalJS(`document.querySelector('#styleHint').textContent`), '意象与节奏更讲究');
    });

    await t.test('设置弹窗保存 dummy 配置（本地 mock URL / dummy key）', async () => {
      await click('#settingsBtn');
      await waitFor(`document.querySelector('#settings').open === true`);
      await setValue('#cfgBase', mock.base);
      await setValue('#cfgKey', 'sk-dummy-smoke');
      await setValue('#cfgChat', 'mock-chat');
      await setValue('#cfgVision', 'mock-vision');
      await shot('02-settings');
      await click('#saveCfg');
      await waitFor(`document.querySelector('#settings').open === false`);
      await waitFor(`document.querySelector('#connText').textContent.includes('已配置')`);
      const cfg = await evalJS(`JSON.parse(localStorage.getItem('develop.config.v1'))`);
      assert.equal(cfg.baseUrl, mock.base);
      assert.equal(cfg.apiKey, 'sk-dummy-smoke');
    });

    await t.test('生成：Fetch 捕获完整 messages，流式渲染 F01–F03，生成中控件禁用', async () => {
      const before = captures.generate.length;
      await click('#generateBtn');
      await waitFor(`document.querySelector('#paperKicker').textContent === '显影中'`, {
        timeout: 15000,
        label: '进入流式生成',
      });
      await waitFor(`document.querySelectorAll('#story .story-sec').length >= 1`, {
        timeout: 15000,
        label: '首段流式渲染',
      });

      const states = await evalJS(`(() => ({
        label: document.querySelector('#generateBtn').textContent,
        stopClass: document.querySelector('#generateBtn').classList.contains('is-stop'),
        style: document.querySelector('#styleSelect').disabled,
        pov: document.querySelector('#povSelect').disabled,
        length: document.querySelector('#lengthSelect').disabled,
        preset: document.querySelector('#presetSelect').disabled,
        prompt: document.querySelector('#customPrompt').disabled,
        modes: [...document.querySelectorAll('.mode')].every((b) => b.disabled),
      }))()`);
      assert.ok(states.label.includes('停止生成'), JSON.stringify(states));
      assert.ok(states.stopClass);
      assert.ok(states.style && states.pov && states.length && states.preset && states.prompt && states.modes);
      await shot('03-streaming');

      const cap = captures.generate.at(-1);
      assert.ok(captures.generate.length > before);
      assert.equal(cap.stream, true);
      assert.equal(cap.model, 'mock-chat');

      const storyText = cap.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      assert.match(storyText, /【写作要求】/);
      assert.match(storyText, /风格：艺术/);
      assert.ok(storyText.includes(`用户补充要求：\n${CUSTOM_PROMPT}`), '自定义 prompt 未进入生成 messages');
      assert.match(storyText, /【全篇时间线】/);
      assert.match(storyText, /F01｜摘要：雨夜的公交站/);
      assert.match(storyText, /F02｜摘要：深夜的桌面/);
      assert.match(storyText, /F03｜摘要：清晨的站台/);
      assert.match(storyText, /【第 1 帧 · F01】/);
      assert.match(storyText, /【第 2 帧 · F02】/);
      assert.match(storyText, /【第 3 帧 · F03】/);
      assert.ok(!storyText.includes('data:image'), '生成 messages 不应内联图片数据');

      await mock.release(cap.sid);
      await waitFor(`document.querySelector('#paperKicker').textContent === '已生成'`, {
        timeout: 20000,
        label: '流式生成完成',
      });
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);
      assert.deepEqual(
        await evalJS(`[...document.querySelectorAll('#story .sec-label')].map((e) => e.textContent)`),
        ['F01', 'F02', 'F03']
      );
      assert.match(await evalJS(`document.querySelector('#story').textContent`), /第一段测试正文/);
      assert.ok((await evalJS(`Number(document.querySelector('#wordCount').textContent)`)) > 0);
      assert.equal(await evalJS(`document.querySelector('#styleSelect').disabled`), false);
    });

    await t.test('生成中点“停止生成”可中止，控件恢复', async () => {
      const before = captures.generate.length;
      await click('#generateBtn');
      await waitFor(`document.querySelector('#paperKicker').textContent === '显影中'`);
      await waitFor(`document.querySelectorAll('#story .story-sec').length >= 1`);
      const cap = captures.generate.at(-1);
      assert.ok(captures.generate.length > before);
      await mock.state(cap.sid);
      await click('#generateBtn');
      await waitFor(`document.querySelector('#paperKicker').textContent !== '显影中'`, {
        timeout: 15000,
        label: '停止后离开流式状态',
      });
      await waitFor(`document.querySelector('#toast').textContent.includes('已停止')`, {
        timeout: 5000,
        label: '停止提示',
      });
      await sleep(300);
      // 浏览器停止状态已验证；本测试使用真实本机代理，代理未必同步关闭上游。
      mock.release(cap.sid);
      assert.equal(await evalJS(`document.querySelector('#generateBtn').textContent.includes('生成故事')`), true);
      assert.equal(await evalJS(`document.querySelector('#styleSelect').disabled`), false);
    });

    await t.test('重新生成完整故事，供复制 / 重写 / stale 使用', async () => {
      await click('#generateBtn');
      await waitFor(`document.querySelector('#paperKicker').textContent === '显影中'`);
      const cap = captures.generate.at(-1);
      await mock.release(cap.sid);
      await waitFor(`document.querySelector('#paperKicker').textContent === '已生成'`, { timeout: 20000 });
      await waitFor(`document.querySelectorAll('#story .story-sec').length === 3`);
    });

    await t.test('复制 / 导出内容不含帧标题锚点', async () => {
      await evalJS(`(() => {
        window.__copied = '';
        const fake = {
          writeText: async (t) => { window.__copied = t; },
          readText: async () => window.__copied,
        };
        try {
          Object.defineProperty(navigator, 'clipboard', { value: fake, configurable: true });
        } catch {
          Object.defineProperty(Clipboard.prototype, 'writeText', { value: fake.writeText, configurable: true });
        }
        window.__exportBlob = null;
        const origCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => { window.__exportBlob = b; return origCreate(b); };
        HTMLAnchorElement.prototype.click = function () {};
        return true;
      })()`);

      await click('#copyBtn');
      await waitFor(`(window.__copied || '').length > 20`, { timeout: 5000, label: '剪贴板内容' });
      const copied = await evalJS(`window.__copied`);
      assert.match(copied, /雨停之前/);
      assert.match(copied, /第一段测试正文/);
      assert.ok(!/###\s*F\d/i.test(copied), '复制内容包含 ### F0x 帧标题');
      assert.ok(!/^F\d{2}$/m.test(copied), '复制内容包含 F0x 锚点');

      await click('#exportBtn');
      await waitFor(`!!window.__exportBlob`, { timeout: 5000, label: '导出 blob' });
      const exported = await evalJS(`window.__exportBlob.text()`);
      assert.match(exported, /雨停之前/);
      assert.ok(!/###\s*F\d/i.test(exported), '导出内容包含 ### F0x 帧标题');
      assert.ok(!/^F\d{2}$/m.test(exported), '导出内容包含 F0x 锚点');
    });

    await t.test('重写 F02：捕获共享风格 / 自定义 / FrameBrief / 首尾上下文，只替换一节', async () => {
      const beforeTexts = await evalJS(`[...document.querySelectorAll('#story .sec-body')].map((e) => e.textContent)`);
      assert.equal(beforeTexts.length, 3);
      const beforeCount = captures.rewrite.length;

      await click('#story .story-sec[data-index="1"] .sec-rewrite');
      await waitFor(`document.querySelectorAll('#story .sec-body')[1].textContent.includes('重写后的第二段')`, {
        timeout: 15000,
        label: 'F02 重写渲染',
      });
      assert.ok(captures.rewrite.length > beforeCount);
      const cap = captures.rewrite.at(-1);
      const sys = cap.messages[0].content;
      const user = cap.messages[1].content;
      assert.match(sys, /### F02/);
      assert.match(user, /【整体故事上下文】/);
      assert.match(user, /【这一段对应的画面依据】/);
      assert.match(user, /【第 2 帧 · F02】/);
      assert.match(user, /【上一段结尾】/);
      assert.match(user, /【下一段开头】/);
      assert.match(user, /【需要重写的这一段】/);
      assert.match(user, /第二段测试正文/);
      assert.match(user, /风格：艺术/);
      assert.ok(user.includes(CUSTOM_PROMPT), '重写 messages 缺少自定义 prompt');
      assert.match(user, /F01｜摘要：雨夜的公交站/);

      const afterTexts = await evalJS(`[...document.querySelectorAll('#story .sec-body')].map((e) => e.textContent)`);
      assert.equal(afterTexts.length, 3);
      assert.match(afterTexts[1], /重写后的第二段/);
      assert.equal(afterTexts[0], beforeTexts[0], '重写影响了 F01');
      assert.equal(afterTexts[2], beforeTexts[2], '重写影响了 F03');
    });

    await t.test('重排后 stale 提醒、原稿保留、重写禁用', async () => {
      const rawBefore = await evalJS(`document.querySelector('#story').textContent`);
      await click('#frameList .frame:nth-child(2) [data-act="up"]');
      await waitFor(`document.querySelector('#storyStale').hidden === false`, {
        timeout: 5000,
        label: 'stale 提醒',
      });
      assert.match(await evalJS(`document.querySelector('#storyStale').textContent`), /原稿已保留/);
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);
      assert.equal(await evalJS(`document.querySelector('#story').textContent`), rawBefore);
      assert.equal(
        await evalJS(`[...document.querySelectorAll('.sec-rewrite')].every((b) => b.disabled)`),
        true,
        'stale 后重写按钮仍可点'
      );
      await sleep(800); // 等待自动保存落盘
    });

    await t.test('刷新后 prompt / 风格恢复', async () => {
      await goto(`${appBase}/`);
      await waitFor(`document.querySelectorAll('#frameList .frame').length === 3`, { timeout: 20000 });
      await waitFor(`document.querySelector('#styleSelect').value === 'artistic'`, {
        timeout: 15000,
        label: '风格恢复',
      });
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), CUSTOM_PROMPT);
      assert.equal(await evalJS(`document.querySelector('#presetSelect').value`), 'custom');
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);
      assert.equal(await evalJS(`document.querySelector('#storyStale').hidden`), false);
    });

    await t.test('项目新建 / 切换：旧设置不泄漏，切回恢复', async () => {
      // 命名当前项目 A
      await click('#saveBtn');
      await waitFor(`document.querySelector('#nameDlg').open === true`);
      await setValue('#nameInput', '项目A');
      await click('#nameConfirm');
      await waitFor(`document.querySelector('#projChipName').textContent === '项目A'`);

      // 新建空项目 -> 默认设置
      await click('#projChip');
      await waitFor(`document.querySelector('#projectsDlg').open === true`);
      await click('#newProjectBtn');
      await waitFor(`document.querySelectorAll('#frameList .frame').length === 0`, {
        timeout: 10000,
        label: '新建空项目',
      });
      assert.equal(await evalJS(`document.querySelector('#styleSelect').value`), 'natural');
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), '');
      assert.equal(await evalJS(`document.querySelector('#presetSelect').value`), 'default');
      assert.equal(await evalJS(`document.querySelector('#paperKicker').textContent`), '未显影');

      // 项目 B：载入示例并命名
      await click('#sampleBtn');
      await waitFor(`document.querySelectorAll('#frameList .frame').length === 3`, { timeout: 20000 });
      await click('#saveBtn');
      await waitFor(`document.querySelector('#nameDlg').open === true`);
      await setValue('#nameInput', '项目B');
      await click('#nameConfirm');
      await waitFor(`document.querySelector('#projChipName').textContent === '项目B'`);
      assert.equal(await evalJS(`document.querySelector('#styleSelect').value`), 'natural');

      // 切回 A：设置与故事恢复
      await click('#projChip');
      await waitFor(`document.querySelectorAll('#projectList .project-row').length === 2`);
      const rowA = await evalJS(`(() => {
        const rows = [...document.querySelectorAll('#projectList .project-row')];
        const i = rows.findIndex((r) => r.querySelector('.pr-name').textContent === '项目A');
        return i;
      })()`);
      assert.ok(rowA >= 0, '项目列表里没有项目A');
      await click('#projectList .project-row .pr-acts [data-act="open"]', rowA);
      await waitFor(`document.querySelector('#projChipName').textContent === '项目A'`, { timeout: 10000 });
      await waitFor(`document.querySelector('#styleSelect').value === 'artistic'`, { timeout: 5000 });
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), CUSTOM_PROMPT);
      assert.equal(await evalJS(`document.querySelectorAll('#frameList .frame').length`), 3);
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);

      // 切到 B：不应带上 A 的设置
      await click('#projChip');
      await waitFor(`document.querySelectorAll('#projectList .project-row').length === 2`);
      const rowB = await evalJS(`(() => {
        const rows = [...document.querySelectorAll('#projectList .project-row')];
        return rows.findIndex((r) => r.querySelector('.pr-name').textContent === '项目B');
      })()`);
      assert.ok(rowB >= 0, '项目列表里没有项目B');
      await click('#projectList .project-row .pr-acts [data-act="open"]', rowB);
      await waitFor(`document.querySelector('#projChipName').textContent === '项目B'`, { timeout: 10000 });
      await waitFor(`document.querySelector('#styleSelect').value === 'natural'`, { timeout: 5000 });
      assert.equal(await evalJS(`document.querySelector('#customPrompt').value`), '');
      assert.equal(await evalJS(`document.querySelectorAll('#frameList .frame').length`), 3);
    });

    await t.test('375px 移动端：展开设置、滚动后点击生成', async () => {
      await pageSend('Emulation.setDeviceMetricsOverride', {
        width: 375, height: 667, deviceScaleFactor: 1, mobile: true,
      });
      await sleep(300);
      assert.equal(await evalJS(`getComputedStyle(document.querySelector('#tabs')).display`), 'flex');

      // 设置按钮真实可点
      const settingsInfo = await centerOf('#settingsBtn');
      assert.equal(settingsInfo.hit, 'self');
      await click('#settingsBtn');
      await waitFor(`document.querySelector('#settings').open === true`, { timeout: 5000 });
      assert.ok((await evalJS(`document.querySelector('#settings').getBoundingClientRect().width`)) <= 375);
      await shot('04-mobile-settings');
      await click('#cancelCfg');
      await waitFor(`document.querySelector('#settings').open === false`);

      // 切到故事面板，滚动后点生成
      await click('.tab[data-panel="sheet"]');
      await waitFor(`getComputedStyle(document.querySelector('#sheet')).display !== 'none'`);
      const genInfo = await centerOf('#generateBtn');
      assert.equal(genInfo.hit, 'self');
      assert.ok(genInfo.y > 0 && genInfo.y < 667, `生成按钮不在视口内：y=${genInfo.y}`);
      await click('#generateBtn');
      await waitFor(`document.querySelector('#paperKicker').textContent === '显影中'`, {
        timeout: 15000,
        label: '移动端生成开始',
      });
      const cap = captures.generate.at(-1);
      await mock.release(cap.sid);
      await waitFor(`document.querySelector('#paperKicker').textContent === '已生成'`, { timeout: 20000 });
      assert.equal(await evalJS(`document.querySelectorAll('#story .story-sec').length`), 3);
      await shot('05-mobile-story');
    });

    await t.test('无未捕获页面异常', () => {
      assert.deepEqual(uncaught, [], '页面出现未捕获异常');
      assert.deepEqual([...blocked], [], 'Fetch 拦截处理出现异常');
    });
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch {
        /* 清理失败不掩盖测试结果 */
      }
    }
    for (let i = 0; i < 5; i += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
    console.log(`\n[smoke] 截图目录：${shots}`);
    for (const p of screenshotPaths) console.log(`[smoke] ${p}`);
  }
});
