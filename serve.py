# -*- coding: utf-8 -*-
"""本地静态服务器（强制无缓存）—— 前端页面专用启动方式

用法: python serve.py [端口，默认 8000]

为什么必须无缓存：
  web/ 是 ES Module 结构，浏览器对不带 Cache-Control 的响应会做启发式缓存，
  导致修改 JS 后浏览器仍加载旧文件（典型症状：图表空白、按 F12 才显示）。
  本服务器对每个响应附加 Cache-Control: no-store，保证每次刷新都拿到最新代码。
"""
import gzip
import io
import json
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# 持仓台账（唯一事实来源：cache/持仓.json；前端 POST /api/holdings 落盘）
# v2 结构 {version:2, portfolios:[{id,name,preset,trades:[...]}]}（多持仓页）；v1 {version:1,trades:[...]} 仍兜底接受
HOLDINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', '持仓.json')
MAX_HOLDINGS_BYTES = 512 * 1024
TRADE_KEYS = ('id', 'code', 'kind', 'side', 'date', 'price', 'qty', 'fee')


def _check_trade(t):
    return isinstance(t, dict) and all(k in t for k in TRADE_KEYS)


def _check_holdings(data):
    """校验台账结构：v2 多持仓页 / v1 单台账（兜底）。返回 (ok, 交易总数)"""
    if not isinstance(data, dict):
        return False, 0
    v = data.get('version')
    if v == 1:
        trades = data.get('trades')
        if not isinstance(trades, list) or not all(_check_trade(t) for t in trades):
            return False, 0
        return True, len(trades)
    if v == 2:
        ps = data.get('portfolios')
        if not isinstance(ps, list) or not ps:
            return False, 0
        n = 0
        for p in ps:
            if (not isinstance(p, dict) or not isinstance(p.get('id'), str)
                    or not isinstance(p.get('name'), str) or not isinstance(p.get('trades'), list)
                    or not all(_check_trade(t) for t in p['trades'])):
                return False, 0
            n += len(p['trades'])
        return True, n
    return False, 0


class NoCacheHandler(SimpleHTTPRequestHandler):
    GZIP_EXT = ('.json', '.js', '.css')   # 仅文本类压缩（图片/字体等二进制无收益）
    GZIP_MIN = 1024                       # >1KB 才压，避免小文件压完反而变大
    DATA_PREFIX = ('/cache/', '/web/data/')   # 数据文件：no-cache + ETag（可缓存，但每次校验）
    # 代码/页面仍 no-store：改了 JS 必须立刻生效（serve.py 存在的初衷）

    def _cache_control(self):
        if self.path.split('?')[0].startswith(self.DATA_PREFIX):
            return 'no-cache'
        return 'no-store, no-cache, must-revalidate'

    def send_head(self):
        """标准 send_head + gzip + ETag/304：
        · 文本类(.json/.js/.css)且 ≥1KB 且客户端接受 gzip → 压缩，按压缩后长度改写 Content-Length
        · /cache、/web/data 下的数据文件 → 返回 ETag；命中 If-None-Match 直接 304（无响应体）
        目录/索引/错误响应仍交回标准实现（保留目录列表与 404）。"""
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        try:
            st = os.stat(path)
            with open(path, 'rb') as f:
                raw = f.read()
        except OSError:
            return super().send_head()
        is_data = self.path.split('?')[0].startswith(self.DATA_PREFIX)
        compressible = path.lower().endswith(self.GZIP_EXT)
        use_gz = (compressible and len(raw) >= self.GZIP_MIN
                  and 'gzip' in (self.headers.get('Accept-Encoding') or ''))
        # ETag 由 mtime+size 派生（重生成即变）；带编码后缀，避免同一 ETag 对应两种表示
        etag = '"%x-%x%s"' % (int(st.st_mtime), st.st_size, '-gz' if use_gz else '')
        if is_data:
            inm = (self.headers.get('If-None-Match') or '').strip()
            if inm and inm in (etag, '*'):
                self.send_response(304)
                self.send_header('ETag', etag)
                self.end_headers()
                return None                      # 304 不带响应体
        body = gzip.compress(raw, 6) if use_gz else raw
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(len(body)))
        if is_data:
            self.send_header('ETag', etag)
        if compressible:
            self.send_header('Vary', 'Accept-Encoding')
        if use_gz:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        return io.BytesIO(body)

    def end_headers(self):
        self.send_header("Cache-Control", self._cache_control())
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve %s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_POST(self):
        """仅接受 POST /api/holdings：JSON 结构校验 + 大小上限 + 原子写 cache/持仓.json"""
        if self.path.split('?')[0].rstrip('/') != '/api/holdings':
            self.send_error(404, 'Not Found')
            return
        try:
            length = int(self.headers.get('Content-Length') or '0')
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_HOLDINGS_BYTES:
            self.send_error(413, 'Payload Too Large')
            return
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode('utf-8'))
        except Exception:
            self.send_error(400, 'Invalid JSON')
            return
        ok, n = _check_holdings(data)
        if not ok:
            self.send_error(400, 'Bad Structure')
            return
        os.makedirs(os.path.dirname(HOLDINGS_PATH), exist_ok=True)
        tmp = HOLDINGS_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, HOLDINGS_PATH)
        resp = json.dumps({'ok': True, 'n': n}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"红利研究终端静态服务: http://localhost:{port}/web/index.html  (Ctrl+C 退出)")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()