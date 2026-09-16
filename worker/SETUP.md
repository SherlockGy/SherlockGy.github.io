# 在 Cloudflare 编辑器中启用上传

1. 打开本目录的 `worker.js`，复制全部内容，覆盖 Cloudflare 编辑器中的 Hello World 代码，点击 **Deploy**。
2. 返回这个 Worker 的 **Settings → Variables and Secrets → Add**，添加以下两个变量，类型都选择 **Secret**。

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | 你创建的 GitHub fine-grained personal access token，仅授权 `SherlockGy.github.io` 仓库，Repository permissions → Contents 选择 Read and write |
| `UPLOAD_PASSWORD` | 自己设置至少 8 位的上传口令，建议混合字母和数字；以后在图集网站上传时输入这个口令 |

3. 保存并部署 Secret。打开 Worker 根地址，显示 `"ready": true` 表示两个配置已经读到，不代表 GitHub 连接和权限已验证。
4. 回到图集网站，刷新，点击 **添加图集**，输入 `UPLOAD_PASSWORD` 的值，点击 **测试连接**，无需选择图片。成功说明 GitHub 连接及目录读取正常；它不会写入仓库，因此不能验证写入权限。
5. 选择图片、填写名称与归属，点击 **保存图集**，完成第一次实际上传。

## 升级系列与编辑功能

先发布新版前端，再将本目录 `worker.js` 的完整代码部署到现有 Worker。继续使用原来的两个 Secret，不需要新增数据库、存储绑定或付费服务才能启用这些操作。健康检查版本应为 `2026-09-16-series-edit-1`。

- 侧栏“管理”进入系列管理，输入现有上传口令并载入最新内容。支持多层系列、同级排序、重命名和调整上级。
- 可将已有图集移入系列或移回月份归档；无日期的图集移回月份归档时需要选择日期。
- 新建图集时选择系列即可，不需要填写归档日期。
- 阅读窗口“编辑图片”支持新增、排序和换图。编辑后的图集最多 30 张；只对本次新文件执行上传，换图使用新的文件地址。
- 保存时会检查版本。遇到冲突，当前草稿保留，需自行选择“重新载入”后再编辑。重新载入会提示放弃当前修改。
- 旧图文件保留，换图不等于删除历史图片；同一页码链接在排序后可能显示另一张图片。

前端出现新入口不代表 Worker 已升级。若提示部署新版或接口不存在，先更新 Worker；仅更新 GitHub 中的源文件不会更新线上 Worker。仓库中的自动测试使用模拟 GitHub，不证明 Cloudflare 的实际部署和写权限已经验证。

前端 `config.js` 已设置为截图中的地址：

```text
https://github-image-upload.sherlockjgy.workers.dev/albums
```

如果 Cloudflare 显示的实际域名不同，更新 `config.js` 中的 `uploadEndpoint`。Worker 代码已固定仓库和分支，无需替换占位符。两个密钥只填入 Cloudflare Secret，不要写进代码，也不要发到聊天中。

创建 Token 的入口：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。Resource owner 选择 SherlockGy；Repository access 选择 Only select repositories，再选 SherlockGy.github.io；设置有效期。仅需 Contents 的 Read and write，Metadata 的 Read-only 为自动附带权限。

## 超时和连接诊断

- 更新 GitHub 上的 `worker.js` 不会自动更新 Cloudflare。请重新复制全部代码到 Cloudflare 编辑器并点击 **Deploy**。访问 `/health`，`version` 为 `2026-09-16-series-edit-1` 表示已部署这一版；若“测试连接”提示先部署新版，说明 `/check` 接口尚未更新。
- 若旧版提示 `Invalid redirect value`，属于 Worker 运行环境不支持 `redirect: 'error'` 的兼容性错误，请部署新版。新版使用 `manual` 并检查重定向状态，不会跟随跳转转发 Token；无需为此修改上传口令或重新生成 Token。
- 打开 Cloudflare → Workers & Pages → `github-image-upload` → **Logs → Live**，开始查看实时日志，再回网站点击 **测试连接**或重试上传。
- 日志中的 `github.start`、`github.success`、`github.error` 标记每一步，`stage` 表示读取主分支、读取图集目录、保存第几张图片或发布图集。`elapsedMs` 是耗时，`httpStatus` 是 GitHub 返回的 HTTP 状态，`traceId` 与页面错误中的请求编号对应。
- 真正超过单步 20 秒限时或收到超时异常时，才返回 `GITHUB_TIMEOUT`。其他网络或请求异常返回 `GITHUB_CONNECTION_ERROR`；GitHub 拒绝请求返回 `GITHUB_ERROR` 并保留 HTTP 状态。401 通常需要检查 Token；403 可能涉及权限、限流或仓库限制；404 需要检查仓库授权及目标分支、文件。
- 日志不记录图片、口令、Token、鉴权头或请求正文；异常信息会过滤凭据。排查时只需提供页面错误或对应 `github.error` 日志，不要提供 Secret。
- 测试连接及失败重试会保留当前图片、名称和请求编号。刷新页面会丢失尚未提交的草稿，请先保留原始图片。客户端上传等待超时后，先检查图集目录；未刷新时原样重试会复用请求编号。

## 运行说明

- 不需要 KV、D1、R2 或 npm 依赖。
- 1–30 张图片保存为一个命名图集，图片和目录通过一个 Git commit 一起提交。
- 不强制更新分支；并发冲突时重读目录，保留其他内容。同一批图片的重试复用请求编号，避免超时后重复保存。
- 文件类型通过文件头判断，不进行完整图像解码。PNG/GIF 自动记录宽高，其他格式可正常阅读。
- 自带每个 Worker isolate 内的简单频率限制；它不提供全球统一的严格限额。
- 代码上限为单张 10 MiB、合计 30 MiB。Cloudflare Free 的 CPU 限额较低，大图批量编码可能触发 1102；遇到时先减小图片或分批，需稳定处理大图时再评估 Workers Paid。未在你的 Cloudflare 账户进行负载测试。
- 显示保存成功后，GitHub Pages 还需要完成发布，稍后刷新网站查看。

参考：[Cloudflare Secret 设置](https://developers.cloudflare.com/workers/configuration/secrets/)、[GitHub Token 创建](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[Cloudflare 实时日志](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)、[Cloudflare 运行限制](https://developers.cloudflare.com/workers/platform/limits/)。
