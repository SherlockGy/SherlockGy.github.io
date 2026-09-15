# Cloudflare Worker 上传接口约定

前端和 [Worker 实现](../worker/worker.js) 均已提供。按 [部署说明](../worker/SETUP.md) 在 Cloudflare 编辑器粘贴代码、设置两个 Secret 即可连接。`config.js` 的 `uploadEndpoint` 为空时，仅启用本地预览，不发出上传请求。

## 请求

`POST <uploadEndpoint>`，`multipart/form-data`。让浏览器生成 Content-Type 和 boundary。

请求头：`Authorization: Bearer <个人上传口令>`。这是自己的 Worker 上传口令，**不能使用 GitHub Token**。前端不会持久化口令，关闭弹窗或成功后会清除。

| 字段 | 内容 |
| --- | --- |
| `requestId` | UUID v4，同一批内容的重试复用该编号 |
| `title` | 必填，去除首尾空白后 1–120 字 |
| `date` | 必填，有效的 `YYYY-MM-DD`，用户选定的归档日期 |
| `description` | 选填，最多 1000 字 |
| `images` | 重复字段，按出现顺序保存，1–30 张 |

## 成功响应

仅当图片与目录已经在同一 Git commit 中保存后，返回 HTTP 201：

```json
{
  "status": "committed",
  "commitSha": "<GitHub commit SHA>",
  "album": {
    "id": "<unique-album-id>",
    "title": "用户填写的名称",
    "date": "2026-09-15",
    "description": "用户填写的说明",
    "tags": [],
    "images": [
      {
        "src": "./images/2026/09/<unique-album-id>/001.png",
        "alt": "用户填写的名称 · 第 1 页",
        "width": 1600,
        "height": 2200
      }
    ]
  }
}
```

前端提示“已保存，等待网站发布”，不会在 Pages 尚未更新时虚构已上线状态。GitHub Pages 有部署与缓存延迟，用户稍后刷新即可看到。

## 错误响应

HTTP 400 / 401 / 403 / 409 / 413 / 429 / 500 / 502 / 503 / 504，JSON：

```json
{ "error": { "code": "INVALID_FILE", "message": "仅支持 JPG、PNG、WebP、GIF、AVIF 图片", "traceId": "<request UUID>" } }
```

不要返回堆栈、GitHub Token、完整上游鉴权头或其他内部凭据。客户端 120 秒超时不等于服务端失败，超时后应先检查目录，避免重复提交。

GitHub 请求错误额外返回 `stage` 和耗时 `elapsedMs`，若已收到 HTTP 响应则包含 `httpStatus`。真正超时为 HTTP 504 / `GITHUB_TIMEOUT`（单步限时 20 秒）；其他请求异常为 HTTP 502 / `GITHUB_CONNECTION_ERROR`，附带过滤凭据后的 `reason`；HTTP 拒绝为 `GITHUB_ERROR`。这些错误的 `traceId` 与 Worker 实时日志相同。

## 只读连接检查

`POST /check`，发送与上传相同的 `Authorization`，无需请求正文，也无需图片或名称。与上传共用 CORS、口令验证和频率限制；仅依次读取主分支、当前提交及图集目录，绝不写入仓库。成功返回 HTTP 200：

```json
{
  "status": "readable",
  "version": "2026-09-15-diagnostics-1",
  "traceId": "<request UUID>",
  "elapsedMs": 500,
  "albumCount": 0,
  "message": "GitHub 连接和图集目录读取正常。写入权限仍需通过实际上传验证。"
}
```

`GET /health` 无需口令，返回部署版本及配置是否存在；不会访问 GitHub，不能证明 GitHub 可用。结构化日志记录 `github.start` / `github.success` / `github.error`，不记录请求正文、图片或凭据。

## 后端处理约束

1. 为固定站点 `https://sherlockgy.github.io` 配置 CORS。
   - 响应 `OPTIONS`，允许 `POST, OPTIONS` 和 `Authorization, Content-Type`。
   - 所有成功与错误响应均包含正确的 CORS 头，使用 `Vary: Origin`。
   - CORS 不能代替鉴权。Worker 必须验证独立的上传口令，限制请求速率。
2. 验证名称、日期、文件数量、总大小和每张图片的真实格式。
   - 前端限制只用于体验；后端必须重新校验，不能信任扩展名或 MIME。
   - 单张最多 10 MiB，单次合计最多 30 MiB，最多 30 张。
   - 拒绝 SVG、HTML 和非图片数据；自行生成存储文件名，拒绝路径穿越。
3. 仓库、分支、目录在 Worker 中固定。
   - 仓库：`SherlockGy/SherlockGy.github.io`；分支：`master`。
   - GitHub Token 作为 Secret 保存，仅授予本仓库的 Contents 写权限。
   - 将图片写入 `images/YYYY/MM/<id>/`，与 `data/albums.json` 一起原子提交。
4. 使用 Git Data API 创建 blobs、tree、commit，然后以 **非强制**方式更新分支引用。
   - 读取最新 head 和完整图集目录，追加图集，保留其他图集及站点文件。
   - 并发冲突时重读最新目录并重试；有限次失败返回 409，不能覆盖已有目录。
   - 用 `requestId` 做幂等处理；同一请求重试返回原结果。
5. 仅在 commit 保存成功后返回 `committed`；不得以“收到请求”作为保存成功。

参考：[Cloudflare Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Cloudflare CORS 示例](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)、[GitHub Git Data API](https://docs.github.com/en/rest/git)。
