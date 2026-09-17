import { configureCoverImage } from './covers.js?v=20260917-previews-1';

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

export function createPreviewButton(image, index, onOpen) {
  const button = node('button', 'image-preview-button'); button.type = 'button';
  button.setAttribute('aria-label', `查看第 ${index + 1} 张大图`);
  const hint = node('span', 'image-preview-hint', '查看大图');
  const thumbnail = configureCoverImage(node('img'), { ...image, alt: '' }, {
    sizes: '(max-width: 360px) 96px, (max-width: 760px) 112px, 144px',
    onError: () => { thumbnail.hidden = true; hint.textContent = '点击重试预览'; },
  });
  button.append(thumbnail, hint); button.addEventListener('click', onOpen);
  return button;
}

// The original is requested only after opening this separate, nested dialog.
// The caller owns local object URLs; closing the preview never revokes a draft.
export function createImagePreview(onOpenChange) {
  const dialog = node('dialog', 'upload-dialog image-preview-dialog');
  dialog.id = 'image-preview'; dialog.setAttribute('aria-labelledby', 'image-preview-title');
  const header = node('header', 'dialog-header');
  const heading = node('div', 'image-preview-heading');
  const title = node('h2'); title.id = 'image-preview-title';
  const filename = node('p'); heading.append(title, filename);
  const close = node('button', 'icon-button'); close.type = 'button'; close.autofocus = true;
  close.setAttribute('aria-label', '关闭大图预览');
  close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="./assets/icons.svg#close"/></svg>';
  header.append(heading, close);
  const stage = node('div', 'image-preview-stage'); stage.tabIndex = 0;
  stage.setAttribute('aria-label', '图片预览；放大后可滚动查看细节');
  const footer = node('footer', 'image-preview-toolbar');
  const previous = node('button', 'secondary-button', '上一张');
  const zoom = node('button', 'secondary-button', '原尺寸');
  const next = node('button', 'secondary-button', '下一张');
  for (const button of [previous, zoom, next]) button.type = 'button';
  zoom.setAttribute('aria-pressed', 'false');
  footer.append(previous, zoom, next); dialog.append(header, stage, footer); document.body.append(dialog);
  let images = [], index = 0, zoomed = false;
  const resetZoom = () => {
    zoomed = false; stage.classList.remove('is-zoomed'); zoom.textContent = '原尺寸'; zoom.setAttribute('aria-pressed', 'false');
    stage.scrollTop = 0; stage.scrollLeft = 0;
  };
  const render = () => {
    resetZoom(); zoom.disabled = true;
    const current = images[index];
    title.textContent = `第 ${index + 1} / ${images.length} 张${index === 0 ? ' · 封面' : ''}`;
    filename.textContent = current.name || current.alt || ''; filename.title = filename.textContent;
    previous.disabled = index === 0; next.disabled = index === images.length - 1;
    const status = node('p', 'image-preview-status', '正在加载大图…'); status.setAttribute('role', 'status');
    const image = node('img'); image.alt = current.alt || `第 ${index + 1} 张图片`; image.decoding = 'async';
    image.hidden = true;
    image.addEventListener('load', () => {
      if (!dialog.open || !stage.contains(image)) return;
      status.hidden = true; image.hidden = false; zoom.disabled = false;
    });
    image.addEventListener('error', () => {
      if (!dialog.open || !stage.contains(image)) return;
      status.textContent = '大图暂时无法加载，请关闭后重试。';
    });
    stage.replaceChildren(status, image); image.src = current.src;
  };
  const go = value => { if (value >= 0 && value < images.length && value !== index) { index = value; render(); } };
  previous.addEventListener('click', () => go(index - 1));
  next.addEventListener('click', () => go(index + 1));
  zoom.addEventListener('click', () => {
    zoomed = !zoomed; stage.classList.toggle('is-zoomed', zoomed);
    zoom.textContent = zoomed ? '适合窗口' : '原尺寸'; zoom.setAttribute('aria-pressed', String(zoomed));
    stage.scrollTop = 0; stage.scrollLeft = 0;
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('close', () => { stage.replaceChildren(); images = []; onOpenChange(); });
  dialog.addEventListener('keydown', event => {
    // Keep preview navigation and Escape from reaching the underlying reader.
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey || zoomed) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1); }
  });
  return {
    open(values, selected = 0) {
      if (!values.length || dialog.open) return;
      images = values.map(value => ({ ...value })); index = Math.max(0, Math.min(selected, images.length - 1));
      dialog.showModal(); render(); onOpenChange();
    },
  };
}
