export function readingPage(rects, viewportHeight) {
  const visible = rects.filter(rect => rect.bottom > 0 && rect.top < viewportHeight * .35);
  return visible.sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0]?.index;
}

export function createScrollReader(stage, onSelect) {
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
      target.scrollIntoView({ block: 'start' });
      // Images without dimensions can move the target as they load. Load the
      // preceding pages before the final alignment, unless the user scrolls.
      const images = figures.slice(0, index + 1).map(figure => figure.querySelector('img'))
        .filter(img => !img.hasAttribute('width') || !img.hasAttribute('height'));
      images.forEach(img => { img.loading = 'eager'; });
      Promise.all(images.map(img => img.decode().catch(() => {}))).then(() => {
        if (disposed || current !== navigation) return;
        target.scrollIntoView({ block: 'start' });
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
