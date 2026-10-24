# wris-data — 账号云端存储

显影（develop）的项目与帧图云端，部署为 Cloudflare Worker：

- **D1** 存项目 JSON（帧图已替换为 `cf:<sha256>.<ext>` 引用，不含图片本体）
- **R2** 按内容哈希存帧图（同图全局只存一份，URL 可永久缓存）
- **鉴权** 复用 `auth.wris.me` 的会话 Cookie（种在 `.wris.me`，Worker 挂到 `api.wris.me` 后浏览器自动携带，无需另发 token）
- 用户的 AI 接口配置（baseUrl / apiKey）**不经过本服务**，只存在各自浏览器的 localStorage

## 部署步骤

```bash
cd worker
npx wrangler login                     # 首次需要
npx wrangler d1 create wris-data       # 把输出的 database_id 填进 wrangler.toml
npx wrangler r2 bucket create wris-data
npx wrangler d1 execute wris-data --file=schema.sql --remote
npx wrangler deploy
```

## 绑定自定义域 api.wris.me

会话 Cookie 种在 `.wris.me`，只对 `*.wris.me` 的请求自动携带，所以必须绑定自定义域（`*.workers.dev` 域名收不到 Cookie）。前提：`wris.me` 的 DNS 托管在同一个 Cloudflare 账号。

在 `wrangler.toml` 里放开：

```toml
routes = [
  { pattern = "api.wris.me", custom_domain = true }
]
```

然后重新 `npx wrangler deploy`。

## 前端对应

`js/cloud.js` 顶部的 `CLOUD_ORIGIN` 默认 `https://api.wris.me`，与上面的自定义域一致。调试时可以在页面 URL 加 `?cloud=https://…` 临时指向别的环境。

## 数据与配额

| 项 | 默认值 | 调整位置 |
| --- | --- | --- |
| 每用户总配额 | 512 MB | `QUOTA_MB` |
| 单张图片上限 | 10 MB | `MAX_IMAGE_MB` |
| 项目 JSON 上限 | 2048 KB | `MAX_PROJECT_KB` |
| 删除墓碑保留 | 90 天 | 代码里的 `TOMBSTONE_WINDOW` |

同步协议（与 `js/cloud.js` 对应）：

- 客户端启动时拉取列表（含墓碑），与本地 IndexedDB 按 `updatedAt` 最后写入胜出合并；删除靠墓碑双向收敛。
- 图片先 `POST /img/check` 查缺，再逐张 `PUT /img/:key`（服务端校验 sha256 与 key 一致），最后 `PUT /projects/:id`。
- `PUT /projects/:id` 收到比云端更旧的 `updatedAt` 时不覆盖（返回 `{ stale: true }`）。
- 图片对象在项目删除后不回收（同图会被去重引用，配额按首次上传计），需要清理时在 R2 侧按 `img/` 前缀核对。

## 本地调试

`npx wrangler dev` 起本地 Worker 后，健康检查与公开图片路由可直接测；带登录态的接口在本地收不到 `.wris.me` 的 Cookie，需要在部署到 `api.wris.me` 后验证。

## 用户 ID 说明

鉴权用 `auth.wris.me /api/me` 返回的 `user.id`（缺失时依次退回 `user.sub`、`user.login`）。如果 auth 服务将来改用可变用户名，请确保提供稳定 id，否则改名会导致云端数据"失踪"。
