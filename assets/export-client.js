// 下载复用现有口令校验接口，口令仅放在请求头中，不写入 URL 或浏览器存储。
export async function verifyExportPassword(endpoint, password, { signal, fetcher = globalThis.fetch } = {}) {
  const url = new URL('/check', endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('口令校验服务需要使用 HTTPS');
  if (!password.trim()) throw new Error('请输入上传口令');
  const response = await fetcher(url.href, {
    method: 'POST', headers: { Authorization: `Bearer ${password.trim()}` }, signal,
    credentials: 'omit', redirect: 'error', cache: 'no-store',
  });
  const data = await response.json().catch(error => {
    if (error.name === 'AbortError') throw error;
    return null;
  });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(data?.error?.message || `口令校验失败（HTTP ${response.status}）`);
  if (data?.status !== 'readable') throw new Error('服务未确认口令，请稍后重试');
}

export function exportFilename(title, format) {
  if (!['pdf', 'pptx'].includes(format)) throw new Error('不支持的下载格式');
  const name = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 100) || '图集';
  return `${name}.${format}`;
}
