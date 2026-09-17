import { fitImage, constrainPan, zoomAtPoint } from './slideshow.js?v=20260917-review-3';

// Keep the page frame fixed while moving only its image. Use the same geometry
// and zoom limits as the fullscreen hand tool.
export function createImageReader(frame, { keyTarget, onScaleChange }) {
  const image = frame.querySelector('img'), pointers = new Map();
  let hand = false, gesture = null, disposed = false, reportedScale;
  let view = { scale: 1, x: 0, y: 0 }, fitted = { width: 0, height: 0 };
  const ready = () => !disposed && image.complete && image.naturalWidth > 0 && !image.hidden;
  const point = event => ({ x: event.clientX, y: event.clientY });
  const measureGesture = () => {
    const [first, second] = pointers.values();
    if (!first) return null;
    return second ? {
      x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    } : { ...first, distance: 0 };
  };
  function stopGesture() {
    const ids = [...pointers.keys()];
    pointers.clear(); gesture = null; frame.classList.remove('dragging');
    for (const id of ids) if (frame.hasPointerCapture(id)) frame.releasePointerCapture(id);
  }
  function paint() {
    const pan = constrainPan(view.x, view.y, fitted.width * view.scale, fitted.height * view.scale, frame.clientWidth, frame.clientHeight);
    view = { ...view, ...pan };
    image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    if (reportedScale !== view.scale) { reportedScale = view.scale; onScaleChange(view.scale); }
  }
  function resize() {
    if (!ready()) return;
    const next = fitImage(image.naturalWidth, image.naturalHeight, frame.clientWidth, frame.clientHeight, 0);
    if (!next.width || !next.height) return;
    stopGesture();
    if (fitted.width && fitted.height) {
      view.x *= next.width / fitted.width; view.y *= next.height / fitted.height;
    }
    fitted = next; paint();
  }
  function reset() {
    stopGesture(); view = { scale: 1, x: 0, y: 0 }; paint();
  }
  function setHand(enabled) {
    hand = enabled; frame.classList.toggle('hand-mode', hand); reset();
  }
  function zoom(scale, clientPoint) {
    const rect = frame.getBoundingClientRect();
    view = zoomAtPoint(view, scale, { x: clientPoint.x - rect.left - rect.width / 2, y: clientPoint.y - rect.top - rect.height / 2 });
  }
  function onWheel(event) {
    if (!hand || !ready() || event.target.closest('button, a')) return;
    event.preventDefault(); stopGesture();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1);
    zoom(view.scale * Math.exp(-Math.max(-120, Math.min(120, delta)) * .0025), point(event));
    paint();
  }
  function onPointerDown(event) {
    if (!hand || !ready() || event.button !== 0 || event.target.closest('button, a')) return;
    event.preventDefault(); keyTarget.focus({ preventScroll: true });
    pointers.set(event.pointerId, point(event)); gesture = measureGesture();
    frame.setPointerCapture(event.pointerId); frame.classList.add('dragging');
  }
  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point(event));
    const next = measureGesture();
    if (gesture.distance > 0 && next.distance > 0) zoom(view.scale * next.distance / gesture.distance, gesture);
    view.x += next.x - gesture.x; view.y += next.y - gesture.y;
    gesture = next; paint();
  }
  function onPointerEnd(event) {
    if (!pointers.delete(event.pointerId)) return;
    gesture = measureGesture();
    if (!pointers.size) frame.classList.remove('dragging');
    if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
  }
  function onKey(event) {
    if (!hand || !ready() || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
    if (!['+', '=', '-', '_', '0'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); stopGesture();
    if (event.key === '0') reset();
    else {
      const rect = frame.getBoundingClientRect();
      zoom(view.scale * (['+', '='].includes(event.key) ? 1.25 : .8), { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      paint();
    }
  }
  image.draggable = false;
  image.addEventListener('load', resize);
  image.addEventListener('error', reset);
  frame.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('pointerdown', onPointerDown);
  frame.addEventListener('pointermove', onPointerMove);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) frame.addEventListener(type, onPointerEnd);
  keyTarget.addEventListener('keydown', onKey);
  const observer = new ResizeObserver(resize); observer.observe(frame);
  resize();
  return {
    setHand, reset,
    disconnect() {
      disposed = true; stopGesture(); observer.disconnect();
      frame.classList.remove('hand-mode'); image.style.removeProperty('transform');
      image.removeEventListener('load', resize); image.removeEventListener('error', reset);
      frame.removeEventListener('wheel', onWheel);
      frame.removeEventListener('pointerdown', onPointerDown); frame.removeEventListener('pointermove', onPointerMove);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) frame.removeEventListener(type, onPointerEnd);
      keyTarget.removeEventListener('keydown', onKey);
    },
  };
}

export function readingPage(rects, viewportHeight) {
  const visible = rects.filter(rect => rect.bottom > 0 && rect.top < viewportHeight * .35);
  return visible.sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0]?.index;
}

export function createScrollReader(stage, onSelect, { fixedLayout = false } = {}) {
  const figures = [...stage.querySelectorAll('.reader-page')];
  let frame, navigation = 0, pending = false, disposed = false;
  const sync = () => {
    frame = null;
    if (disposed || pending) return;
    const top = stage.getBoundingClientRect().top;
    const index = stage.scrollTop > 0 && stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1
      ? figures.length - 1
      : readingPage(figures.map((figure, index) => {
        const rect = figure.getBoundingClientRect();
        return { index, top: rect.top - top, bottom: rect.bottom - top };
      }), stage.clientHeight);
    if (index !== undefined) onSelect(index);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
  const cancelNavigation = () => { navigation++; pending = false; schedule(); };
  const onKey = event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation();
  };
  stage.addEventListener('scroll', schedule, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown']) stage.addEventListener(event, cancelNavigation, { passive: true });
  stage.addEventListener('keydown', onKey);
  const resizeObserver = new ResizeObserver(schedule);
  figures.forEach(figure => resizeObserver.observe(figure));
  return {
    goTo(index) {
      const target = figures[index];
      if (!target) return;
      const current = ++navigation;
      pending = true;
      target.scrollIntoView({ block: 'start', inline: 'nearest' });
      if (fixedLayout) {
        // A fixed frame never shifts when its image loads; only request the
        // destination eagerly and keep earlier originals lazy.
        target.querySelector('img').loading = 'eager';
        pending = false;
        return;
      }
      // Images without dimensions can move the target as they load. Load the
      // preceding pages before the final alignment, unless the user scrolls.
      const images = figures.slice(0, index + 1).map(figure => figure.querySelector('img'))
        .filter(img => !img.hasAttribute('width') || !img.hasAttribute('height'));
      images.forEach(img => { img.loading = 'eager'; });
      Promise.all(images.map(img => img.decode().catch(() => {}))).then(() => {
        if (disposed || current !== navigation) return;
        target.scrollIntoView({ block: 'start', inline: 'nearest' });
        pending = false;
      });
    },
    disconnect() {
      disposed = true; navigation++;
      cancelAnimationFrame(frame); resizeObserver.disconnect();
      stage.removeEventListener('scroll', schedule);
      for (const event of ['wheel', 'touchstart', 'pointerdown']) stage.removeEventListener(event, cancelNavigation);
      stage.removeEventListener('keydown', onKey);
    },
  };
}
