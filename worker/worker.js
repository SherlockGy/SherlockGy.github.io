// Copy this entire file into Cloudflare's worker.js editor, then Deploy.
// Settings > Variables and Secrets: add GITHUB_TOKEN and UPLOAD_PASSWORD as Secrets.
// No npm packages, database, or storage bindings are required.

const REPOSITORY = 'SherlockGy/SherlockGy.github.io';
const BRANCH = 'master';
const ORIGIN = 'https://sherlockgy.github.io';
const MANIFEST = 'data/albums.json';
const VERSION = '2026-09-17-review-3';
const GITHUB_TIMEOUT_MS = 20000;
const MIB = 1024 * 1024;
const LIMITS = { files: 30, fileBytes: 10 * MIB, totalBytes: 30 * MIB, bodyBytes: 31 * MIB };
const encoder = new TextEncoder();
const attempts = new Map(); // Best-effort per-isolate throttling, not a global quota.
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_PROTOCOL = 'signed-blobs-v1';

class UploadError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}
class GitHubError extends Error {
  constructor(status, details = {}) { super('GitHub request failed'); this.status = status; this.details = details; }
}
function log(env, event, details = {}, error = false) {
  console[error ? 'error' : 'log']({ event, traceId: env._traceId, ...(env._requestId ? { requestId: env._requestId } : {}), ...(env._logPrefix ? { logPrefix: env._logPrefix } : {}), ...details });
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
function throttle(request, imageUpload = false) {
  const ip = `${imageUpload ? 'image:' : 'operation:'}${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
  const now = Date.now();
  if (attempts.size > 2000) for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
  if (attempts.size > 4000) fail(429, 'BUSY', '上传服务繁忙，请稍后重试');
  let entry = attempts.get(ip);
  if (!entry || entry.until < now) { entry = { count: 0, until: now + 60000 }; attempts.set(ip, entry); }
  if (++entry.count > (imageUpload ? 90 : 12)) fail(429, 'RATE_LIMITED', '操作过于频繁，请一分钟后重试');
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
    const response = await fetch(path === '/graphql' ? 'https://api.github.com/graphql' : `https://api.github.com/repos/${REPOSITORY}${path}`, {
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
      const retryAfter = Number(response.headers.get('Retry-After'));
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = Number(response.headers.get('X-RateLimit-Reset'));
      const rateLimited = httpStatus === 429 || (httpStatus === 403 && (retryAfter > 0 || remaining === '0'));
      const details = { stage, httpStatus, elapsedMs: Date.now() - started,
        ...(rateLimited ? { retryAfterSeconds: Math.max(60, retryAfter || 0, remaining === '0' ? Math.ceil(reset - Date.now() / 1000) || 0 : 0) } : {}) };
      await response.body?.cancel().catch(() => {});
      if ([301, 302, 303, 307, 308].includes(httpStatus)) {
        throw new UploadError(502, 'GITHUB_REDIRECT', `${stage}：GitHub 返回重定向（HTTP ${httpStatus}），已停止请求，请检查仓库地址是否变更`, details);
      }
      if (rateLimited) throw new UploadError(429, 'GITHUB_RATE_LIMITED', `${stage}：GitHub 暂时限流，请稍后原样重试`, details);
      throw new GitHubError(httpStatus, details);
    }
    let result;
    try {
      result = raw || path === '/graphql'
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
  if (env.GITHUB_READ_MODE !== 'rest') {
    const [owner, name] = REPOSITORY.split('/');
    const result = await github(env, '/graphql', { method: 'POST', stage: '读取仓库快照', body: {
      query: `query AtlasSnapshot($owner: String!, $name: String!, $ref: String!, $path: String!) {
        repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { ... on Commit {
          oid tree { oid } file(path: $path) { object { ... on Blob { text isTruncated } } }
        } } } }
      }`, variables: { owner, name, ref: `refs/heads/${BRANCH}`, path: MANIFEST },
    } });
    if (result.errors?.length) fail(502, 'GITHUB_GRAPHQL_ERROR', '读取仓库快照失败，请检查 GitHub 权限；可设置 GITHUB_READ_MODE=rest 使用兼容读取');
    const commit = result.data?.repository?.ref?.target, blob = commit?.file?.object;
    if (!commit?.oid || !commit.tree?.oid || blob?.isTruncated || typeof blob?.text !== 'string') fail(502, 'GITHUB_INVALID_RESPONSE', '仓库快照不完整，已停止写入；可设置 GITHUB_READ_MODE=rest 使用兼容读取');
    let manifest;
    try { manifest = JSON.parse(blob.text); } catch { fail(500, 'INVALID_MANIFEST', '仓库图集目录格式不正确，已停止写入'); }
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.albums)) fail(500, 'INVALID_MANIFEST', '仓库图集目录格式不正确，已停止写入');
    return { sha: commit.oid, tree: commit.tree.oid, manifest };
  }
  const ref = await github(env, `/git/ref/heads/${BRANCH}`);
  const [commit, manifest] = await Promise.all([
    github(env, `/git/commits/${ref.object.sha}`),
    github(env, `/contents/${MANIFEST}?ref=${ref.object.sha}`, { raw: true }),
  ]);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.albums)) fail(500, 'INVALID_MANIFEST', '仓库图集目录格式不正确，已停止写入');
  return { sha: ref.object.sha, tree: commit.tree.sha, manifest };
}
function existingAlbum(snapshot, id, fingerprint) {
  const album = snapshot.manifest.albums.find(item => item.id === id);
  if (!album) return null;
  if (album.uploadFingerprint !== fingerprint) fail(409, 'REQUEST_REUSED', '同一个请求编号包含不同内容，请重新新建图集');
  return { status: 'committed', commitSha: snapshot.sha, album };
}
async function readUploadForm(request) {
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
  return form;
}
function uploadRequestId(form) {
  const requestId = field(form, 'requestId', 36, true).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) fail(400, 'INVALID_REQUEST_ID', '请求编号格式不正确');
  return requestId;
}
async function inspectFiles(form, allowEmpty = false) {
  const files = form.getAll('images');
  if ((!allowEmpty && !files.length) || files.length > LIMITS.files) fail(400, 'FILE_COUNT', '每个图集需要 1–30 张图片');
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
  return { files, info };
}
function validRequestId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function uploadScope(value) {
  if (value !== '/albums' && !/^\/albums\/[a-zA-Z0-9_-]{1,100}$/.test(value || '')) fail(400, 'INVALID_SCOPE', '图片上传目标格式不正确');
  return value;
}
async function receiptKey(env) {
  // Uploaders know UPLOAD_PASSWORD; signing must also depend on a server-only secret.
  return crypto.subtle.importKey('raw', encoder.encode(`atlas-upload-receipt-v1\n${REPOSITORY}\n${env.GITHUB_TOKEN.trim()}\n${env.UPLOAD_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signReceipt(env, payload) {
  const data = JSON.stringify(payload);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await receiptKey(env), encoder.encode(data)));
  return { data, signature: Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('') };
}
async function prepareUpload(request, env) {
  const form = await readUploadForm(request);
  const requestId = uploadRequestId(form), scope = uploadScope(field(form, 'scope', 120, true));
  env._requestId = requestId;
  const head = await readHead(env);
  // A signed snapshot can cross Worker isolates without KV or an unsafe client manifest.
  return { status: 'prepared', snapshot: await signReceipt(env, {
    protocol: 'atlas-snapshot-v1', requestId, scope, expiresAt: Date.now() + 5 * 60000, head,
  }) };
}
async function preparedHead(form, env, scope) {
  if (!form.has('snapshot')) return readHead(env);
  let receipt, payload;
  try { receipt = JSON.parse(field(form, 'snapshot', 6 * MIB, true)); }
  catch (error) { if (error instanceof UploadError) throw error; fail(400, 'INVALID_SNAPSHOT', '仓库快照格式不正确，请重试'); }
  if (typeof receipt?.data !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.signature || '')) fail(400, 'INVALID_SNAPSHOT', '仓库快照凭据不正确，请重试');
  const signature = Uint8Array.from(receipt.signature.match(/../g), byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', await receiptKey(env), signature, encoder.encode(receipt.data))) fail(400, 'INVALID_SNAPSHOT', '仓库快照校验失败，请重试');
  try { payload = JSON.parse(receipt.data); } catch { fail(400, 'INVALID_SNAPSHOT', '仓库快照格式不正确，请重试'); }
  if (payload.protocol !== 'atlas-snapshot-v1' || payload.scope !== scope || payload.requestId !== uploadRequestId(form)) fail(400, 'INVALID_SNAPSHOT', '仓库快照与当前草稿不匹配');
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) return readHead(env);
  return payload.head;
}
async function verifyReceipt(env, receipt, requestId, scope, index) {
  if (!receipt || typeof receipt.data !== 'string' || receipt.data.length > 2000 || !/^[a-f0-9]{64}$/.test(receipt.signature || '')) fail(400, 'INVALID_RECEIPT', '图片凭据格式不正确，请重新上传该图片');
  const signature = Uint8Array.from(receipt.signature.match(/../g), byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', await receiptKey(env), signature, encoder.encode(receipt.data))) fail(400, 'INVALID_RECEIPT', '图片凭据校验失败，请重新上传');
  let item;
  try { item = JSON.parse(receipt.data); } catch { fail(400, 'INVALID_RECEIPT', '图片凭据格式不正确'); }
  if (item.protocol !== UPLOAD_PROTOCOL || item.requestId !== requestId || item.scope !== scope || item.index !== index ||
      !/^[a-f0-9]{40}$/.test(item.sha || '') || !/^[a-f0-9]{64}$/.test(item.hash || '') ||
      !['png', 'jpg', 'webp', 'gif', 'avif'].includes(item.extension) ||
      !Number.isInteger(item.size) || item.size <= 0 || item.size > LIMITS.fileBytes) fail(400, 'INVALID_RECEIPT', '图片凭据与当前草稿不匹配，请重新上传');
  if (!Number.isFinite(item.expiresAt) || item.expiresAt <= Date.now()) fail(409, 'RECEIPT_EXPIRED', '图片上传凭据已过期，请原样重试以重新上传');
  return item;
}
async function uploadImage(request, env, requestId, index) {
  if (!validRequestId(requestId) || !Number.isInteger(index) || index < 0 || index >= LIMITS.files) fail(400, 'INVALID_REQUEST_ID', '图片上传编号不正确');
  const scope = uploadScope(new URL(request.url).searchParams.get('scope'));
  env._requestId = requestId;
  if (!request.body) fail(400, 'INVALID_FILE', '图片为空');
  if (Number(request.headers.get('Content-Length')) > LIMITS.fileBytes) fail(413, 'TOO_LARGE', '单张图片最多 10 MB');
  const bytes = new Uint8Array(await new Response(limitedStream(request.body, LIMITS.fileBytes)).arrayBuffer());
  const extension = imageType(bytes.subarray(0, 64));
  if (!extension) fail(400, 'INVALID_FILE', '仅支持真实的 JPG、PNG、WebP、GIF 或 AVIF 图片');
  const item = { protocol: UPLOAD_PROTOCOL, requestId, scope, index, size: bytes.length, extension, hash: await hash(bytes), expiresAt: Date.now() + RECEIPT_TTL_MS };
  if (extension === 'png' || extension === 'gif') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    item.width = extension === 'png' ? view.getUint32(16) : view.getUint16(6, true);
    item.height = extension === 'png' ? view.getUint32(20) : view.getUint16(8, true);
    if (!item.width || !item.height) fail(400, 'INVALID_FILE', '图片宽高不正确');
  }
  const blob = await github(env, '/git/blobs', { method: 'POST', stage: `保存第 ${index + 1} 张图片`, body: { content: base64(bytes), encoding: 'base64' } });
  if (!/^[a-f0-9]{40}$/.test(blob?.sha || '')) fail(502, 'GITHUB_INVALID_RESPONSE', 'GitHub 未返回有效图片凭据');
  item.sha = blob.sha;
  log(env, 'image.staged', { index, bytes: bytes.length });
  return { status: 'staged', receipt: await signReceipt(env, item) };
}
async function preparedFiles(form, env, scope, allowEmpty = false) {
  if (!form.has('receipts')) return inspectFiles(form, allowEmpty);
  if (form.has('images')) fail(400, 'INVALID_RECEIPT', '不能混合图片文件与上传凭据');
  let receipts;
  try { receipts = JSON.parse(field(form, 'receipts', 100000, true)); }
  catch (error) { if (error instanceof UploadError) throw error; fail(400, 'INVALID_RECEIPT', '图片凭据格式不正确'); }
  if (!Array.isArray(receipts) || (!allowEmpty && !receipts.length) || receipts.length > LIMITS.files) fail(400, 'FILE_COUNT', '每个图集需要 1–30 张图片');
  const requestId = uploadRequestId(form), info = [];
  let total = 0;
  for (let index = 0; index < receipts.length; index++) {
    const item = await verifyReceipt(env, receipts[index], requestId, scope, index);
    if ((total += item.size) > LIMITS.totalBytes) fail(413, 'TOO_LARGE', '单次图片总大小不能超过 30 MB');
    info.push(item);
  }
  // Existing commit construction is shared by legacy files and staged images.
  return { files: Array(info.length).fill(null), info };
}
async function uploadStatus(request, env) {
  const params = new URL(request.url).searchParams;
  const requestId = params.get('requestId'), scope = uploadScope(params.get('scope'));
  if (!validRequestId(requestId)) fail(400, 'INVALID_REQUEST_ID', '请求编号格式不正确');
  const snapshot = await readHead(env);
  const album = snapshot.manifest.albums.find(item => item.id === (scope === '/albums' ? `album-${requestId}` : scope.slice('/albums/'.length)));
  const found = scope === '/albums' ? !!album : album?.editHistory?.some(item => item.requestId === requestId);
  return found ? { status: 'committed', commitSha: snapshot.sha, album } : { status: 'not_committed' };
}
async function upload(request, env) {
  const form = await readUploadForm(request);
  const title = field(form, 'title', 120, true);
  const seriesId = field(form, 'seriesId', 100);
  const date = seriesId ? '' : field(form, 'date', 10, true);
  const description = field(form, 'description', 1000);
  const requestId = uploadRequestId(form);
  env._requestId = requestId;
  if (!seriesId && !validDate(date)) fail(400, 'INVALID_DATE', '请选择有效的归档日期');
  if (seriesId && !/^[a-zA-Z0-9_-]{1,100}$/.test(seriesId)) fail(400, 'INVALID_SERIES', '所属系列格式不正确');
  const { files, info } = await preparedFiles(form, env, '/albums');
  // Preserve fingerprints of existing monthly drafts for safe retries across upgrades.
  const fingerprint = await hash(encoder.encode(JSON.stringify([title, date, description, info.map(item => item.hash), ...(seriesId ? [seriesId] : [])])));
  const id = `album-${requestId}`;
  const directory = imageDirectory({ id, date, seriesId });
  let snapshot = await preparedHead(form, env, '/albums');
  const existing = existingAlbum(snapshot, id, fingerprint);
  if (existing) return existing;
  if (seriesId && !(snapshot.manifest.series || []).some(item => item.id === seriesId)) fail(400, 'INVALID_SERIES', '所属系列不存在，请重新载入目录');
  const album = { id, title, ...(seriesId ? { seriesId } : { date }), description, tags: [], uploadFingerprint: fingerprint, images: [] };
  const imageEntries = [];
  // Sequential binary uploads bound memory and outbound connections.
  for (let index = 0; index < files.length; index++) {
    let sha = info[index].sha;
    if (!sha) {
      const bytes = new Uint8Array(await files[index].arrayBuffer());
      sha = (await github(env, '/git/blobs', { method: 'POST', stage: `保存第 ${index + 1}/${files.length} 张图片`, body: { content: base64(bytes), encoding: 'base64' } })).sha;
    }
    const path = `${directory}/${String(index + 1).padStart(3, '0')}.${info[index].extension}`;
    imageEntries.push({ path, mode: '100644', type: 'blob', sha });
    const image = { src: `./${path}`, alt: `${title} · 第 ${index + 1} 页` };
    if (info[index].width) { image.width = info[index].width; image.height = info[index].height; }
    album.images.push(image);
  }
  // At most 48 GitHub subrequests for 30 images and two conflict retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) snapshot = await readHead(env);
    const duplicate = existingAlbum(snapshot, id, fingerprint);
    if (duplicate) return duplicate;
    if (seriesId && !(snapshot.manifest.series || []).some(item => item.id === seriesId)) fail(409, 'INVALID_SERIES', '所属系列已变更，请重新载入目录');
    const manifest = { ...snapshot.manifest, albums: seriesId ? [...snapshot.manifest.albums, album] : [album, ...snapshot.manifest.albums] };
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

function editableAlbum(snapshot, id) {
  const album = snapshot.manifest.albums.find(item => item.id === id);
  if (!album) fail(404, 'ALBUM_NOT_FOUND', '图集不存在，请刷新首页检查');
  if ((album.seriesId ? !(snapshot.manifest.series || []).some(item => item.id === album.seriesId) : !validDate(album.date)) || !Array.isArray(album.images) || !album.images.length ||
      album.images.some(image => typeof image !== 'string' && (!image || typeof image.src !== 'string'))) {
    fail(500, 'INVALID_MANIFEST', '图集内容格式不正确，已停止编辑');
  }
  return album;
}
function imageDirectory(album) {
  return album.seriesId ? `images/series/${album.id}` : `images/${album.date.slice(0, 4)}/${album.date.slice(5, 7)}/${album.id}`;
}
function generatedImageAlt(alt, title) {
  const prefix = `${title} · 第 `;
  // Reordering previously preserved labels, so their page number may differ from today's index.
  return typeof alt === 'string' && alt.startsWith(prefix) && /^[1-9]\d* 页$/.test(alt.slice(prefix.length));
}
async function albumRevision(album) {
  return hash(encoder.encode(JSON.stringify(album)));
}
function validateOrder(order, album, fileCount) {
  if (!Array.isArray(order) || !order.length || order.length > LIMITS.files) fail(400, 'FILE_COUNT', '编辑后的图集需要 1–30 张图片');
  const originals = new Set(), uploads = new Set();
  for (const entry of order) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(400, 'INVALID_ORDER', '图片顺序格式不正确');
    const hasFile = Object.hasOwn(entry, 'file');
    const hasExisting = Object.hasOwn(entry, 'existing');
    const hasReplacement = Object.hasOwn(entry, 'replaces');
    const allowed = hasFile ? ['file', 'replaces'] : ['existing'];
    if (Object.keys(entry).some(key => !allowed.includes(key)) || (!hasFile && !hasExisting)) fail(400, 'INVALID_ORDER', '图片条目格式不正确');
    if (hasFile) {
      if (!Number.isInteger(entry.file) || entry.file < 0 || entry.file >= fileCount || uploads.has(entry.file)) fail(400, 'INVALID_ORDER', '上传图片编号缺失或重复');
      uploads.add(entry.file);
    }
    if (hasExisting || hasReplacement) {
      const index = hasExisting ? entry.existing : entry.replaces;
      if (!Number.isInteger(index) || index < 0 || index >= album.images.length || originals.has(index)) fail(400, 'INVALID_ORDER', '原图片编号缺失或重复');
      originals.add(index);
    }
  }
  if (originals.size !== album.images.length || uploads.size !== fileCount) fail(400, 'INVALID_ORDER', '每张原图必须保留或替换，新增图片必须全部使用');
}
async function editAlbum(request, env, id) {
  const logPrefix = `[editAlbum 编辑图集][albumId=${id}]`;
  env = { ...env, _logPrefix: logPrefix };
  log(env, 'edit.start');
  const form = await readUploadForm(request);
  const requestId = uploadRequestId(form);
  env._requestId = requestId;
  const revision = field(form, 'revision', 64, true);
  if (!/^[a-f0-9]{64}$/.test(revision)) fail(400, 'INVALID_REVISION', '图集版本格式不正确');
  const title = form.has('title') ? field(form, 'title', 120, true) : undefined;
  const description = form.has('description') ? field(form, 'description', 1000) : undefined;
  let order;
  try { order = JSON.parse(field(form, 'order', 10000, true)); }
  catch (error) { if (error instanceof UploadError) throw error; fail(400, 'INVALID_ORDER', '图片顺序格式不正确'); }
  const { files, info } = await preparedFiles(form, env, `/albums/${id}`, true);
  const fingerprintParts = [id, revision, order, info.map(item => item.hash)];
  // Omitted fields keep existing fingerprints compatible across Worker upgrades.
  if (title !== undefined) fingerprintParts.push({ title });
  if (description !== undefined) fingerprintParts.push({ description });
  const fingerprint = await hash(encoder.encode(JSON.stringify(fingerprintParts)));
  let snapshot = await preparedHead(form, env, `/albums/${id}`);
  const inspectSnapshot = async () => {
    const album = editableAlbum(snapshot, id);
    const receipt = (album.editHistory || []).find(item => item.requestId === requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail(409, 'REQUEST_REUSED', '同一个请求编号包含不同内容，请重新载入图集');
      return { album, duplicate: true };
    }
    if (await albumRevision(album) !== revision) fail(409, 'ALBUM_CHANGED', '图集已有新的变更。当前草稿已保留，请重新载入最新图集后再编辑');
    validateOrder(order, album, files.length);
    return { album, duplicate: false };
  };
  let checked = await inspectSnapshot();
  if (checked.duplicate) return { status: 'committed', commitSha: snapshot.sha, album: checked.album };
  if (!files.length && order.every((entry, index) => entry.existing === index) &&
      (title === undefined || title === checked.album.title) &&
      (description === undefined || description === (checked.album.description || ''))) {
    return { status: 'unchanged', album: checked.album };
  }
  const imageEntries = [], newImages = [];
  const directory = imageDirectory(checked.album);
  for (let index = 0; index < files.length; index++) {
    let sha = info[index].sha;
    if (!sha) {
      const bytes = new Uint8Array(await files[index].arrayBuffer());
      sha = (await github(env, '/git/blobs', { method: 'POST', stage: `保存第 ${index + 1}/${files.length} 张新图片`, body: { content: base64(bytes), encoding: 'base64' } })).sha;
    }
    // New paths keep old images intact and avoid stale cached replacements.
    const path = `${directory}/${requestId}-${String(index + 1).padStart(3, '0')}.${info[index].extension}`;
    imageEntries.push({ path, mode: '100644', type: 'blob', sha });
    newImages.push({ src: `./${path}`, ...(info[index].width ? { width: info[index].width, height: info[index].height } : {}) });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) { snapshot = await readHead(env); checked = await inspectSnapshot(); }
    if (checked.duplicate) return { status: 'committed', commitSha: snapshot.sha, album: checked.album };
    const nextTitle = title ?? checked.album.title;
    const album = { ...checked.album, title: nextTitle,
      ...(description === undefined ? {} : { description }),
      images: order.map((entry, index) => {
        if (Object.hasOwn(entry, 'existing')) {
          const image = checked.album.images[entry.existing];
          // Generated labels follow both the saved order and the current title.
          // Keep custom descriptions and original image paths unchanged.
          return generatedImageAlt(image?.alt, checked.album.title)
            ? { ...image, alt: `${nextTitle} · 第 ${index + 1} 页` } : image;
        }
        const original = checked.album.images[entry.replaces];
        const customAlt = original?.alt && !generatedImageAlt(original.alt, checked.album.title);
        return { ...newImages[entry.file], alt: customAlt ? original.alt : `${nextTitle} · 第 ${index + 1} 页` };
      }),
      editHistory: [...(checked.album.editHistory || []).slice(-49), { requestId, fingerprint }],
    };
    const manifest = { ...snapshot.manifest, albums: snapshot.manifest.albums.map(item => item.id === id ? album : item) };
    const tree = await github(env, '/git/trees', { method: 'POST', body: { base_tree: snapshot.tree,
      tree: [...imageEntries, { path: MANIFEST, mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 2) + '\n' }] } });
    const commit = await github(env, '/git/commits', { method: 'POST', body: {
      message: `feat: 更新图集 ${nextTitle.replace(/[\r\n]/g, ' ')}`, tree: tree.sha, parents: [snapshot.sha],
    } });
    try {
      await github(env, `/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      log(env, 'edit.success', { commitSha: commit.sha, imageCount: album.images.length });
      return { status: 'committed', commitSha: commit.sha, album };
    } catch (error) {
      if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
    }
  }
  fail(409, 'CONFLICT', '仓库正在更新，当前草稿已保留，请重试保存');
}

function libraryStructure(manifest) {
  return { series: manifest.series || [], placements: manifest.albums.map(album => ({
    id: album.id, seriesId: album.seriesId || '', date: album.date || '',
  })) };
}
async function libraryRevision(manifest) {
  return hash(encoder.encode(JSON.stringify(libraryStructure(manifest))));
}
function validateLibrary(series, placements, manifest) {
  if (!Array.isArray(series) || series.length > 200 || !Array.isArray(placements)) fail(400, 'INVALID_LIBRARY', '目录格式不正确，最多支持 200 个系列');
  const ids = new Set();
  const normalized = series.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id) ||
        typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 120 ||
        (item.parentId != null && typeof item.parentId !== 'string')) fail(400, 'INVALID_SERIES', '系列编号、名称或上级系列格式不正确');
    ids.add(item.id);
    return { id: item.id, title: item.title.trim(), parentId: item.parentId || '' };
  });
  if ((manifest.series || []).some(item => !ids.has(item.id))) fail(400, 'INVALID_SERIES', '已有系列必须保留，可调整名称、层级和顺序');
  const parents = new Map(normalized.map(item => [item.id, item.parentId]));
  for (const item of normalized) {
    const visited = new Set([item.id]);
    for (let parent = item.parentId; parent; parent = parents.get(parent)) {
      if (!parents.has(parent) || visited.has(parent)) fail(400, 'INVALID_SERIES', '系列不能放入自身或下级系列，上级系列必须存在');
      visited.add(parent);
    }
  }
  const albums = new Map(manifest.albums.map(album => [album.id, album])), seen = new Set();
  const nextAlbums = placements.map(item => {
    if (!item || !albums.has(item.id) || seen.has(item.id) || typeof item.seriesId !== 'string' ||
        (item.seriesId ? !ids.has(item.seriesId) : !validDate(item.date))) fail(400, 'INVALID_PLACEMENT', '图集归属、日期或顺序格式不正确');
    seen.add(item.id);
    const album = { ...albums.get(item.id) };
    if (item.seriesId) {
      album.seriesId = item.seriesId;
      // Existing dates are retained only for a later move back to the archive.
    } else {
      delete album.seriesId; album.date = item.date;
    }
    return album;
  });
  if (seen.size !== albums.size) fail(400, 'INVALID_PLACEMENT', '目录必须保留每个已有图集');
  return { series: normalized, albums: nextAlbums };
}
async function editLibrary(request, env) {
  const logPrefix = `[editLibrary 整理系列目录][traceId=${env._traceId}]`;
  env = { ...env, _logPrefix: logPrefix };
  log(env, 'library.start');
  const form = await readUploadForm(request);
  const requestId = uploadRequestId(form), revision = field(form, 'revision', 64, true);
  if (!/^[a-f0-9]{64}$/.test(revision)) fail(400, 'INVALID_REVISION', '目录版本格式不正确');
  let series, placements;
  try { series = JSON.parse(field(form, 'series', 100000, true)); placements = JSON.parse(field(form, 'placements', 1000000, true)); }
  catch (error) { if (error instanceof UploadError) throw error; fail(400, 'INVALID_LIBRARY', '目录格式不正确'); }
  if (form.getAll('images').length) fail(400, 'INVALID_LIBRARY', '整理目录不需要上传图片');
  const fingerprint = await hash(encoder.encode(JSON.stringify([revision, series, placements])));
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readHead(env);
    const receipt = (snapshot.manifest.libraryHistory || []).find(item => item.requestId === requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail(409, 'REQUEST_REUSED', '同一个请求编号包含不同内容，请重新载入目录');
      return { status: 'committed', commitSha: snapshot.sha, manifest: snapshot.manifest };
    }
    if (await libraryRevision(snapshot.manifest) !== revision) fail(409, 'LIBRARY_CHANGED', '目录已有新的变更。当前草稿已保留，请重新载入后再整理');
    const next = validateLibrary(series, placements, snapshot.manifest);
    const manifest = { ...snapshot.manifest, ...next };
    if (await libraryRevision(manifest) === revision) return { status: 'unchanged', manifest };
    manifest.libraryHistory = [...(snapshot.manifest.libraryHistory || []).slice(-49), { requestId, fingerprint }];
    const tree = await github(env, '/git/trees', { method: 'POST', body: { base_tree: snapshot.tree,
      tree: [{ path: MANIFEST, mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 2) + '\n' }] } });
    const commit = await github(env, '/git/commits', { method: 'POST', body: {
      message: 'feat: 整理系列层级和图集顺序', tree: tree.sha, parents: [snapshot.sha],
    } });
    try {
      await github(env, `/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      log(env, 'library.success', { commitSha: commit.sha, seriesCount: next.series.length });
      return { status: 'committed', commitSha: commit.sha, manifest };
    } catch (error) {
      if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
    }
  }
  fail(409, 'CONFLICT', '仓库正在更新，当前草稿已保留，请重试保存');
}

export default {
  async fetch(request, env) {
    env = { ...env, _traceId: crypto.randomUUID() };
    const started = Date.now();
    try {
      const path = new URL(request.url).pathname;
      const albumMatch = path.match(/^\/albums\/([a-zA-Z0-9_-]{1,100})$/);
      const imageMatch = path.match(/^\/uploads\/([a-f0-9-]{36})\/(\d{1,2})$/);
      const isUploadStatus = path === '/uploads/status';
      const isPrepare = path === '/uploads/prepare';
      if (albumMatch) env._logPrefix = `[${request.method === 'GET' ? 'readAlbum 读取图集' : 'editAlbum 编辑图集'}][albumId=${albumMatch[1]}]`;
      const isLibrary = path === '/library';
      if (isLibrary) env._logPrefix = `[${request.method === 'GET' ? 'readLibrary 读取系列目录' : 'editLibrary 整理系列目录'}][traceId=${env._traceId}]`;
      const origin = request.headers.get('Origin');
      if (origin && origin !== ORIGIN) fail(403, 'ORIGIN_DENIED', '请从你的图集网站发起上传');
      if (!albumMatch && !imageMatch && !isUploadStatus && !isPrepare && !isLibrary && !['/', '/albums', '/health', '/check'].includes(path)) fail(404, 'NOT_FOUND', '接口不存在');
      if (request.method === 'OPTIONS') return reply(request, null, 204);
      if (request.method === 'GET' && ['/', '/albums', '/health', '/check'].includes(path)) return reply(request, { service: 'SherlockGy Atlas Upload', version: VERSION,
        ready: !!(env.GITHUB_TOKEN && typeof env.UPLOAD_PASSWORD === 'string' && env.UPLOAD_PASSWORD.length >= 8),
        message: '请在图集网站中上传图片。', endpoint: '/albums', capabilities: { editTitle: true, editDescription: true }, upload: { protocol: UPLOAD_PROTOCOL,
          concurrency: ['1', '2', '3'].includes(String(env.UPLOAD_CONCURRENCY)) ? Number(env.UPLOAD_CONCURRENCY) : 2,
          maxInFlightBytes: 12 * MIB, receiptTtlMs: RECEIPT_TTL_MS } });
      if ((request.method !== 'POST' && !((albumMatch || isLibrary || isUploadStatus) && request.method === 'GET')) || path === '/health' || (isUploadStatus && request.method !== 'GET')) fail(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
      if (!env.GITHUB_TOKEN || typeof env.UPLOAD_PASSWORD !== 'string' || env.UPLOAD_PASSWORD.length < 8) fail(503, 'NOT_CONFIGURED', '请先在 Cloudflare 添加 GITHUB_TOKEN 和至少 8 位的 UPLOAD_PASSWORD Secret');
      throttle(request, !!imageMatch);
      const authorization = request.headers.get('Authorization') || '';
      if (authorization.length > 1024 || !authorization.startsWith('Bearer ') || !await passwordMatches(authorization.slice(7), env.UPLOAD_PASSWORD)) fail(401, 'UNAUTHORIZED', '上传口令不正确');
      log(env, 'request.start', { path, method: request.method });
      if (imageMatch) return reply(request, await uploadImage(request, env, imageMatch[1], Number(imageMatch[2])), 201);
      if (isUploadStatus) return reply(request, await uploadStatus(request, env));
      if (isPrepare) return reply(request, await prepareUpload(request, env));
      if (isLibrary) {
        if (request.method === 'GET') {
          const { manifest } = await readHead(env);
          return reply(request, { manifest, revision: await libraryRevision(manifest) });
        }
        return reply(request, await editLibrary(request, env));
      }
      if (albumMatch) {
        if (request.method === 'GET') {
          const snapshot = await readHead(env), album = editableAlbum(snapshot, albumMatch[1]);
          return reply(request, { album, series: snapshot.manifest.series || [], revision: await albumRevision(album), capabilities: { editTitle: true, editDescription: true } });
        }
        const result = await editAlbum(request, env, albumMatch[1]);
        return reply(request, result);
      }
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
