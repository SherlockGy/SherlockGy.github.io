function loadImage(src, priority, createImage) {
  const image = createImage();
  const entry = { image, ready: false, cancelled: false };
  image.loading = 'eager'; image.decoding = 'async'; image.fetchPriority = priority;
  image.src = src;
  entry.promise = image.decode().then(() => {
    if (entry.cancelled) return false;
    entry.ready = true; return true;
  }, () => false);
  return entry;
}

// Keep decoded originals only for the current page, the next two, and one back.
// A single background request runs after the selected image is ready.
export function createImagePreloader(createImage = () => new Image()) {
  const cache = new Map();
  let selected = null, background = null, queue = [], generation = 0;

  function load(src, priority) {
    const cached = cache.get(src);
    if (cached) { cached.image.fetchPriority = priority; return cached; }
    const entry = loadImage(src, priority, createImage);
    cache.set(src, entry);
    entry.promise.then(loaded => {
      if (!loaded && cache.get(src) === entry) cache.delete(src);
    });
    return entry;
  }

  function discard(src, entry) {
    entry.cancelled = true;
    if (!entry.ready) entry.image.removeAttribute('src');
    if (background === entry) background = null;
    cache.delete(src);
  }

  function warm() {
    if (background || !selected?.ready) return;
    while (queue.length) {
      const src = queue.shift();
      if (cache.has(src)) continue;
      const entry = load(src, 'low');
      background = entry;
      entry.promise.then(() => {
        if (background !== entry) return;
        background = null; warm();
      });
      break;
    }
  }

  return {
    select(images, page) {
      const current = ++generation;
      const src = images[page].src;
      queue = [...new Set([page + 1, page + 2, page - 1].map(index => images[index]?.src).filter(url => url && url !== src))];
      const wanted = new Set([src, ...queue]);
      for (const [url, entry] of cache) if (!wanted.has(url)) discard(url, entry);
      selected = load(src, 'high');
      // An in-flight preload becomes the foreground request without restarting.
      if (background === selected) background = null;
      if (selected.ready) warm();
      else selected.promise.then(() => { if (current === generation) warm(); });
      return selected;
    },
    clear() {
      generation++; selected = null; queue = [];
      for (const [src, entry] of cache) discard(src, entry);
    },
  };
}

// Continuous reading keeps fixed page frames, mounting only five nearby
// originals. Index keys allow the same URL to appear in more than one frame.
export function createImageWindow(images, mount, createImage = () => new Image()) {
  const active = new Map();
  let current = -1;

  function add(index) {
    const entry = loadImage(images[index].src, index === current ? 'high' : 'low', createImage);
    const dispose = mount(index, entry);
    active.set(index, { entry, dispose });
  }
  function remove(index) {
    const item = active.get(index);
    item.entry.cancelled = true;
    item.dispose();
    item.entry.image.removeAttribute('src');
    active.delete(index);
  }
  return {
    select(page) {
      current = page;
      const wanted = [page, page + 1, page - 1, page + 2, page - 2].filter(index => index >= 0 && index < images.length);
      for (const index of active.keys()) if (!wanted.includes(index)) remove(index);
      for (const index of wanted) {
        if (!active.has(index)) add(index);
        else active.get(index).entry.image.fetchPriority = index === page ? 'high' : 'low';
      }
    },
    retry(index) {
      if (!active.has(index)) return;
      remove(index); add(index);
    },
    clear() {
      for (const index of active.keys()) remove(index);
    },
  };
}
