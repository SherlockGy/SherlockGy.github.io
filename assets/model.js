export const MAX_DESCRIPTION_LENGTH = 10000;

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function safeImageUrl(value, base = 'https://sherlockgy.github.io/') {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片地址不能为空');
  const url = new URL(value, base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.origin === new URL(base).origin)) {
    throw new Error('图片地址须使用 HTTPS 或站内路径');
  }
  if (url.username || url.password) throw new Error('图片地址不能包含凭据');
  return url.href;
}

export function normalizeManifest(data, base) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.albums)) throw new Error('图集目录格式不正确');
  const seriesIds = new Set(normalizeSeries(data).map(item => item.id));
  const ids = new Set();
  return data.albums.map(album => {
    if (!album || typeof album.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(album.id) || ids.has(album.id)) throw new Error('图集编号缺失、重复或格式不正确');
    ids.add(album.id);
    if (typeof album.title !== 'string' || !album.title.trim() || album.title.length > 120) throw new Error('图集名称须为 1–120 字');
    if (album.seriesId ? !seriesIds.has(album.seriesId) : !validDate(album.date)) throw new Error('图集需要有效的所属系列或归档日期');
    if (!Array.isArray(album.images) || !album.images.length) throw new Error('每个图集至少需要一张图片');
    return {
      id: album.id, title: album.title.trim(), date: album.date, seriesId: album.seriesId || '',
      description: typeof album.description === 'string' ? album.description : '',
      tags: Array.isArray(album.tags) ? album.tags.filter(tag => typeof tag === 'string') : [],
      images: album.images.map((image, index) => {
        const item = typeof image === 'string' ? { src: image } : image;
        if (!item || typeof item !== 'object') throw new Error('图片条目格式不正确');
        const prefix = `${album.title} · 第 `;
        const generatedAlt = typeof item.alt === 'string' && item.alt.startsWith(prefix) && /^[1-9]\d* 页$/.test(item.alt.slice(prefix.length));
        // Older manifests may retain a generated page label from before a reorder.
        // The array determines page order; custom image descriptions stay intact.
        return { src: safeImageUrl(item.src, base), alt: typeof item.alt === 'string' && !generatedAlt ? item.alt : `${album.title} · 第 ${index + 1} 页`,
          width: Number.isFinite(item.width) && item.width > 0 ? item.width : undefined,
          height: Number.isFinite(item.height) && item.height > 0 ? item.height : undefined,
          thumbnails: normalizeThumbnails(item.thumbnails, base) };
      }),
    };
  }).sort((a, b) => a.seriesId || b.seriesId
    ? Number(!!a.seriesId) - Number(!!b.seriesId)
    : b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

function normalizeThumbnails(value, base) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) throw new Error('缩略图格式不正确');
  const widths = new Set();
  return value.map(item => {
    if (!item || !Number.isInteger(item.width) || item.width <= 0 || !Number.isInteger(item.height) || item.height <= 0 || widths.has(item.width)) throw new Error('缩略图尺寸不正确');
    widths.add(item.width);
    return { src: safeImageUrl(item.src, base), width: item.width, height: item.height };
  }).sort((a, b) => a.width - b.width);
}

export function normalizeSeries(data) {
  const series = data.series ?? [];
  if (!Array.isArray(series) || series.length > 200) throw new Error('系列目录格式不正确，最多支持 200 个系列');
  const ids = new Set();
  const normalized = series.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) throw new Error('系列编号缺失或重复');
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120) throw new Error('系列名称须为 1–120 字');
    if (item.parentId != null && typeof item.parentId !== 'string') throw new Error('上级系列格式不正确');
    return { id: item.id, title: item.title.trim(), parentId: item.parentId || '' };
  });
  const parents = new Map(normalized.map(item => [item.id, item.parentId]));
  for (const item of normalized) {
    const visited = new Set([item.id]);
    for (let parent = item.parentId; parent; parent = parents.get(parent)) {
      if (!parents.has(parent) || visited.has(parent)) throw new Error('系列层级存在循环或上级系列不存在');
      visited.add(parent);
    }
  }
  return normalized;
}

export function seriesTrail(series, id) {
  const trail = [], visited = new Set();
  for (let item = series.find(entry => entry.id === id); item && !visited.has(item.id); item = series.find(entry => entry.id === item.parentId)) {
    visited.add(item.id); trail.unshift(item);
  }
  return trail;
}

export function flattenSeries(series, parentId = '', depth = 0) {
  return series.filter(item => item.parentId === parentId).flatMap(item => [
    { ...item, depth }, ...flattenSeries(series, item.id, depth + 1),
  ]);
}

export function groupByMonth(albums) {
  const groups = new Map();
  for (const album of albums) {
    if (album.seriesId) continue;
    const month = album.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(album);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a));
}

export function filterAlbums(albums, { query = '', month = '', type = 'all', view, seriesId = '' } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return albums.filter(album => (view === 'series' ? !!seriesId && album.seriesId === seriesId : view === 'archive' ? !album.seriesId : true) &&
    (!month || (!album.seriesId && album.date?.startsWith(month))) &&
    (type === 'all' || (type === 'single' ? album.images.length === 1 : album.images.length > 1)) &&
    terms.every(term => [album.title, album.description, ...album.tags].join(' ').toLocaleLowerCase().includes(term)));
}

export function validateFiles(files, config) {
  if (!files.length) throw new Error('请先选择至少一张图片');
  if (files.length > config.maxFiles) throw new Error(`每个图集最多 ${config.maxFiles} 张图片`);
  const types = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
  let total = 0;
  for (const file of files) {
    if (!types.has(file.type)) throw new Error(`不支持「${file.name}」，请选择 JPG、PNG、WebP、GIF 或 AVIF`);
    if (!file.size || file.size > config.maxFileBytes) throw new Error(`「${file.name}」为空或超过单张 ${config.maxFileBytes / 1048576} MB 限制`);
    total += file.size;
  }
  if (total > config.maxTotalBytes) throw new Error(`一个图集总大小不能超过 ${config.maxTotalBytes / 1048576} MB`);
}
