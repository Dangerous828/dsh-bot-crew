#!/usr/bin/env python3
"""探测层弱网台架：一个可控的「隧道那头」。

TailcatP2p.probe() 只做两件事 —— 向 127.0.0.1:<port> 发 GET，读超时由预算决定。
把「隧道那头」换成一个能挂住、能慢滴、能拒连的 HTTP 服务，就能在**不碰任何
系统网络/路由/防火墙/限速**的前提下，量 probe() 在真实超时下的行为。

明确边界：这里劣化的是 TCP 代理层。UDP 打洞失败（NAT 类型不匹配、端口预测失败、
DERP 中继退化）不是这一层能模拟的，本文件不声称等价，也不用于冒充 NAT 结论。

关键实现约束（踩过的坑）：
  probe() 用 `stream.readBytes()` 读正文 —— 它读到 **EOF** 才返回，不是读到
  Content-Length。所以每个响应都必须带 `Connection: close` 并在发完 body 后立刻关连接；
  否则台架自己的 keep-alive 会额外制造 5 秒延迟，把测量结果全部污染成假超时。

用法：probe_server.py <port> <mode> [--drip-ms N] [--delay-ms N]
mode: normal | hang | drip | delay
（「端口没人听」不需要服务器：runner 直接跳过启动。）
"""
import argparse
import socket
import threading
import time


def handle(conn, mode, drip_ms, delay_ms):
    try:
        conn.settimeout(30)
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                return
            buf += chunk
        path = buf.split(b' ')[1].decode('latin1') if b' ' in buf else '/'

        if mode == 'hang':
            # 收下请求，永不回。这就是「隧道那头不回」的真身。
            while True:
                time.sleep(0.5)
        if mode == 'delay':
            time.sleep(delay_ms / 1000.0)

        status = 200 if path.startswith('/api/mobile/timeline') else 404
        body = b'{"items":[]}' if status == 200 else b'{"error":"not found"}'
        head = ('HTTP/1.1 %d X\r\nContent-Length: %d\r\nContent-Type: application/json\r\n'
                'Connection: close\r\n\r\n' % (status, len(body))).encode()

        if mode == 'drip':
            # 一个字节一个字节地滴。readTimeout 是**每次 read** 的期限，每次滴都在刷新它 ——
            # 这条用例就是为了钉住「整轮预算是否真能封住墙钟」。
            for byte in head + body:
                time.sleep(drip_ms / 1000.0)
                conn.sendall(bytes([byte]))
            return

        conn.sendall(head + body)
    except OSError:
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('port', type=int)
    ap.add_argument('mode')
    ap.add_argument('--drip-ms', type=float, default=800.0)
    ap.add_argument('--delay-ms', type=float, default=30000.0)
    args = ap.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', args.port))
    server.listen(64)
    print('ready %s %d' % (args.mode, args.port), flush=True)
    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle, args=(conn, args.mode, args.drip_ms, args.delay_ms),
                         daemon=True).start()


if __name__ == '__main__':
    main()
