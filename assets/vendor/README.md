# 下载组件

仅在生成图集文件时由后台线程加载，文件直接来自固定版本的 npm 发布包。

- `pdf-lib-1.17.1.min.js`：`pdf-lib@1.17.1` 的 `dist/pdf-lib.min.js`，MIT 许可证。
  - 同时保留 standard-fonts、upng、pako、tslib 的许可证。
- `pptxgenjs-4.0.1.bundle.js`：`pptxgenjs@4.0.1` 的 `dist/pptxgen.bundle.js`，MIT 许可证。
  - bundle 包含 JSZip，保留 JSZip 与 pako 的许可证。

升级时从对应 npm 包复制发布文件，保留原始代码与许可证，验证 PDF 页数和 PPTX 幻灯片顺序、图片边界以及浏览器取消流程。

官方说明：[pdf-lib](https://pdf-lib.js.org/)、[PptxGenJS](https://gitbrent.github.io/PptxGenJS/)。
