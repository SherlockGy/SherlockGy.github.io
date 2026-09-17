# 首页缩略图与 Pages 发布

首页只需要图集封面。构建脚本读取每个图集当前第一张图片，生成 480 / 960 两档 WebP；原图继续供逐页阅读、连续阅读和下载。保留完整构图与透明度，小图不放大，动画取第一帧作为静态封面，EXIF 方向在缩略图中应用。

## 现有图片如何处理

第一次运行构建时自动扫描 `data/albums.json`，处理其中所有现有图集的封面，不需要重新上传。当前 4 个图集会生成 8 个文件：480 档合计 124,110 字节，960 档合计 338,934 字节；对应原图合计 6,497,989 字节。浏览器根据卡片尺寸和像素密度选择一个候选，不会同时下载两档。实际首页耗时仍取决于网络和缓存。

- 只生成首页需要的第一张图片封面；当前阅读器侧栏的其他小图保持原有行为。
- 新增图集、替换首图或重排后，下一次发布按新的第一张图片生成封面。
- 缩略图名称取决于图片内容和编码配置；相同内容复用 Actions 缓存，配置变化会重新生成。
- 缓存只用于加速构建。缓存缺失可从仓库原图重建，不影响正确性。
- `data/albums.json` 源文件和原图不改写。派生的 `thumbnails` 字段仅出现在 `_site/data/albums.json` 中。
- 仓库外部的图片地址继续用原图显示，不自动抓取外部资源。仓库内封面丢失或无法解码会使构建失败，避免发布缺文件的目录。
- 旧目录、尚未完成发布的目录和本地预览均能使用原图；线上缩略图请求失败时先回退一次原图。

## 一次性启用

1. 合并包含 `.github/workflows/pages.yml` 的变更。PR 只执行测试和构建，不部署生产网站。
2. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
3. 打开 **Actions → Build and deploy Pages**，确认主分支运行成功；若首次运行早于来源切换而失败，重跑失败任务或选择 **Run workflow**。
4. 查看首页，检查封面请求路径为 `/thumbnails/…webp`。点击阅读后图片地址应仍为 `/images/…`。

这次升级不需要重新部署 Cloudflare Worker，不需要新增 Secret，也不改变上传完成的判定。上传返回“已保存”后，仍需等待网站构建、发布结束才能看到更新；构建期间线上保留上一版。

## 发布流程

工作流在 `master` 的每次 push、PR 和手动触发时运行。先执行 JavaScript 与 Python 测试，再恢复内容缓存、生成 `_site` 并打包 Pages 产物。只有主分支可执行部署，构建成功才发布；图片与目录属于同一发布产物。

`_site` 包含首页、404 页面、公开配置、页面资源、原图、数据与缩略图。构建脚本、测试、Worker 源码和构建缓存不进入产物。原图目录完整复制，保留已存在的原图地址。

构建输出示例：

```json
{"covers":4,"externalCovers":0,"generated":8,"cached":0,"originalCoverBytes":6497989,"thumbnailBytes":463044}
```

首次完整生成后，同样的图片和编码配置再次构建应显示 `generated: 0`、`cached: 8`。脚本在本地可使用 `--source`、`--output`、`--cache` 指定路径；默认 `_site` 仅可覆盖自身生成过的目录。

## 回退

可以回退相关代码提交并恢复原来的 Pages 分支发布；前端缺少缩略图字段时自动使用原图。切回分支发布时同步移除或停用该自定义部署工作流，避免两个发布流程互相覆盖。原图和源目录始终可用于恢复，不依赖缓存或生成图片的 Git 历史。

参考：[GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[选择发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。
