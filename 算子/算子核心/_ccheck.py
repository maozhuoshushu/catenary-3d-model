# -*- coding: utf-8 -*-
"""`c`（颜色）哈希不稳的定量定案  _ccheck.py

背景：`verify_migration.py` 两次运行里，副本 A 的 `c` 哈希不同（`bcd542ba` → `16affaba`），
      而 `p/n/i` 哈希完全一致；且 `_det_check.py` 证明**同一文件连开 4 次哈希确定**。
⇒ 疑点在【多文件会话】下的 `c`。按判据 C：**直接量化，不用哈希。**

方法：同一次运行里，依次载入 A 与 B，各取**同一柱型**的
      ① `c` 数组（Float64 位型，base64 回传）→ 逐分量比
      ② 同时取 `BUF.i` 与 `BUF.e` 以定位差异落在哪些零件上
      ③ 再各自取一次 `c`（同一页内重复取）⇒ 测【页内重复性】
用法：  python 算子/\算子核心\\_ccheck.py  [柱型 M|X|A]
"""
import os
import sys
import base64
import struct
import threading
import functools
import socketserver
import http.server
from urllib.parse import quote

ROOT = os.environ.get('CATENARY_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, '算子', '算子核心')
PORT0 = 8981


# ★★ t7（2026-09-18，判据工程师2）【负控注入通道 ＋ 第 114 条闸须打印所读靶律】：
#   原实现把输入写死为 `算子/算子核心/_mig{A,B,C,D}.html` ⇒ **无法喂"已知坏样本"** ⇒
#   这份比对器**从来没有跑过负控**（没跑过负控的"绿"不得上报）。
#   改法：`--dir` 注入输入目录（**默认 = 原值，逐位不变**）＋ 打印所读靶四元。
#   判据本体（diff/nanparts/partids_of 与三条比对）**一字未动**。
def _arg(flag, default):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


DIR = _arg('--dir', '算子/算子核心').replace('\\', '/')
COL = _arg('--col', None) or (sys.argv[1] if (len(sys.argv) > 1 and not sys.argv[1].startswith('--')) else 'M')


def trip(p):
    import hashlib
    import datetime
    raw = open(p, 'rb').read()
    st = os.stat(p)
    return ('%s ｜ %d B ｜ %s ｜ %s ｜ %d 行'
            % (os.path.relpath(p, ROOT).replace('\\', '/'), len(raw),
               hashlib.sha256(raw).hexdigest().upper()[:16],
               datetime.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
               len(raw.decode('utf-8', 'replace').splitlines())))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    for port in range(PORT0, PORT0 + 40):
        try:
            httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
        except OSError:
            continue
        httpd.allow_reuse_address = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, port
    raise RuntimeError('no port')


BUF_JS = """(w) => {
  const B = window.__CAT.BUFget(); const f = Float64Array.from(B[w]);
  const u = new Uint8Array(f.buffer); let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  return btoa(s);
}"""


def grab(pg, which):
    raw = base64.b64decode(pg.evaluate(BUF_JS, which))
    return struct.unpack('<%dd' % (len(raw) // 8), raw)


def main():
    httpd, port = serve(ROOT)
    from playwright.sync_api import sync_playwright
    data = {}
    # ★ 第 114 条【闸须打印所读靶律】：判之前先打印本闸实际读的是哪几档
    print('靶（--dir = %s）：' % DIR)
    for tag in ['A', 'B']:
        print('   _mig%s.html = %s' % (tag, trip(os.path.join(ROOT, DIR, '_mig%s.html' % tag))))
    with sync_playwright() as pw:
        args = ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
        try:
            br = pw.chromium.launch(args=args)
        except Exception:
            br = pw.chromium.launch(channel='chrome', args=args)
        for tag in ['A', 'B', 'A']:                      # 第三个是 A 的【第二次】载入
            pg = br.new_page(viewport={'width': 1200, 'height': 800})
            pg.goto('http://127.0.0.1:%d/%s' % (port, quote('%s/_mig%s.html' % (DIR, tag))),
                    wait_until='load')
            pg.wait_for_timeout(2200)
            pg.evaluate("(c) => document.querySelector('[data-col=\"' + c + '\"]').click()", COL)
            pg.wait_for_timeout(1000)
            c1 = grab(pg, 'c')                            # 页内第 1 次
            c2 = grab(pg, 'c')                            # 页内第 2 次（测页内重复性）
            ids = grab(pg, 'i')
            data.setdefault(tag, []).append((c1, c2, ids))
            pg.close()
        br.close()
    httpd.shutdown()

    a1 = data['A'][0]
    a2 = data['A'][1]
    b1 = data['B'][0]

    def isna(v):
        return isinstance(v, float) and v != v

    def nancount(a):
        return sum(1 for v in a if isna(v))

    def partids_of(idarr, idxs):
        """★ 零件 ID 在 BUF.i（每顶点一个），**不在颜色数组里** —— 首版我写错了，此注为墓碑。"""
        out = []
        for k in idxs:
            v = k // 4
            if v < len(idarr):
                out.append(int(idarr[v]))
        return sorted(set(out))

    def nanparts(carr, idarr):
        """哪些零件 ID 的颜色含 NaN（RGB 三通道任一）"""
        out = {}
        nv = min(len(carr) // 4, len(idarr))
        for v in range(nv):
            if isna(carr[v * 4]) or isna(carr[v * 4 + 1]) or isna(carr[v * 4 + 2]):
                pid = int(idarr[v])
                out[pid] = out.get(pid, 0) + 1
        return out

    def diff(x, y, ids, label):
        n = min(len(x), len(y))
        if len(x) != len(y):
            print('  %s：长度不同 %d vs %d' % (label, len(x), len(y)))
            return []
        bad = []
        for k in range(n):
            u, v = x[k], y[k]
            if u == v:
                continue
            if isna(u) and isna(v):      # ★ NaN 视同相等（否则恒判"不同"）
                continue
            bad.append(k)
        print('  %-34s NaN 分量 %-7d  真实相异 %-7d / %d' % (label, nancount(x), len(bad), n))
        for k in bad[:6]:
            print('      分量#%-8d 顶点%-7d 通道%d  A=%-22r B=%-22r' % (k, k // 4, k % 4, x[k], y[k]))
        if bad:
            print('      涉及零件 ID：%s' % partids_of(ids, bad)[:12])
        return bad

    print('=' * 92)
    print('柱型 %s ｜ 颜色 `c` 定量比对（Float64 逐分量）' % COL)
    print('=' * 92)
    d_in = diff(a1[0], a1[1], a1[2], '页内重复性（A 页内两次取 c）')
    d_aa = diff(a1[0], a2[0], a2[2], '同一文件 A 两次载入')
    d_ab = diff(a1[0], b1[0], b1[2], '★ A vs B（不同 withM 语义，同源）')

    print('\n--- NaN 颜色定位（A 副本） ---')
    np_a = nanparts(a1[0], a1[2])
    if np_a:
        print('  ★ 含 NaN 颜色的零件 ID（ID: 顶点数）：%s' % dict(list(np_a.items())[:24]))
        print('  ⇒ 合计受影响顶点：%d / %d （%.3f%%）'
              % (sum(np_a.values()), min(len(a1[0]) // 4, len(a1[2])),
                 100.0 * sum(np_a.values()) / max(1, min(len(a1[0]) // 4, len(a1[2])))))
    else:
        print('  无 NaN')
    print('\n--- 与 B 是否同一批 NaN ---')
    print('  A 的 NaN 零件表 == B 的 NaN 零件表 ? %s' % (nanparts(a1[0], a1[2]) == nanparts(b1[0], b1[2])))
    print('=' * 92)
    print('判读：')
    print('  · "页内重复性"若真实相异 0 ⇒ 取数无竞态；之前的"不同"全是 NaN≠NaN 的假象。')
    print('  · "A 两次载入"若真实相异 0 ⇒ 仪器确定；哈希变化应归因于 NaN 位型。')
    print('  · "A vs B"若真实相异 0 ⇒ 迁移对颜色【零影响】。')


if __name__ == '__main__':
    main()
