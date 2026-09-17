// Width hints follow the existing archive/series grids. The browser selects one variant.
function coverSizes(series) {
  return `(max-width: 360px) calc(100vw - 52px), (max-width: 540px) calc(100vw - 64px), ` +
    `(max-width: 760px) calc((100vw - 102px) / 2), ` +
    `(max-width: 1180px) calc((100vw - ${series ? 336 : 438}px) / 2), ` +
    `(min-width: 1800px) ${series ? 453 : 419}px, calc((100vw - ${series ? 408 : 510}px) / 2)`;
}

export function configureCoverImage(img, image, { eager = false, priority = false, series = false, sizes, onError = () => {} } = {}) {
  const variants = image.thumbnails || [];
  let original = !variants.length;
  img.alt = image.alt || '';
  img.loading = eager ? 'eager' : 'lazy';
  img.decoding = 'async';
  img.fetchPriority = priority ? 'high' : 'auto';
  const dimensions = variants[0] || image;
  if (dimensions.width && dimensions.height) { img.width = dimensions.width; img.height = dimensions.height; }
  img.addEventListener('error', () => {
    if (!original) {
      original = true;
      img.removeAttribute('srcset'); img.removeAttribute('sizes');
      img.src = image.src;
    } else onError();
  });
  if (variants.length) {
    img.sizes = sizes || coverSizes(series);
    img.srcset = variants.map(item => `${item.src.replaceAll(',', '%2C')} ${item.width}w`).join(', ');
  }
  // Configure loading and responsive candidates before setting src to avoid a full-size request.
  img.src = variants[0]?.src || image.src;
  return img;
}
