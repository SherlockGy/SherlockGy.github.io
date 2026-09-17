# Cloudflare Worker 上传接口约定

前端和 [Worker 实现](../worker/worker.js) 均已提供。按 [部署说明](../worker/SETUP.md) 在 Cloudflare 编辑器粘贴代码、设置两个 Secret 即可连接。`config.js` 的 `uploadEndpoint` 为空时，仅启用本地预览，不发出上传请求。

## 流水上传协议

`GET /health` 的 `upload.protocol` 为 `signed-blobs-v1` 时使用本协议；没有该能力时继续使用下文的 multipart 接口。

| 接口 | 输入 | 成功响应 |
| --- | --- | --- |
| `POST /uploads/prepare` | multipart：`requestId`、`scope` | `{ status: "prepared", snapshot }` |
| `POST /uploads/{requestId}/{index}?scope=...` | 原始图片二进制，索引从零开始 | HTTP 201，`{ status: "staged", receipt }` |
| `POST /albums` 或 `POST /albums/{id}` | 原元数据及 `receipts` JSON 数组、可选 `snapshot` JSON；不传 `images` | 原有 committed/unchanged 响应 |
| `GET /uploads/status?requestId=...&scope=...` | 请求编号与目标路径 | `{ status: "committed", commitSha, album }` 或 `{ status: "not_committed" }` |

这些接口均使用原有上传口令、来源校验。`scope` 是 `/albums` 或 `/albums/{id}`，不允许客户端指定仓库文件路径。

- 快照准备与图片上传并行。`snapshot` 是服务端签名的同一提交快照，5 分钟有效；过期后重新读取。最终分支更新失败仍按原冲突规则重读，不强制覆盖。
- 每张图片的 `receipt` 包含已签名的请求编号、目标、索引、SHA、哈希、字节数、类型和可用尺寸，24 小时有效；不得修改或交换顺序。
- 前端按 `/health` 返回的 `upload.concurrency` 调度（默认 2，最多 3），同时遵守 `upload.maxInFlightBytes`（12 MiB）。服务端验证单图、签名及最终合计大小。
- `receipts` 与 `images` 互斥。排序无新文件时可以发送空凭据数组。最后一次提交保持原有图片顺序、版本检查与请求指纹语义。
- 对图片请求独立采用每 IP、每 isolate 90 次/分钟的节流；其他鉴权操作保持 12 次/分钟。它们都不是全局配额。
- 最终提交结果不明时先查 `/uploads/status`；状态查询不能用来跳过服务端内容指纹校验，也不承担部分 Blob 的持久进度存储。
- 已传图片凭据保存在页面内存中；关闭或刷新页面会失去草稿。签名同时依赖仅服务端持有的 GitHub Token 和上传口令；更换任一项都会使已有签名失效。
- 新增错误：`INVALID_RECEIPT`、`RECEIPT_EXPIRED`、`INVALID_SNAPSHOT`、`GITHUB_GRAPHQL_ERROR`；GitHub 限流会返回 429 / `GITHUB_RATE_LIMITED` 和 `retryAfterSeconds`。

## 原有 multipart 请求

`POST <uploadEndpoint>`，`multipart/form-data`。让浏览器生成 Content-Type 和 boundary。

请求头：`Authorization: Bearer <个人上传口令>`。这是自己的 Worker 上传口令，**不能使用 GitHub Token**。前端不会持久化口令，关闭弹窗或成功后会清除。

| 字段 | 内容 |
| --- | --- |
| `requestId` | UUID v4，同一批内容的重试复用该编号 |
| `title` | 必填，去除首尾空白后 1–120 字 |
| `date` | 按月归档时必填，有效的 `YYYY-MM-DD`；系列图集不使用此字段 |
| `seriesId` | 选填，已有系列的编号；填写后图集归属该系列，不进入月份归档 |
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

## 编辑已有图集

`GET /albums/{id}` 需要上传口令，读取 GitHub 当前分支，返回 `{ album, series, revision, capabilities: { editTitle: true } }`。`revision` 是该图集完整记录的 SHA-256，用来检测并发编辑。响应不缓存。前端仅在服务明确返回 `editTitle: true` 时启用名称修改，旧服务仍可编辑图片。

`POST /albums/{id}` 同样使用口令和 `multipart/form-data`：

| 字段 | 内容 |
| --- | --- |
| `requestId` | UUID v4，同一草稿的原样重试复用 |
| `revision` | 载入图集时取得的版本 |
| `title` | 选填，去除首尾空白后 1–120 字；不传时保留原名称 |
| `order` | JSON 数组，表示最终图片顺序 |
| `images` | 本次新增或替换的文件，可为零张；仅排序时不传 |

`order` 条目只接受以下形式，编号都从零开始：

- `{ "existing": 2 }`：保留原列表第 3 张图片。
- `{ "file": 0 }`：插入本次上传的第 1 个文件。
- `{ "file": 1, "replaces": 0 }`：用本次上传的第 2 个文件替换原列表第 1 张。

每张原图必须恰好保留或替换一次，每个上传文件必须恰好引用一次。编辑后仍为 1–30 张。客户端不能指定文件路径；Worker 自行生成包含请求编号的新地址，旧文件不删除。

单独改名时仍提交原图片顺序，不传图片文件；也可同时提交名称、排序和新图。改名保持图集 ID、原图地址、日期、系列、标签及分享链接。自动生成的图片说明会随名称更新，自定义说明保留。名称变化参与版本冲突与请求指纹校验；未携带 `title` 的旧请求保留原指纹格式，兼容旧草稿重试。

成功返回 HTTP 200，格式为 `{ status: "committed", commitSha, album }`。没有变化时返回 `{ status: "unchanged", album }`，不创建 Git 提交。同一图集版本发生变化返回 HTTP 409 / `ALBUM_CHANGED`，保留草稿后由用户选择重新载入。其他仓库文件的并发更新会有限重试并保留。

## 多层系列与图集归属

`GET /library` 需要上传口令，返回 `{ manifest, revision }`。版本只覆盖系列列表和图集的归属、日期、顺序，因此并发图片修改不会被目录整理覆盖。

`POST /library` 使用口令和 `multipart/form-data`，提交 `requestId`、`revision`、`series`、`placements`。最后两个字段为 JSON：

- `series`：完整的系列数组，条目为 `{ id, title, parentId }`。顶层 `parentId` 为 `""`；最多 200 个系列，名称 1–120 字，编号唯一，不得有循环或缺失上级。已有系列必须保留，可新增、重命名、调整层级和排序。
- `placements`：完整的图集排列，条目为 `{ id, seriesId, date }`。所有已有图集必须恰好出现一次，禁止通过目录接口添加或丢弃图集。`seriesId` 为空时必须提供有效归档日期；归属系列时不要求日期，已有日期由服务端保留。

系列数组中同级条目的相对顺序、图集数组中同一系列条目的相对顺序分别决定展示顺序。新系列图集通过 `POST /albums` 创建，不要求日期，保存到 `images/series/<album-id>/`。将原月份图集移入系列只更新目录，原图片地址不变。

目录保存成功返回 HTTP 200 / `{ status: "committed", commitSha, manifest }`；未变化时返回 `{ status: "unchanged", manifest }`。目录版本变更返回 HTTP 409 / `LIBRARY_CHANGED`，不会覆盖别人的变更。

图片编辑和目录整理分别保留最近 50 次请求编号及内容指纹。同一编号的原样重试返回成功，编号被用于不同内容时返回 HTTP 409 / `REQUEST_REUSED`；不再保留的旧请求仍受版本检查约束。接口共用现有口令、来源限制、限流、请求体上限和 GitHub 访问超时。新增日志通过统一 `logPrefix` 标明入口、中文操作和图集编号或追踪编号。

## 错误响应

HTTP 400 / 401 / 403 / 409 / 413 / 429 / 500 / 502 / 503 / 504，JSON：

```json
{ "error": { "code": "INVALID_FILE", "message": "仅支持 JPG、PNG、WebP、GIF、AVIF 图片", "traceId": "<request UUID>" } }
```

不要返回堆栈、GitHub Token、完整上游鉴权头或其他内部凭据。新版前端的单图上传和最终提交各等待 90 秒，旧协议整批等待 120 秒。超时不等于服务端失败，新版会按请求编号查询状态，避免重复提交。

GitHub 请求错误额外返回 `stage` 和耗时 `elapsedMs`，若已收到 HTTP 响应则包含 `httpStatus`。真正超时为 HTTP 504 / `GITHUB_TIMEOUT`（单步限时 20 秒）；其他请求异常为 HTTP 502 / `GITHUB_CONNECTION_ERROR`，附带过滤凭据后的 `reason`；HTTP 拒绝为 `GITHUB_ERROR`。这些错误的 `traceId` 与 Worker 实时日志相同。

## 只读连接检查

`POST /check`，发送与上传相同的 `Authorization`，无需请求正文，也无需图片或名称。与上传共用 CORS、口令验证和频率限制；默认通过一次 GraphQL 查询读取同一个 Commit 下的版本、Tree 和图集目录，不写入仓库。`GITHUB_READ_MODE=rest` 时使用三次 REST 读取，HEAD 取得后并行读取 commit 与目录。成功返回 HTTP 200：

```json
{
  "status": "readable",
  "version": "2026-09-17-album-titles-1",
  "traceId": "<request UUID>",
  "elapsedMs": 500,
  "albumCount": 0,
  "message": "GitHub 连接和图集目录读取正常。写入权限仍需通过实际上传验证。"
}
```

`GET /health` 无需口令，返回部署版本及配置是否存在；不会访问 GitHub，不能证明 GitHub 可用。结构化日志记录 `github.start` / `github.success` / `github.error`，不记录请求正文、图片或凭据。

Worker 对 GitHub 请求使用 `redirect: 'manual'`。收到 301、302、303、307 或 308 时返回 HTTP 502 / `GITHUB_REDIRECT`，不读取或跟随 `Location`，避免将鉴权头转发至其他地址。部分 Worker 运行环境不支持 `redirect: 'error'`，浏览器前端的 Fetch 配置不受此限制影响。

## 后端处理约束

1. 为固定站点 `https://sherlockgy.github.io` 配置 CORS。
   - 响应 `OPTIONS`，允许 `GET, POST, OPTIONS` 和 `Authorization, Content-Type`。
   - 所有成功与错误响应均包含正确的 CORS 头，使用 `Vary: Origin`。
   - CORS 不能代替鉴权。Worker 必须验证独立的上传口令，限制请求速率。
2. 验证名称、日期、文件数量、总大小和每张图片的真实格式。
   - 前端限制只用于体验；后端必须重新校验，不能信任扩展名或 MIME。
   - 单张最多 10 MiB，单次合计最多 30 MiB，最多 30 张。
   - 拒绝 SVG、HTML 和非图片数据；自行生成存储文件名，拒绝路径穿越。
3. 仓库、分支、目录在 Worker 中固定。
   - 仓库：`SherlockGy/SherlockGy.github.io`；分支：`master`。
   - GitHub Token 作为 Secret 保存，仅授予本仓库的 Contents 写权限。
   - 将图片写入月份或系列目录，与 `data/albums.json` 一起原子提交；排序和归属变更只更新目录。
4. 使用 Git Data API 创建 blobs、tree、commit，然后以 **非强制**方式更新分支引用。
   - 读取最新 head 和完整图集目录，追加图集，保留其他图集及站点文件。
   - 并发冲突时重读最新目录并重试；有限次失败返回 409，不能覆盖已有目录。
   - 用 `requestId` 做幂等处理；同一请求重试返回原结果。
5. 仅在 commit 保存成功后返回 `committed`；不得以“收到请求”作为保存成功。

参考：[Cloudflare Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Cloudflare CORS 示例](https://developers.cloudflare.com/workers/examples/cors-header-proxy/)、[GitHub Git Data API](https://docs.github.com/en/rest/git)。
