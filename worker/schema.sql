-- wris-data D1 表结构
-- 首次部署后执行（--remote 建表到线上库）：
--   npx wrangler d1 execute wris-data --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS projects (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  frame_count INTEGER NOT NULL DEFAULT 0,
  has_story   INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,          -- 项目 JSON（帧图已替换为 cf:hash.ext 引用）
  deleted_at  INTEGER,                -- 软删除墓碑：非空表示已删除，供多端同步删除
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_updated
  ON projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS usage (
  user_id    TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL DEFAULT 0,  -- 该用户上传过的图片总量（配额计数）
  updated_at INTEGER
);
