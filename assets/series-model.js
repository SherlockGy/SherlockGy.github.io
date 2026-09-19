import { normalizeSeries } from './model.js?v=20260919-description-1';

// Apply one visible action to the latest directory, preserving unrelated entries.
export function applySeriesAction(manifest, action) {
  let series = normalizeSeries(manifest);
  let placements = manifest.albums.map(album => ({ id: album.id, seriesId: album.seriesId || '', date: album.date || '' }));
  const conflict = () => { throw new Error('这部分目录已有变化，请刷新页面后重新操作。'); };
  const findSeries = id => {
    const item = series.find(entry => entry.id === id);
    if (!item) conflict();
    return item;
  };
  const title = value => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('系列名称须为 1–120 字');
    return value.trim();
  };
  const parent = id => { if (id) findSeries(id); };
  const reorder = (items, matches, expected, order) => {
    // A group left untouched in the dialog keeps its latest contents and order.
    if (JSON.stringify(order) === JSON.stringify(expected)) return items;
    const current = items.filter(matches).map(item => item.id);
    if (JSON.stringify(current) !== JSON.stringify(expected)) conflict();
    if (!Array.isArray(order) || order.length !== current.length || new Set(order).size !== current.length || order.some(id => !current.includes(id))) {
      throw new Error('排序必须保留当前层级的全部条目。');
    }
    const byId = new Map(items.map(item => [item.id, item]));
    let index = 0;
    return items.map(item => matches(item) ? byId.get(order[index++]) : item);
  };
  switch (action.type) {
    case 'create':
      parent(action.parentId);
      if (series.some(item => item.id === action.id)) conflict();
      series.push({ id: action.id, title: title(action.title), parentId: action.parentId });
      break;
    case 'rename': {
      const item = findSeries(action.id);
      if (item.title !== action.previousTitle) conflict();
      item.title = title(action.title);
      break;
    }
    case 'move-series': {
      const item = findSeries(action.id);
      if (item.parentId !== action.previousParentId) conflict();
      parent(action.parentId);
      if (item.parentId !== action.parentId) {
        item.parentId = action.parentId;
        series = [...series.filter(entry => entry.id !== item.id), item];
      }
      break;
    }
    case 'move-album': {
      const item = placements.find(entry => entry.id === action.id);
      if (!item || !item.seriesId || !action.seriesId) throw new Error('月份图集与系列图集不能互相移动。');
      if (item.seriesId !== action.previousSeriesId) conflict();
      findSeries(action.seriesId);
      if (item.seriesId !== action.seriesId) {
        item.seriesId = action.seriesId;
        placements = [...placements.filter(entry => entry.id !== item.id), item];
      }
      break;
    }
    case 'reorder':
      parent(action.parentId);
      series = reorder(series, item => item.parentId === action.parentId, action.previousSeriesIds, action.seriesIds);
      // An empty series id is the series homepage, never the month archive.
      placements = reorder(placements, item => !!action.parentId && item.seriesId === action.parentId, action.previousAlbumIds, action.albumIds);
      break;
    default:
      throw new Error('不支持的系列操作。');
  }
  normalizeSeries({ series });
  return { series, placements };
}
