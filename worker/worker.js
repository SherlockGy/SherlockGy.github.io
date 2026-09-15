// Copy this entire file into Cloudflare's worker.js editor, then Deploy.
// Settings > Variables and Secrets: add GITHUB_TOKEN and UPLOAD_PASSWORD as Secrets.
// No npm packages, database, or storage bindings are required.

const REPOSITORY = 'SherlockGy/SherlockGy.github.io';
const BRANCH = 'master';
const ORIGIN = 'https://sherlockgy.github.io';
const MANIFEST = 'data/albums.json';
const VERSION = '2026-09-15-diagnostics-2';
const GITHUB_TIMEOUT_MS = 20000;
const MIB = 1024 * 1024;
const LIMITS = { files: 30, fileBytes: 10 * MIB, totalBytes: 30 * MIB, bodyBytes: 31 * MIB };
const encoder = new TextEncoder();
const attempts = new Map(); // Best-effort per-isolate throttling, not a global quota.

class UploadError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}
class GitHubError extends Error {
  constructor(status, details = {}) { super('GitHub request failed'); this.status = status; this.details = details; }
}
function log(env, event, details = {}, error = false) {
  console[error ? 'error' : 'log']({ event, traceId: env._traceId, ...details });
}
function safeReason(error, env) {
  let message = String(error?.message || 'Unknown error');
  for (const value of [env.GITHUB_TOKEN, env.GITHUB_TOKEN?.trim(), env.UPLOAD_PASSWORD]) {
    if (typeof value === 'string' && value) message = message.split(value).join('[REDACTED]');
  }
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]').replace(/[\r\n\t]/g, ' ').slice(0, 250);
}
function githubStage(path, method) {
  if (path.startsWith('/git/ref/')) return '读取主分支';
  if (path.startsWith('/git/commits/')) return '读取当前提交';
  if (path.startsWith('/contents/')) return '读取图集目录';
  if (path === '/git/blobs') return '保存图片';
  if (path === '/git/trees') return '保存目录变更';
  if (path === '/git/commits') return '创建提交';
  if (method === 'PATCH') return '发布图集';
  return '访问 GitHub';
}
function fail(status, code, message) { throw new UploadError(status, code, message); }
function reply(request, data, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin' });
  if (request.headers.get('Origin') === ORIGIN) {
    headers.set('Access-Control-Allow-Origin', ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}
async function hash(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
async function passwordMatches(input, expected) {
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function throttle(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  if (attempts.size > 2000) for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
  if (attempts.size > 4000) fail(429, 'BUSY', '上传服务繁忙，请稍后重试');
  let entry = attempts.get(ip);
  if (!entry || entry.until < now) { entry = { count: 0, until: now + 60000 }; attempts.set(ip, entry); }
  if (++entry.count > 12) fail(429, 'RATE_LIMITED', '操作过于频繁，请一分钟后重试');
}
async function github(env, path, { method = 'GET', body, raw = false, stage = githubStage(path, method) } = {}) {
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!token || /[^\x21-\x7e]/.test(token)) {
    throw new UploadError(503, 'GITHUB_TOKEN_FORMAT', 'GITHUB_TOKEN 含空格、换行或非英文字符，请重新粘贴完整 Token 到 Secret', { stage });
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  let httpStatus;
  log(env, 'github.start', { stage, method, path: path.split('?')[0] });
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'SherlockGy-Atlas-Worker',
        'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Some Workers runtimes reject 'error'; inspect redirects without following them.
      redirect: 'manual', signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      const details = { stage, httpStatus, elapsedMs: Date.now() - started };
      await response.body?.cancel().catch(() => {});
      if ([301, 302, 303, 307, 308].includes(httpStatus)) {
        throw new UploadError(502, 'GITHUB_REDIRECT', `${stage}：GitHub 返回重定向（HTTP ${httpStatus}），已停止请求，请检查仓库地址是否变更`, details);
      }
      throw new GitHubError(httpStatus, details);
    }
    let result;
    try {
      result = raw
        ? await new Response(limitedStream(response.body, 5 * MIB)).json()
        : await response.json();
    } catch (error) {
      if (controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
      if (error?.name === 'SyntaxError' || error instanceof UploadError) {
        throw new UploadError(502, 'GITHUB_INVALID_RESPONSE', `${stage}：GitHub 返回内容格式不正确或超过大小限制`, { stage, httpStatus });
      }
      throw error;
    }
    log(env, 'github.success', { stage, httpStatus, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    const details = { stage, elapsedMs: Date.now() - started, ...(httpStatus ? { httpStatus } : {}) };
    if (error instanceof GitHubError || error instanceof UploadError) {
      log(env, 'github.error', { ...details, code: error.code || 'GITHUB_HTTP_ERROR' }, true);
      throw error;
    }
    const timedOut = controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name);
    const reason = safeReason(error, env);
    log(env, 'github.error', { ...details, errorName: error?.name || 'Error', reason, timedOut }, true);
    throw new UploadError(timedOut ? 504 : 502, timedOut ? 'GITHUB_TIMEOUT' : 'GITHUB_CONNECTION_ERROR',
      timedOut ? `${stage}：GitHub 请求超时（上限 ${GITHUB_TIMEOUT_MS / 1000} 秒），请保留当前图片并重试`
        : `${stage}：GitHub 请求异常：${reason}。请保留当前图片`,
      { ...details, errorName: error?.name || 'Error', ...(timedOut ? { timeoutMs: GITHUB_TIMEOUT_MS } : { reason }) });
  } finally {
    clearTimeout(timer);
  }
}
function limitedStream(stream, limit) {
  let size = 0;
  return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
    size += chunk.byteLength;
    if (size > limit) { controller.error(new UploadError(413, 'TOO_LARGE', '上传内容超过大小限制')); return; }
    controller.enqueue(chunk);
  } }));
}
function field(form, name, max, required = false) {
  const values = form.getAll(name);
  if (values.length > 1 || values.some(value => typeof value !== 'string')) fail(400, 'INVALID_FIELD', `${name} 字段格式不正确`);
  const value = (values[0] || '').trim();
  if ((required && !value) || value.length > max) fail(400, 'INVALID_FIELD', `${name} 为空或过长`);
  return value;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function imageType(bytes) {
  const starts = values => values.every((value, i) => bytes[i] === value);
  const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && text(12, 4) === 'IHDR') return 'png';
  if (bytes.length >= 12 && starts([255, 216, 255])) return 'jpg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'gif';
  if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 4))) return 'webp';
  if (bytes.length >= 24 && text(4, 4) === 'ftyp') {
    const end = Math.min(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), bytes.length);
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      if (offset !== 12 && ['avif', 'avis'].includes(text(offset, 4))) return 'avif';
    }
  }
  return null;
}
function base64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
async function readHead(env) {
  const ref = await github(env, `/git/ref/heads/${BRANCH}`);
  const commit = await github(env, `/git/commits/${ref.object.sha}`);
  const manifest = await github(env, `/contents/${MANIFEST}?ref=${ref.object.sha}`, { raw: true });
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.albums)) fail(500, 'INVALID_MANIFEST', '仓库图集目录格式不正确，已停止写入');
  return { sha: ref.object.sha, tree: commit.tree.sha, manifest };
}
function existingAlbum(snapshot, id, fingerprint) {
  const album = snapshot.manifest.albums.find(item => item.id === id);
  if (!album) return null;
  if (album.uploadFingerprint !== fingerprint) fail(409, 'REQUEST_REUSED', '同一个请求编号包含不同内容，请重新新建图集');
  return { status: 'committed', commitSha: snapshot.sha, album };
}
async function upload(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) fail(415, 'EXPECTED_FORM', '请从图集网站选择图片上传');
  if (Number(request.headers.get('Content-Length')) > LIMITS.bodyBytes) fail(413, 'TOO_LARGE', '单次图片总大小不能超过 30 MB');
  if (!request.body) fail(400, 'EMPTY_BODY', '未收到上传内容');
  let form;
  try {
    form = await new Response(limitedStream(request.body, LIMITS.bodyBytes), { headers: { 'Content-Type': contentType } }).formData();
  } catch (error) {
    if (error instanceof UploadError) throw error;
    fail(400, 'INVALID_FORM', '无法读取图片，请检查文件大小后重试');
  }
  const title = field(form, 'title', 120, true);
  const date = field(form, 'date', 10, true);
  const description = field(form, 'description', 1000);
  const requestId = field(form, 'requestId', 36, true).toLowerCase();
  if (!validDate(date)) fail(400, 'INVALID_DATE', '请选择有效的归档日期');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) fail(400, 'INVALID_REQUEST_ID', '请求编号格式不正确');
  const files = form.getAll('images');
  if (!files.length || files.length > LIMITS.files) fail(400, 'FILE_COUNT', '每个图集需要 1–30 张图片');
  let total = 0;
  const info = [];
  for (const file of files) {
    if (typeof file === 'string' || typeof file?.arrayBuffer !== 'function' || file.size === 0) fail(400, 'INVALID_FILE', '图片为空或格式不正确');
    if (file.size > LIMITS.fileBytes || (total += file.size) > LIMITS.totalBytes) fail(413, 'TOO_LARGE', '单张最多 10 MB，单次合计最多 30 MB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extension = imageType(bytes.subarray(0, 64));
    if (!extension) fail(400, 'INVALID_FILE', '仅支持真实的 JPG、PNG、WebP、GIF 或 AVIF 图片，不接受 SVG 或 HTML');
    const item = { extension, hash: await hash(bytes) };
    if (extension === 'png' || extension === 'gif') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      item.width = extension === 'png' ? view.getUint32(16) : view.getUint16(6, true);
      item.height = extension === 'png' ? view.getUint32(20) : view.getUint16(8, true);
      if (!item.width || !item.height) fail(400, 'INVALID_FILE', '图片宽高不正确');
    }
    info.push(item);
  }
  const fingerprint = await hash(encoder.encode(JSON.stringify([title, date, description, info.map(item => item.hash)])));
  const id = `album-${requestId}`;
  const directory = `images/${date.slice(0, 4)}/${date.slice(5, 7)}/${id}`;
  let snapshot = await readHead(env);
  const existing = existingAlbum(snapshot, id, fingerprint);
  if (existing) return existing;
  const album = { id, title, date, description, tags: [], uploadFingerprint: fingerprint, images: [] };
  const imageEntries = [];
  // Sequential binary uploads bound memory and outbound connections.
  for (let index = 0; index < files.length; index++) {
    const bytes = new Uint8Array(await files[index].arrayBuffer());
    const blob = await github(env, '/git/blobs', { method: 'POST', stage: `保存第 ${index + 1}/${files.length} 张图片`, body: { content: base64(bytes), encoding: 'base64' } });
    const path = `${directory}/${String(index + 1).padStart(3, '0')}.${info[index].extension}`;
    imageEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    const image = { src: `./${path}`, alt: `${title} · 第 ${index + 1} 页` };
    if (info[index].width) { image.width = info[index].width; image.height = info[index].height; }
    album.images.push(image);
  }
  // At most 48 GitHub subrequests for 30 images and two conflict retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) snapshot = await readHead(env);
    const duplicate = existingAlbum(snapshot, id, fingerprint);
    if (duplicate) return duplicate;
    const manifest = { ...snapshot.manifest, albums: [album, ...snapshot.manifest.albums] };
    const tree = await github(env, '/git/trees', { method: 'POST', body: { base_tree: snapshot.tree,
      tree: [...imageEntries, { path: MANIFEST, mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 2) + '\n' }] } });
    const commit = await github(env, '/git/commits', { method: 'POST', body: {
      message: `Add album: ${title.replace(/[\r\n]/g, ' ')}`, tree: tree.sha, parents: [snapshot.sha],
    } });
    try {
      await github(env, `/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      return { status: 'committed', commitSha: commit.sha, album };
    } catch (error) {
      if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
    }
  }
  fail(409, 'CONFLICT', '图集目录正在更新，请保留当前图片并重试');
}

export default {
  async fetch(request, env) {
    env = { ...env, _traceId: crypto.randomUUID() };
    const started = Date.now();
    try {
      const path = new URL(request.url).pathname;
      const origin = request.headers.get('Origin');
      if (origin && origin !== ORIGIN) fail(403, 'ORIGIN_DENIED', '请从你的图集网站发起上传');
      if (!['/', '/albums', '/health', '/check'].includes(path)) fail(404, 'NOT_FOUND', '接口不存在');
      if (request.method === 'OPTIONS') return reply(request, null, 204);
      if (request.method === 'GET') return reply(request, { service: 'SherlockGy Atlas Upload', version: VERSION,
        ready: !!(env.GITHUB_TOKEN && typeof env.UPLOAD_PASSWORD === 'string' && env.UPLOAD_PASSWORD.length >= 8),
        message: '请在图集网站中上传图片。', endpoint: '/albums' });
      if (request.method !== 'POST' || path === '/health') fail(405, 'METHOD_NOT_ALLOWED', '请使用 POST /albums');
      if (!env.GITHUB_TOKEN || typeof env.UPLOAD_PASSWORD !== 'string' || env.UPLOAD_PASSWORD.length < 8) fail(503, 'NOT_CONFIGURED', '请先在 Cloudflare 添加 GITHUB_TOKEN 和至少 8 位的 UPLOAD_PASSWORD Secret');
      throttle(request);
      const authorization = request.headers.get('Authorization') || '';
      if (authorization.length > 1024 || !authorization.startsWith('Bearer ') || !await passwordMatches(authorization.slice(7), env.UPLOAD_PASSWORD)) fail(401, 'UNAUTHORIZED', '上传口令不正确');
      log(env, 'request.start', { path, method: request.method });
      if (path === '/check') {
        const snapshot = await readHead(env);
        log(env, 'check.success', { elapsedMs: Date.now() - started });
        return reply(request, { status: 'readable', version: VERSION, traceId: env._traceId,
          elapsedMs: Date.now() - started, albumCount: snapshot.manifest.albums.length,
          message: 'GitHub 连接和图集目录读取正常。写入权限仍需通过实际上传验证。' });
      }
      const result = await upload(request, env);
      log(env, 'upload.success', { elapsedMs: Date.now() - started, commitSha: result.commitSha });
      return reply(request, result, 201);
    } catch (error) {
      log(env, 'request.error', { elapsedMs: Date.now() - started, code: error.code || (error instanceof GitHubError ? 'GITHUB_HTTP_ERROR' : 'INTERNAL_ERROR'), ...(error.details || {}) }, true);
      if (error instanceof UploadError) return reply(request, { error: { code: error.code, message: error.message, ...error.details, traceId: env._traceId } }, error.status);
      if (error instanceof GitHubError) {
        const message = [401, 403].includes(error.status) ? 'GitHub Token 无效、权限不足或请求受到限制，请检查 Worker 的 Secret 和仓库 Contents 写权限'
          : error.status === 404 ? 'GitHub 无法访问指定仓库、分支或目录，请检查 Token 的仓库授权'
          : 'GitHub 暂时无法保存，请保留当前图片后重试';
        return reply(request, { error: { code: 'GITHUB_ERROR', message: `${error.details.stage}：${message}（HTTP ${error.status}）`, ...error.details, traceId: env._traceId } }, 502);
      }
      return reply(request, { error: { code: 'INTERNAL_ERROR', message: '上传未能完成，请保留当前图片后重试' } }, 500);
    }
  },
};
