// 显影 DEVELOP — 本地存档（IndexedDB，图片以 dataURL 保存）
// projects：完整项目数据，key = 项目 id
// index  ：轻量元信息（帧数、时间等），列表时不必读出全量图片

const DB_NAME = 'develop';
const STORE = 'projects';
const INDEX = 'index';
const VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    // 个别环境（嵌入式 webview、被其他标签页占用）会让 open 永远不回调，超时兜底
    const timer = setTimeout(() => reject(new Error('存档数据库无响应，请关闭本应用的其他标签页后刷新')), 4000);
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      // 让其他标签页升级数据库时不用等我们
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onblocked = () => {
      clearTimeout(timer);
      reject(new Error('存档被其他标签页占用，请关闭本应用的其他标签页后刷新。'));
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error || new Error('IndexedDB 打开失败'));
    };
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// fn 收到 { projects, index } 两个 store，同一事务里读写
function withTx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE, INDEX], mode);
        let result;
        try {
          result = fn({
            projects: tx.objectStore(STORE),
            index: tx.objectStore(INDEX),
          });
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = () => reject(tx.error || new Error('存档失败'));
        tx.onabort = () => reject(tx.error || new Error('存档中断'));
      })
  );
}

// 启动时探测存档是否可用，返回 null 或错误提示
export async function checkStorage() {
  try {
    await open();
    return null;
  } catch (err) {
    return err?.message || '浏览器存档不可用';
  }
}

// record: { name, createdAt, updatedAt, data: { version, frames, activeId, settings, story } }
export async function saveProject(id, record) {
  const data = record?.data || {};
  const meta = {
    id,
    name: String(record?.name || '未命名项目').slice(0, 40),
    createdAt: record?.createdAt || Date.now(),
    updatedAt: record?.updatedAt || Date.now(),
    frameCount: Array.isArray(data.frames) ? data.frames.length : 0,
    hasStory: Boolean(data.story && String(data.story.raw || '').trim()),
  };
  try {
    await withTx('readwrite', (s) => {
      s.projects.put(record, id);
      s.index.put(meta, id);
    });
    return true;
  } catch {
    return false;
  }
}

export async function getProject(id) {
  try {
    return (await withTx('readonly', (s) => s.projects.get(id))) || null;
  } catch {
    return null;
  }
}

// 按更新时间倒序的元信息列表
export async function listProjects() {
  try {
    const list = await withTx('readonly', (s) => s.index.getAll());
    return (list || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

export async function deleteProject(id) {
  try {
    await withTx('readwrite', (s) => {
      s.projects.delete(id);
      s.index.delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

export async function renameProject(id, name) {
  const rec = await getProject(id);
  if (!rec) return false;
  return saveProject(id, { ...rec, name });
}

/* 旧版只有 key 为 'current' 的一份自动存档，读出来迁移成项目 */
export async function loadLegacy() {
  try {
    return (await withTx('readonly', (s) => s.projects.get('current'))) || null;
  } catch {
    return null;
  }
}

export async function removeLegacy() {
  try {
    await withTx('readwrite', (s) => s.projects.delete('current'));
    return true;
  } catch {
    return false;
  }
}
