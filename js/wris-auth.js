// wris.me 账号 — 登录状态组件（显影 / 画册共用）
// 登录态由 auth.wris.me 统一管理：会话 Cookie 种在 .wris.me 域，所有子站共享。
import { escapeHtml } from './markdown.js';

export const AUTH_ORIGIN = 'https://auth.wris.me';

let currentUser = null;
let mePromise = null; // 登录检查只发一次请求，页面内多处共享结果

/** 当前登录用户（页面加载后调用有效）；未登录为 null */
export function wrisUser() {
  return currentUser;
}

export function fetchWrisUser() {
  if (!mePromise) {
    mePromise = fetch(AUTH_ORIGIN + '/api/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        currentUser = data.user || null;
        return currentUser;
      })
      .catch(() => {
        currentUser = null; // auth 服务不可达时按未登录处理
        return currentUser;
      });
  }
  return mePromise;
}

function backTo() {
  return encodeURIComponent(location.origin + location.pathname);
}

// 登录统一跳 auth.wris.me 的选择页（GitHub / Google），选完自动回跳本站
export function loginUrl() {
  return `${AUTH_ORIGIN}/?redirect_to=${backTo()}`;
}

export function logoutUrl() {
  return `${AUTH_ORIGIN}/api/logout?redirect_to=${backTo()}`;
}

function render(mount, user) {
  if (user) {
    const avatar = user.avatar
      ? `<img class="wris-avatar" src="${escapeHtml(user.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const name = escapeHtml(user.name || user.login || '已登录');
    mount.innerHTML = `${avatar}<span class="wris-name">${name}</span><a class="wris-out" href="${logoutUrl()}" title="退出登录">退出</a>`;
    mount.classList.add('is-in');
  } else {
    mount.innerHTML = `<a class="wris-login" href="${loginUrl()}" title="前往 wris.me 选择登录方式">登录</a>`;
    mount.classList.add('is-out');
  }
}

export async function initWrisAuth() {
  const mount = document.getElementById('wrisUser');
  if (!mount) return null;
  const user = await fetchWrisUser();
  render(mount, user);
  return user;
}

// 独立引入即可生效（index.html / gallery.html 底部的 module script）
initWrisAuth();
