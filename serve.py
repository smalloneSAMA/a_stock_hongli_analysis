# -*- coding: utf-8 -*-
"""本地静态服务器（强制无缓存）—— 前端页面专用启动方式

用法: python serve.py [端口，默认 8000]

为什么必须无缓存：
  web/ 是 ES Module 结构，浏览器对不带 Cache-Control 的响应会做启发式缓存，
  导致修改 JS 后浏览器仍加载旧文件（典型症状：图表空白、按 F12 才显示）。
  本服务器对每个响应附加 Cache-Control: no-store，保证每次刷新都拿到最新代码。
"""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve %s] %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"红利研究终端静态服务: http://localhost:{port}/web/index.html  (Ctrl+C 退出)")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
