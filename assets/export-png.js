// 旋转与动画元数据需要先落实为静态像素，确保导出画面与阅读时方向一致。
export function pngNeedsNormalization(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (size > bytes.length - offset - 12) return true;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (['eXIf', 'acTL'].includes(type)) return true;
    if (type === 'IEND') return false;
    offset += size + 12;
  }
  return true;
}

// 常见的无透明 RGB PNG 可直接复用压缩数据，避免生成 PDF 时再次压缩整张原图。
export function pngPdfStream(bytes) {
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  if (bytes[24] !== 8 || bytes[25] !== 2 || bytes[26] || bytes[27] || bytes[28]) return null;
  const width = view.getUint32(16), height = view.getUint32(20), chunks = [];
  if (!width || !height) return null;
  let total = 0, ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (size > bytes.length - offset - 12) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    // 透明、旋转或动态图片仍交由通用图片处理流程处理。
    if (['tRNS', 'eXIf', 'acTL'].includes(type)) return null;
    if (type === 'IDAT') { chunks.push(bytes.subarray(offset + 8, offset + 8 + size)); total += size; }
    if (type === 'IEND') { ended = true; break; }
    offset += size + 12;
  }
  if (!ended || !total) return null;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return { width, height, data };
}
