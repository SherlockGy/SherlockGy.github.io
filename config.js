// Public configuration only. Never put a GitHub token in this file.
export default Object.freeze({
  manifestUrl: './data/albums.json',
  uploadEndpoint: 'https://github-image-upload.sherlockjgy.workers.dev/albums',
  maxFiles: 60,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 600 * 1024 * 1024,
});
