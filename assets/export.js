import config from '../config.js';
import { verifyExportPassword, exportFilename } from './export-client.js?v=20261004-export-2';
import { setFeedback } from './feedback.js?v=20260917-interaction-1';

export function createAlbumExport(onOpenChange) {
  const dialog = document.querySelector('#album-export');
  const $ = selector => dialog.querySelector(selector);
  const password = $('#export-password'), format = $('#export-format'), submit = $('#export-submit');
  const status = $('#export-status'), download = $('#export-download'), cancel = $('#export-cancel');
  let album, opener, worker, controller, downloadUrl, rejectGeneration, verified = false, busy = false, generation = 0;

  function releaseFile() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null; download.removeAttribute('href'); download.hidden = true; submit.hidden = false;
  }
  function sync() {
    password.disabled = busy || verified; password.required = !verified;
    password.placeholder = verified ? '口令已验证' : '输入现有上传口令';
    format.disabled = busy; submit.disabled = busy; cancel.hidden = !busy;
    $('#export-format-note').textContent = format.value === 'pdf'
      ? '每张图片一页，页面跟随图片比例，适合阅读与打印。'
      : '每张图片一张幻灯片，以首图确定画幅；其他图片完整居中。图片中的文字不可单独编辑。';
    dialog.setAttribute('aria-busy', String(busy));
  }
  function stop() {
    generation++; controller?.abort(); controller = null;
    rejectGeneration?.(new DOMException('已取消生成', 'AbortError')); rejectGeneration = null;
    worker?.terminate(); worker = null; busy = false; sync();
  }
  function finishClose() {
    stop(); releaseFile(); verified = false; password.value = ''; album = null;
    onOpenChange();
    if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    opener = null;
  }
  function close() {
    if (dialog.open) { dialog.close(); finishClose(); }
  }
  dialog.addEventListener('close', () => {
    // close 事件异步派发，不能清除用户在事件到达前重新打开的下载窗口。
    if (!dialog.open && album) finishClose();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('#export-close').addEventListener('click', close);
  cancel.addEventListener('click', () => { stop(); setFeedback(status, '已取消，可重新生成。'); submit.focus(); });
  format.addEventListener('change', () => { releaseFile(); setFeedback(status, ''); sync(); });

  $('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !album) return;
    const logPrefix = `[exportAlbum 下载图集][albumId=${album.id}][format=${format.value}]`;
    const run = ++generation;
    busy = true; releaseFile(); sync();
    try {
      if (!verified) {
        setFeedback(status, '正在验证口令…');
        const requestController = new AbortController(); controller = requestController;
        const timer = setTimeout(() => requestController.abort(), 30000);
        try { await verifyExportPassword(config.uploadEndpoint, password.value, { signal: requestController.signal }); }
        finally { clearTimeout(timer); }
        if (run !== generation) return;
        verified = true; password.value = ''; controller = null; sync();
      }
      if (run !== generation) return;
      setFeedback(status, '正在准备图片…');
      worker = new Worker(new URL('./export-worker.js?v=20261004-export-2', import.meta.url));
      const blob = await new Promise((resolve, reject) => {
        rejectGeneration = reject;
        worker.onmessage = ({ data }) => {
          if (run !== generation) return;
          if (data.type === 'progress') setFeedback(status, data.message);
          else if (data.type === 'complete') resolve(data.blob);
          else if (data.type === 'error') reject(new Error(data.message));
        };
        worker.onerror = event => { event.preventDefault(); reject(new Error('下载组件加载失败，请刷新后重试。')); };
        worker.postMessage({ album, format: format.value });
      });
      if (run !== generation) return;
      downloadUrl = URL.createObjectURL(blob); download.href = downloadUrl;
      download.download = exportFilename(album.title, format.value); download.hidden = false; submit.hidden = true;
      download.textContent = `下载 ${format.value.toUpperCase()}`;
      setFeedback(status, '文件已生成，已发起下载。如果没有开始，请点击下载按钮。', 'success');
      download.click();
    } catch (error) {
      if (run !== generation) return;
      console.warn(logPrefix, '下载未完成');
      setFeedback(status, error.name === 'AbortError' ? '口令校验超时，请重试。'
        : error instanceof TypeError ? '无法连接下载服务，请检查网络后重试。' : error.message, 'error');
    } finally {
      if (run === generation) {
        worker?.terminate(); worker = null; controller = null; rejectGeneration = null; busy = false; sync();
        (downloadUrl ? download : verified ? submit : password).focus({ preventScroll: true });
      }
    }
  });
  return {
    open(source) {
      if (!source || source.local || !config.uploadEndpoint || dialog.open) return;
      album = { id: source.id, title: source.title, images: source.images.map(image => ({ src: image.src, alt: image.alt })) };
      opener = document.activeElement; verified = false; password.value = ''; format.value = 'pdf';
      $('#export-album-name').textContent = `${album.title} · ${album.images.length} 张图片`;
      setFeedback(status, ''); releaseFile(); sync();
      dialog.showModal(); onOpenChange(); password.focus();
    },
    close,
  };
}
