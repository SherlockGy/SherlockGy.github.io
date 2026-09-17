import { configureCoverImage } from './covers.js?v=20260917-previews-1';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function fitImage(width, height, viewportWidth, viewportHeight, padding = 12) {
  if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return { width: 0, height: 0 };
  const ratio = Math.min(Math.max(1, viewportWidth - padding * 2) / width, Math.max(1, viewportHeight - padding * 2) / height);
  return { width: width * ratio, height: height * ratio };
}

export function constrainPan(x, y, width, height, viewportWidth, viewportHeight) {
  // Beyond each image edge, allow blank space equal to half the viewing area.
  const limitX = Math.max(0, (width - viewportWidth) / 2 + viewportWidth * .5);
  const limitY = Math.max(0, (height - viewportHeight) / 2 + viewportHeight * .5);
  return { x: clamp(x, -limitX, limitX), y: clamp(y, -limitY, limitY) };
}

export function zoomAtPoint(view, nextScale, point) {
  const scale = clamp(nextScale, .25, 8), ratio = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

export function createWheelPager() {
  let lastTime = -Infinity, total = 0, locked = false, direction = 0;
  return {
    reset() { lastTime = -Infinity; total = 0; locked = false; direction = 0; },
    feed(delta, time) {
      if (!delta) return 0;
      const sign = Math.sign(delta);
      // A continuous touchpad gesture (including inertia) turns only one page.
      if (time - lastTime > 180 || sign !== direction) { total = 0; locked = false; }
      lastTime = time; direction = sign; total += delta;
      if (locked || Math.abs(total) < 36) return 0;
      locked = true;
      return sign;
    },
  };
}

export function createSlideshow(root, { onSelect, onExit }) {
  const $ = selector => root.querySelector(selector);
  const canvas = $('.slideshow-canvas'), list = $('.slideshow-list');
  const handButton = $('#slideshow-hand'), fitButton = $('#slideshow-fit');
  const status = $('#slideshow-status'), pager = createWheelPager();
  const pointers = new Map();
  let album = null, page = 0, currentImage = null, hand = false, gesture = null;
  let view = { scale: 1, x: 0, y: 0 }, fitted = { width: 0, height: 0 };
  const ready = () => currentImage?.complete && currentImage.naturalWidth > 0 && !currentImage.hidden;
  const point = event => ({ x: event.clientX, y: event.clientY });
  const measureGesture = () => {
    const [first, second] = pointers.values();
    if (!first) return null;
    return second ? {
      x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    } : { ...first, distance: 0 };
  };

  function stopDrag() {
    const ids = [...pointers.keys()];
    pointers.clear(); gesture = null; canvas.classList.remove('dragging');
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function paint() {
    const pan = constrainPan(view.x, view.y, fitted.width * view.scale, fitted.height * view.scale, canvas.clientWidth, canvas.clientHeight);
    view = { ...view, ...pan };
    if (currentImage) {
      currentImage.style.width = `${fitted.width}px`; currentImage.style.height = `${fitted.height}px`;
      currentImage.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    const scale = `${Math.round(view.scale * 100)}%`;
    $('#slideshow-scale').textContent = scale;
    $('#slideshow-scale').setAttribute('aria-label', `当前缩放 ${scale}`);
  }
  function resize() {
    if (root.hidden || !currentImage?.naturalWidth) return;
    const next = fitImage(currentImage.naturalWidth, currentImage.naturalHeight, canvas.clientWidth, canvas.clientHeight);
    if (!next.width || !next.height) return;
    stopDrag();
    if (fitted.width && fitted.height) {
      view.x *= next.width / fitted.width; view.y *= next.height / fitted.height;
    }
    fitted = next; paint();
  }
  function resetView() {
    stopDrag(); view = { scale: 1, x: 0, y: 0 }; paint();
  }
  function setHand(enabled) {
    hand = enabled; pager.reset(); resetView();
    canvas.classList.toggle('hand-mode', hand);
    handButton.setAttribute('aria-pressed', String(hand));
    const label = hand ? '关闭拖动，恢复适屏' : '开启拖动与缩放（滚轮 / 双指）';
    handButton.setAttribute('aria-label', label); handButton.title = label;
    canvas.setAttribute('aria-label', hand ? '放映图片：拖动查看，滚轮或双指缩放；加减键缩放，0 键恢复适屏' : '放映图片');
    $('#slideshow-hint').textContent = hand ? '拖动查看 · 滚轮或双指缩放' : '滚轮翻页 · 点击目录跳转';
  }
  function zoom(scale, clientPoint) {
    const rect = canvas.getBoundingClientRect();
    view = zoomAtPoint(view, scale, { x: clientPoint.x - rect.left - rect.width / 2, y: clientPoint.y - rect.top - rect.height / 2 });
  }
  function renderDirectory() {
    list.replaceChildren();
    $('#slideshow-title').textContent = album.title;
    $('#slideshow-title').title = album.title;
    album.images.forEach((image, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'slideshow-thumb';
      button.setAttribute('aria-label', `第 ${index + 1} 张${image.alt ? `：${image.alt}` : ''}`);
      button.title = button.getAttribute('aria-label');
      const img = configureCoverImage(document.createElement('img'), { ...image, alt: '' }, {
        sizes: '(max-width: 540px) 56px, 160px', onError: () => { img.hidden = true; },
      });
      img.draggable = false;
      const preview = document.createElement('span'); preview.className = 'slideshow-thumbnail'; preview.append(img);
      const number = document.createElement('span'); number.className = 'slideshow-number'; number.textContent = String(index + 1).padStart(2, '0');
      button.append(preview, number);
      button.addEventListener('click', () => { pager.reset(); onSelect(index); });
      list.append(button);
    });
  }
  function show(nextAlbum, nextPage) {
    const focused = document.activeElement;
    const logPrefix = `[showSlideshow 图集放映][albumId=${nextAlbum.id}][page=${nextPage + 1}]`;
    const changedAlbum = album !== nextAlbum;
    album = nextAlbum; page = nextPage;
    if (changedAlbum) { setHand(false); renderDirectory(); }
    resetView();
    [...list.children].forEach((button, index) => {
      if (index === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const active = list.children[page];
    if (active) {
      const top = active.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + active.offsetHeight - list.clientHeight;
    }
    $('#slideshow-count').textContent = `${page + 1} / ${album.images.length}`;
    $('#slideshow-prev').disabled = page === 0;
    $('#slideshow-next').disabled = page === album.images.length - 1;
    if (canvas.contains(focused) || (root.contains(focused) && focused.disabled)) canvas.focus({ preventScroll: true });
    const source = album.images[page], img = document.createElement('img');
    currentImage = img; fitted = { width: 0, height: 0 };
    img.className = 'slideshow-image'; img.alt = source.alt || `第 ${page + 1} 张图片`; img.draggable = false;
    img.decoding = 'async'; img.hidden = true;
    status.replaceChildren(document.createTextNode('正在加载图片…')); status.hidden = false;
    canvas.replaceChildren(img, status); canvas.setAttribute('aria-busy', 'true');
    img.addEventListener('load', () => {
      if (currentImage !== img) return;
      resize(); img.hidden = false; status.hidden = true; canvas.setAttribute('aria-busy', 'false');
    });
    img.addEventListener('error', () => {
      if (currentImage !== img) return;
      console.warn(`${logPrefix} 图片加载失败`);
      img.hidden = true; canvas.setAttribute('aria-busy', 'false');
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新加载';
      retry.addEventListener('click', () => show(album, page));
      status.replaceChildren(document.createTextNode('这张图片暂时无法加载'), retry); status.hidden = false;
    });
    img.src = source.src;
  }
  $('#slideshow-exit').addEventListener('click', onExit);
  $('#slideshow-prev').addEventListener('click', () => onSelect(page - 1));
  $('#slideshow-next').addEventListener('click', () => onSelect(page + 1));
  handButton.addEventListener('click', () => {
    setHand(!hand);
    if (hand) canvas.focus({ preventScroll: true });
  });
  fitButton.addEventListener('click', resetView);
  canvas.addEventListener('dragstart', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    if (hand) {
      if (!ready()) return;
      stopDrag();
      zoom(view.scale * Math.exp(-clamp(delta, -120, 120) * .0025), point(event));
      paint();
    } else {
      const step = pager.feed(delta, event.timeStamp);
      if (step && page + step >= 0 && page + step < album.images.length) onSelect(page + step);
    }
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    if (!hand || event.button !== 0 || !ready() || event.target.closest('button, a')) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    pointers.set(event.pointerId, point(event)); gesture = measureGesture();
    canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point(event));
    const next = measureGesture();
    if (gesture.distance > 0 && next.distance > 0) zoom(view.scale * next.distance / gesture.distance, gesture);
    view.x += next.x - gesture.x; view.y += next.y - gesture.y;
    gesture = next; paint();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
    if (!pointers.delete(event.pointerId)) return;
    gesture = measureGesture();
    if (!pointers.size) canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('keydown', event => {
    if (!hand || !ready() || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    if (!['+', '=', '-', '_', '0'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); stopDrag();
    if (event.key === '0') resetView();
    else {
      const rect = canvas.getBoundingClientRect();
      zoom(view.scale * (['+', '='].includes(event.key) ? 1.25 : .8), { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      paint();
    }
  });
  new ResizeObserver(resize).observe(canvas);
  return {
    open(nextAlbum, nextPage) {
      root.hidden = false; setHand(false); show(nextAlbum, nextPage); canvas.focus({ preventScroll: true });
    },
    show,
    resize,
    close() {
      setHand(false); root.hidden = true; album = null; currentImage = null;
      canvas.replaceChildren(status); list.replaceChildren();
    },
  };
}
