import { configureCoverImage } from './covers.js?v=20260917-previews-1';

export function createReaderDirectory(list, onSelect) {
  let album = null, page = 0;
  let imageCleanups = [];

  // 退出逐页模式时取消目录图片请求，阻止迟到的失败事件继续加载原图。
  function releaseImages() {
    imageCleanups.forEach(cleanup => cleanup());
    imageCleanups = [];
    list.replaceChildren();
  }

  // 只滚动缩略图目录，保持主图和整个阅读窗口的位置不变。
  function revealCurrent() {
    const active = list.children[page];
    if (list.hidden || !active || !list.clientHeight) return;
    const top = active.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + active.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + active.offsetHeight - list.clientHeight;
    }
  }

  // 阅读区高度变化后，当前页仍保持在目录的可见范围内。
  new ResizeObserver(revealCurrent).observe(list);

  // 目录只保留当前页一个 Tab 停靠点，上下方向键直接切换图片。
  list.addEventListener('keydown', event => {
    if (!album || event.ctrlKey || event.metaKey || event.altKey) return;
    const targets = { ArrowUp: page - 1, ArrowDown: page + 1, Home: 0, End: album.images.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault(); event.stopPropagation();
    onSelect(Math.max(0, Math.min(album.images.length - 1, targets[event.key])));
  });

  return {
    // 点击阅读区后，将翻页键盘位置交还给当前缩略图。
    focusCurrent() {
      if (!list.hidden) list.children[page]?.focus({ preventScroll: true });
    },
    show(nextAlbum, nextPage) {
      const restoreFocus = list.contains(document.activeElement);
      list.hidden = false;
      if (album !== nextAlbum) {
        releaseImages();
        album = nextAlbum;
        album.images.forEach((image, index) => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'slideshow-thumb';
          button.setAttribute('aria-label', `第 ${index + 1} 张${image.alt ? `：${image.alt}` : ''}`);
          button.title = button.getAttribute('aria-label');

          // 优先使用已发布的缩略图，缺少时按需加载原图。
          const img = document.createElement('img');
          let released = false;
          img.addEventListener('error', event => {
            if (released) event.stopImmediatePropagation();
          }, { capture: true });
          imageCleanups.push(() => {
            released = true;
            img.removeAttribute('srcset'); img.removeAttribute('src');
          });
          const unavailable = document.createElement('span');
          unavailable.className = 'reader-thumbnail-error';
          unavailable.textContent = '预览不可用'; unavailable.hidden = true;
          configureCoverImage(img, { ...image, alt: '' }, {
            sizes: '144px', onError: () => {
              // 预览失败时保留页码和跳页入口，避免空白框让人误以为仍在加载。
              img.hidden = true; unavailable.hidden = false;
              button.title = `预览加载失败，点击查看第 ${index + 1} 张图片`;
            },
          });
          img.draggable = false;
          const preview = document.createElement('span');
          preview.className = 'slideshow-thumbnail'; preview.append(img, unavailable);
          const number = document.createElement('span');
          number.className = 'slideshow-number'; number.textContent = String(index + 1).padStart(2, '0');
          button.append(preview, number);
          button.addEventListener('click', () => onSelect(index));
          list.append(button);
        });
      }
      page = nextPage;
      [...list.children].forEach((button, index) => {
        button.tabIndex = index === page ? 0 : -1;
        if (index === page) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      if (restoreFocus) list.children[page]?.focus({ preventScroll: true });
      revealCurrent();
    },
    clear() {
      list.hidden = true; releaseImages(); album = null; page = 0;
    },
  };
}
