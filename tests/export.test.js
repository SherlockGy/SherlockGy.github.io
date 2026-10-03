import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyExportPassword, exportFilename } from '../assets/export-client.js';
import { pngPdfStream, pngNeedsNormalization } from '../assets/export-png.js';
import { inflateSync } from 'node:zlib';

test('下载口令仅通过现有校验接口的请求头传递', async () => {
  const controller = new AbortController();
  await verifyExportPassword('https://example.test/albums', ' test-password ', {
    signal: controller.signal,
    fetcher: async (url, options) => {
      assert.equal(url, 'https://example.test/check');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { Authorization: 'Bearer test-password' });
      assert.equal(options.signal, controller.signal);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      return Response.json({ status: 'readable' });
    },
  });
});

test('错误口令、伪成功或非 JSON 响应都不能通过校验', async () => {
  for (const response of [
    Response.json({ error: { message: '上传口令不正确' } }, { status: 401 }),
    Response.json({ status: 'ok' }),
    new Response('<html>登录页</html>'),
    Response.json({ error: { message: '操作过于频繁' } }, { status: 429 }),
  ]) {
    await assert.rejects(verifyExportPassword('https://example.test/albums', 'test-password', { fetcher: async () => response }));
  }
});

test('口令为空、服务地址不安全时不发送请求，取消信号原样传递', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; };
  for (const [url, password] of [['http://example.test', 'test'], ['https://user:secret@example.test', 'test'], ['https://example.test', '  ']]) {
    await assert.rejects(verifyExportPassword(url, password, { fetcher }));
  }
  assert.equal(requests, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyExportPassword('https://example.test', 'test', {
    signal: controller.signal, fetcher: async (url, options) => options.signal.throwIfAborted(),
  }), { name: 'AbortError' });
});

test('文件名保留中文，移除路径与控制字符，并固定正确扩展名', () => {
  assert.equal(exportFilename('大班期初家长会', 'pdf'), '大班期初家长会.pdf');
  assert.equal(exportFilename('../图集:测试\n', 'pptx'), '.._图集_测试_.pptx');
  assert.equal(exportFilename(' ... ', 'pdf'), '图集.pdf');
  assert.throws(() => exportFilename('图集', 'html'));
});

test('响应正文读取中超时仍报告取消，迟到的成功响应不能通过校验', async () => {
  await assert.rejects(verifyExportPassword('https://example.test', 'test', {
    fetcher: async () => ({ ok: true, json: async () => { throw new DOMException('超时', 'AbortError'); } }),
  }), { name: 'AbortError' });
  const controller = new AbortController();
  await assert.rejects(verifyExportPassword('https://example.test', 'test', {
    signal: controller.signal,
    fetcher: async () => { controller.abort(); return Response.json({ status: 'readable' }); },
  }), { name: 'AbortError' });
});

test('PNG 快速导出保持原始压缩像素，拒绝透明、交错或损坏数据', () => {
  // 固定的 3×2 RGB 图片，避免图集内容更新影响导出算法测试。
  const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGOUL73IAAZMEIqBgQEAGKQBaab1GvIAAAAASUVORK5CYII=', 'base64'));
  const png = pngPdfStream(bytes);
  assert.ok(png);
  assert.equal(pngNeedsNormalization(bytes), false);
  assert.equal(inflateSync(png.data).length, png.height * (png.width * 3 + 1));
  for (const [offset, value] of [[24, 16], [25, 6], [28, 1], [0, 0]]) {
    const unsupported = bytes.slice(); unsupported[offset] = value;
    assert.equal(pngPdfStream(unsupported), null);
  }
  assert.equal(pngPdfStream(bytes.subarray(0, bytes.length - 10)), null);
  assert.equal(pngPdfStream(new Uint8Array(12)), null);
  for (const type of ['eXIf', 'acTL']) {
    // 元数据检测仅检查块类型，像素有效性由浏览器解码器验证。
    const chunk = new Uint8Array(12); chunk.set(Buffer.from(type), 4);
    const tagged = new Uint8Array(bytes.length + 12);
    tagged.set(bytes.subarray(0, 33)); tagged.set(chunk, 33); tagged.set(bytes.subarray(33), 45);
    assert.equal(pngNeedsNormalization(tagged), true);
    assert.equal(pngPdfStream(tagged), null);
  }
});
