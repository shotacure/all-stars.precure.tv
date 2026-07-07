/**********************************************
 * テスト用静的サーバー
 * - ../site/ を配信
 * - fixtures/ にあるファイルは site/ より優先して配信する
 *   （leaderboard.json は本番では S3 にのみ存在するため、
 *    テストデータをリポジトリの site/ に置かずに済ませる）
 **********************************************/
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE_ROOT = path.join(__dirname, '..', 'site');
const FIXTURES = path.join(__dirname, 'fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function start(port = 8765) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (p === '/') p = '/index.html';

    const fixture = path.join(FIXTURES, p);
    const file = fs.existsSync(fixture) ? fixture : path.join(SITE_ROOT, p);

    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { start };
