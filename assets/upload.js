// Shared by new albums and image edits. GitHub credentials stay in the Worker.
const MIB = 1024 * 1024;
const PROTOCOL = 'signed-blobs-v1';

// Limit both request count and the amount of image data being processed at once.
// Wait for active jobs after a failure so their receipts survive the next retry.
export async function runUploadQueue(files, upload, { concurrency = 2, maxBytes = 12 * MIB } = {}) {
  let next = 0, active = 0, bytes = 0, failure;
  return new Promise((resolve, reject) => {
    const pump = () => {
      if (!active && (failure || next === files.length)) { if (failure) reject(failure); else resolve(); return; }
      while (!failure && active < concurrency && next < files.length && (!active || bytes + files[next].size <= maxBytes)) {
        const index = next++, size = files[index].size;
        active++; bytes += size;
        Promise.resolve().then(() => upload(files[index], index)).catch(error => { failure ||= error; }).finally(() => {
          active--; bytes -= size; pump();
        });
      }
    };
    pump();
  });
}

export function createUploadClient({ fetch: fetcher = (...args) => globalThis.fetch(...args) } = {}) {
  let draft, capabilities;
  async function json(url, password, body, timeout = 75000) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', body,
        headers: password ? { Authorization: `Bearer ${password.trim()}` } : {}, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
      if (!response.ok) {
        const error = new Error((data?.error?.message || `请求失败（HTTP ${response.status}）`) +
          (data?.error?.traceId ? `（请求编号：${data.error.traceId}）` : ''));
        Object.assign(error, { status: response.status, code: data?.error?.code, retryAfterSeconds: data?.error?.retryAfterSeconds });
        throw error;
      }
      if (!data || typeof data !== 'object') throw Object.assign(new Error('服务返回内容不完整，请保留当前草稿'), { code: 'INVALID_RESPONSE' });
      return data;
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') throw Object.assign(new Error('等待服务超时，当前草稿已保留，请原样重试'), { code: 'NETWORK_TIMEOUT' });
      if (error instanceof TypeError) throw Object.assign(new Error('连接中断，当前草稿已保留，请原样重试'), { code: 'NETWORK_ERROR' });
      throw error;
    } finally { clearTimeout(timer); }
  }
  function committed(data) {
    return data?.status === 'committed' && typeof data.commitSha === 'string' && !!data.album;
  }
  async function status(endpoint, password, current) {
    const url = new URL('/uploads/status', endpoint);
    url.searchParams.set('requestId', current.id); url.searchParams.set('scope', current.scope);
    const data = await json(url, password);
    if (committed(data)) return data;
    if (data.status !== 'not_committed') throw Object.assign(new Error('无法确认保存结果，请保留草稿并重试'), { code: 'INVALID_RESPONSE' });
    return null;
  }
  async function save({ endpoint, password, body, onProgress = () => {} }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('上传服务地址需要配置为 HTTPS');
    if (!password?.trim()) throw new Error('请输入上传口令');
    const files = body.getAll('images'), id = body.get('requestId');
    // FormData can wrap the same File in a new object on each save. UI mutations
    // rotate requestId; metadata also guards accidental reuse by another caller.
    const description = JSON.stringify([[...body].filter(([key]) => key !== 'images'),
      files.map(file => [file.name, file.size, file.type, file.lastModified])]);
    if (!draft || draft.id !== id || draft.endpoint !== url.href || draft.description !== description) {
      draft = { id, endpoint: url.href, scope: url.pathname, description, files, receipts: new Map(), commitAttempted: false, retryAt: 0 };
    }
    const current = draft;
    if (current.retryAt > Date.now()) throw new Error(`服务暂时限流，请 ${Math.ceil((current.retryAt - Date.now()) / 1000)} 秒后原样重试`);
    if (!capabilities || capabilities.origin !== url.origin || capabilities.until < Date.now()) {
      onProgress('正在连接上传服务…');
      const health = await json(new URL('/health', url), undefined, undefined, 15000);
      capabilities = { origin: url.origin, until: Date.now() + 60000, upload: health.upload };
    }
    const options = capabilities.upload;
    if (options?.protocol !== PROTOCOL) {
      onProgress('正在上传并保存…');
      return json(url, password, body, 120000);
    }
    if (current.commitAttempted) {
      onProgress('正在确认上次保存结果…');
      const saved = await status(url, password, current);
      if (saved) return saved;
    }
    const ttl = Math.min(Number(options.receiptTtlMs) || 0, 24 * 60 * 60 * 1000);
    for (const [index, entry] of current.receipts) if (Date.now() - entry.createdAt >= ttl - 60000) current.receipts.delete(index);
    const pending = files.map((file, index) => ({ file, index, size: file.size })).filter(item => !current.receipts.has(item.index));
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const progress = () => {
      const doneBytes = [...current.receipts.keys()].reduce((sum, index) => sum + files[index].size, 0);
      onProgress(`图片已上传 ${current.receipts.size} / ${files.length} 张 · ${(doneBytes / MIB).toFixed(1)} / ${(totalBytes / MIB).toFixed(1)} MB`);
    };
    if (files.length) progress();
    try {
      const preparation = new FormData(); preparation.set('requestId', id); preparation.set('scope', current.scope);
      let prepareError;
      const prepare = json(new URL('/uploads/prepare', url), password, preparation).catch(error => { prepareError = error; throw error; });
      const transfer = runUploadQueue(pending, async ({ file, index }) => {
        if (prepareError) throw prepareError;
        const target = new URL(`/uploads/${id}/${index}`, url); target.searchParams.set('scope', current.scope);
        // Binary on the browser-to-Worker hop; encode only one image in each Worker request.
        const data = await json(target, password, file, 90000).catch(error => {
          if (error.status === 429 || error.retryAfterSeconds) current.retryAt = Date.now() + Math.max(60, Number(error.retryAfterSeconds) || 60) * 1000;
          throw error;
        });
        if (data.status !== 'staged' || typeof data.receipt?.data !== 'string' || typeof data.receipt?.signature !== 'string') {
          throw Object.assign(new Error(`第 ${index + 1} 张图片未返回保存凭据，请重试`), { code: 'INVALID_RESPONSE' });
        }
        current.receipts.set(index, { receipt: data.receipt, createdAt: Date.now() }); progress();
      }, { concurrency: Math.max(1, Math.min(3, Math.floor(Number(options.concurrency)) || 2)),
        maxBytes: Math.max(1, Math.min(12 * MIB, Number(options.maxInFlightBytes) || 12 * MIB)) });
      const [prepared, transferred] = await Promise.allSettled([prepare, transfer]);
      if (prepared.status === 'rejected') throw prepared.reason;
      if (transferred.status === 'rejected') throw transferred.reason;
      if (prepared.value.status !== 'prepared' || !prepared.value.snapshot) throw new Error('未取得仓库快照，请保留草稿重试');
      const metadata = new FormData();
      for (const [key, value] of body) if (key !== 'images') metadata.append(key, value);
      metadata.set('receipts', JSON.stringify(files.map((_, index) => current.receipts.get(index).receipt)));
      metadata.set('snapshot', JSON.stringify(prepared.value.snapshot));
      onProgress('图片已就绪，正在保存图集…');
      current.commitAttempted = true;
      try {
        const result = await json(url, password, metadata, 90000);
        if (!committed(result) && result.status !== 'unchanged') throw Object.assign(new Error('未收到完整保存结果，请保留草稿'), { code: 'INVALID_RESPONSE' });
        return result;
      } catch (error) {
        // A rejected signature (for example after a Worker secret rotation)
        // cannot become valid by resending the same receipt on every retry.
        if (['RECEIPT_EXPIRED', 'INVALID_RECEIPT'].includes(error.code)) current.receipts.clear();
        if (error.status && error.status < 500) throw error;
        onProgress('正在确认保存结果，请稍候…');
        // A timeout does not prove the branch update failed. Do not switch write paths.
        try { const saved = await status(url, password, current); if (saved) return saved; } catch { /* Preserve the original error and draft. */ }
        throw error;
      }
    } catch (error) {
      if (error.status === 429 || error.retryAfterSeconds) current.retryAt = Date.now() + Math.max(60, Number(error.retryAfterSeconds) || 60) * 1000;
      if (files.length && current.receipts.size < files.length) error.message += current.receipts.size
        ? `（已上传 ${current.receipts.size}/${files.length} 张，原样重试会复用；请勿刷新）`
        : '（当前图片和排序已保留，请原样重试；请勿刷新）';
      throw error;
    }
  }
  return { save, reset() { draft = undefined; } };
}
