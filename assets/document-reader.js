// Cropping only changes presentation. All pages retain one shared horizontal
// scale and their original source; sparse pages are never enlarged separately.
export function documentGeometry(image, bounds, availableWidth, scale = 1) {
  const [left, top, right, bottom] = bounds;
  const width = Math.max(1, Math.min(availableWidth, 820 * scale));
  const imageWidth = width / (right - left);
  const imageHeight = imageWidth * (image.height || 2400) / (image.width || 1697);
  return { width, height: imageHeight * (bottom - top), imageWidth, imageHeight,
    x: -left * imageWidth, y: -top * imageHeight };
}
export function readDocumentProgress(storage, id) {
  try {
    const value = JSON.parse(storage.getItem(`document-reader:${id}`));
    if (!value || !Number.isInteger(value.page) || value.page < 0) return null;
    return { page: value.page, offset: Math.max(-1, Math.min(1, Number(value.offset) || 0)),
      scale: Math.max(.7, Math.min(1.5, Number(value.scale) || 1)) };
  } catch { return null; }
}
