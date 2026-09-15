// Public configuration only. Never put a GitHub token in this file.
export default Object.freeze({
  manifestUrl: './data/albums.json',
  uploadEndpoint: '', // Example: https://your-worker.workers.dev/albums
  maxFiles: 30,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
});
