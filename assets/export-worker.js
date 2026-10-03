/* 文件生成在独立线程中执行，取消时可立即终止，避免大图集阻塞阅读界面。 */
function progress(message) { self.postMessage({ type: 'progress', message }); }

async function readImage(source, index, pngNeedsNormalization) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(source, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const { width, height } = bitmap;
      if (!width || !height) throw new Error('图片尺寸无效');
      // 普通 PNG 保留原始文件；带旋转或动画元数据时先固定方向与静态画面。
      let bytes = new Uint8Array(await blob.arrayBuffer());
      const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
      if (!isPng || pngNeedsNormalization(bytes)) {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        canvas.width = canvas.height = 1;
      }
      return { width, height, bytes };
    } finally { bitmap.close(); }
  } catch {
    throw new Error(`第 ${index + 1} 张图片读取失败，请检查网络后重试；本次未生成文件。`);
  } finally { clearTimeout(timer); }
}

function imageData(bytes) {
  const parts = [];
  for (let index = 0; index < bytes.length; index += 32768) parts.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  return `data:image/png;base64,${btoa(parts.join(''))}`;
}

self.onmessage = async ({ data: { album, format } }) => {
  const logPrefix = `[exportAlbum 导出图集][albumId=${album.id}][format=${format}]`;
  try {
    if (!['pdf', 'pptx'].includes(format) || !album.images.length) throw new Error('图集或下载格式无效');
    progress('正在准备下载组件…');
    const { pngPdfStream, pngNeedsNormalization } = await import('./export-png.js?v=20261004-export-2');
    let pdf, pptx, slideWidth, slideHeight;
    if (format === 'pdf') {
      importScripts('./vendor/pdf-lib-1.17.1.min.js');
      pdf = await self.PDFLib.PDFDocument.create();
      pdf.setTitle(album.title); pdf.setCreator('SherlockGy 图集');
    } else {
      importScripts('./vendor/pptxgenjs-4.0.1.bundle.js');
      pptx = new self.PptxGenJS(); pptx.title = album.title; pptx.author = 'SherlockGy';
    }
    for (let index = 0; index < album.images.length; index++) {
      progress(`正在处理第 ${index + 1} / ${album.images.length} 张图片…`);
      const image = await readImage(album.images[index].src, index, pngNeedsNormalization);
      if (pdf) {
        // 每页按该图片的比例设置纸张，完整显示，不裁剪也不添加额外封面。
        const scale = 720 / Math.max(image.width, image.height);
        const width = image.width * scale, height = image.height * scale;
        const page = pdf.addPage([width, height]), png = pngPdfStream(image.bytes);
        if (png && png.width === image.width && png.height === image.height) {
          const stream = pdf.context.stream(png.data, {
            Type: 'XObject', Subtype: 'Image', Width: png.width, Height: png.height,
            BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
            DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: png.width },
          });
          const name = page.node.newXObject('Image', pdf.context.register(stream));
          const { pushGraphicsState, concatTransformationMatrix, drawObject, popGraphicsState } = self.PDFLib;
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(width, 0, 0, height, 0, 0), drawObject(name), popGraphicsState());
        } else {
          const embedded = await pdf.embedPng(image.bytes);
          page.drawImage(embedded, { x: 0, y: 0, width, height });
          await pdf.flush();
        }
      } else {
        // 演示文稿统一使用首图比例，不同比例的后续图片等比居中留白。
        if (!index) {
          const scale = 13.333333 / Math.max(image.width, image.height);
          slideWidth = image.width * scale; slideHeight = image.height * scale;
          pptx.defineLayout({ name: 'ALBUM', width: slideWidth, height: slideHeight }); pptx.layout = 'ALBUM';
        }
        const scale = Math.min(slideWidth / image.width, slideHeight / image.height);
        const w = image.width * scale, h = image.height * scale;
        const slide = pptx.addSlide(); slide.background = { color: 'FFFFFF' };
        slide.addImage({ data: imageData(image.bytes), x: (slideWidth - w) / 2, y: (slideHeight - h) / 2, w, h,
          altText: album.images[index].alt || `第 ${index + 1} 张图片` });
      }
    }
    progress(`正在生成 ${format.toUpperCase()} 文件…`);
    const blob = pdf ? new Blob([await pdf.save({ objectsPerTick: 1000 })], { type: 'application/pdf' })
      : await pptx.write({ outputType: 'blob', compression: true });
    self.postMessage({ type: 'complete', blob });
  } catch (error) {
    console.warn(logPrefix, '文件生成失败', error);
    self.postMessage({ type: 'error', message: error.message?.startsWith('第 ') ? error.message : '文件生成失败，请重试或选择另一种格式。' });
  }
};
