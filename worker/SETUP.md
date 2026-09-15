# 在 Cloudflare 编辑器中启用上传

1. 打开本目录的 `worker.js`，复制全部内容，覆盖 Cloudflare 编辑器中的 Hello World 代码，点击 **Deploy**。
2. 返回这个 Worker 的 **Settings → Variables and Secrets → Add**，添加以下两个变量，类型都选择 **Secret**。

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | 你创建的 GitHub fine-grained personal access token，仅授权 `SherlockGy.github.io` 仓库，Repository permissions → Contents 选择 Read and write |
| `UPLOAD_PASSWORD` | 自己设置至少 8 位的上传口令，建议混合字母和数字；以后在图集网站上传时输入这个口令 |

3. 保存并部署 Secret。打开 Worker 根地址，显示 `"ready": true` 表示两个配置已经读到；GitHub 权限需通过实际上传验证。
4. 回到图集网站，刷新，点击 **新建图集**，选择图片、填写名称，输入 `UPLOAD_PASSWORD` 的值，点击 **发布图集**。

前端 `config.js` 已设置为截图中的地址：

```text
https://github-image-upload.sherlockjgy.workers.dev/albums
```

如果 Cloudflare 显示的实际域名不同，更新 `config.js` 中的 `uploadEndpoint`。Worker 代码已固定仓库和分支，无需替换占位符。两个密钥只填入 Cloudflare Secret，不要写进代码，也不要发到聊天中。

创建 Token 的入口：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。Resource owner 选择 SherlockGy；Repository access 选择 Only select repositories，再选 SherlockGy.github.io；设置有效期。仅需 Contents 的 Read and write，Metadata 的 Read-only 为自动附带权限。

## 运行说明

- 不需要 KV、D1、R2 或 npm 依赖。
- 1–30 张图片保存为一个命名图集，图片和目录通过一个 Git commit 一起提交。
- 不强制更新分支；并发冲突时重读目录，保留其他内容。同一批图片的重试复用请求编号，避免超时后重复保存。
- 文件类型通过文件头判断，不进行完整图像解码。PNG/GIF 自动记录宽高，其他格式可正常阅读。
- 自带每个 Worker isolate 内的简单频率限制；它不提供全球统一的严格限额。
- 代码上限为单张 10 MiB、合计 30 MiB。Cloudflare Free 的 CPU 限额较低，大图批量编码可能触发 1102；遇到时先减小图片或分批，需稳定处理大图时再评估 Workers Paid。未在你的 Cloudflare 账户进行负载测试。
- 显示保存成功后，GitHub Pages 还需要完成发布，稍后刷新网站查看。

参考：[Cloudflare Secret 设置](https://developers.cloudflare.com/workers/configuration/secrets/)、[GitHub Token 创建](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[Cloudflare 运行限制](https://developers.cloudflare.com/workers/platform/limits/)。
