# -*- coding: utf-8 -*-
"""本地静态服务器（强制无缓存）—— 前端页面专用启动方式

用法: python serve.py [端口，默认 8000]

为什么必须无缓存：
  web/ 是 ES Module 结构，浏览器对不带 Cache-Control 的响应会做启发式缓存，
  导致修改 JS 后浏览器仍加载旧文件（典型症状：图表空白、按 F12 才显示）。
  本服务器对每个响应附加 Cache-Control: no-store，保证每次刷新都拿到最新代码。
"""
import json
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# 持仓台账（唯一事实来源：cache/持仓.json；前端 POST /api/holdings 落盘）
HOLDINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', '持仓.json')
MAX_HOLDINGS_BYTES = 256 * 1024
TRADE_KEYS = ('id', 'code', 'kind', 'side', 'date', 'price', 'qty', 'fee')


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
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
        if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('trades'), list):
            self.send_error(400, 'Bad Structure')
            return
        for t in data['trades']:
            if not isinstance(t, dict) or not all(k in t for k in TRADE_KEYS):
                self.send_error(400, 'Bad Trade')
                return
        os.makedirs(os.path.dirname(HOLDINGS_PATH), exist_ok=True)
        tmp = HOLDINGS_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, HOLDINGS_PATH)
        resp = json.dumps({'ok': True, 'n': len(data['trades'])}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"红利研究终端静态服务: http://localhost:{port}/web/index.html  (Ctrl+C 退出)")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
