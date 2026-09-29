# -*- coding: utf-8 -*-
"""判据 C 自检：**等价比对仪器本身是否确定**  _det_check.py

缘起：`verify_migration.py` 两次运行中，**同一个未改动的基线 A 的【颜色哈希】不同**
      （run1 `bcd542ba` → run2 `16affaba`），而 `p/n/i` 哈希完全一致。
按判据 C（"假绿与假红是同一个病 —— 判据分辨力/稳定性不足"）：
      **先测仪器自身**，再谈被测对象。

方法：把**同一份副本**在同一台浏览器里**连开 4 个独立页面**，各取一次哈希，互比。
      若 4 次不完全一致 ⇒ **仪器不确定** ⇒ 之前一切哈希类结论都不可用。
      若 4 次一致 ⇒ 仪器确定 ⇒ 颜色差异是**源改动**引起，需另查。

用法：  python 算子/\算子核心\\_det_check.py
"""
import os
import sys
import json
import threading
import functools
import socketserver
import http.server
from urllib.parse import quote

ROOT = os.environ.get('CATENARY_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, '算子', '算子核心')
PORT0 = 8961
COPIES = ['_migA.html', '_migA.html', '_migA.html', '_migA.html']   # 同一份，开 4 次


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    last = None
    for port in range(PORT0, PORT0 + 40):
        try:
            httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
        except OSError as e:
            last = e
            continue
        httpd.allow_reuse_address = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, port
    raise RuntimeError('no free port: %r' % (last,))


HASH_JS = """() => {
  const B = window.__CAT && window.__CAT.BUFget ? window.__CAT.BUFget() : null;
  if (!B) return null;
  const ab = new ArrayBuffer(8), dv = new DataView(ab);
  const h = (arr) => { let x = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) { dv.setFloat64(0, arr[i]);
      for (let k = 0; k < 8; k++) { x ^= dv.getUint8(k); x = Math.imul(x, 16777619) >>> 0; } }
    return x.toString(16).padStart(8, '0'); };
  return { p: h(B.p), n: h(B.n), c: h(B.c), i: h(B.i), e: h(B.e), nv: B.p.length / 3 };
}"""


def main():
    p = os.path.join(OUT, '_migA.html')
    if not os.path.exists(p):
        print('[ABORT] 缺 %s —— 请先跑 verify_migration.py' % p)
        sys.exit(2)

    httpd, port = serve(ROOT)
    from playwright.sync_api import sync_playwright
    runs = []
    with sync_playwright() as pw:
        args = ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
        try:
            br = pw.chromium.launch(args=args)
        except Exception:
            br = pw.chromium.launch(channel='chrome', args=args)
        for i, cp in enumerate(COPIES):
            pg = br.new_page(viewport={'width': 1200, 'height': 800})
            pg.goto('http://127.0.0.1:%d/%s' % (port, quote('算子/算子核心/' + cp)),
                    wait_until='load')
            pg.wait_for_timeout(2200)
            r = {}
            for col in ['M', 'X', 'A']:
                pg.evaluate("(c) => document.querySelector('[data-col=\"' + c + '\"]').click()", col)
                pg.wait_for_timeout(900)
                r[col] = pg.evaluate(HASH_JS)
            runs.append(r)
            pg.close()
        br.close()
    httpd.shutdown()

    print('=' * 92)
    print('仪器确定性检查：同一份 %s 连开 %d 次' % (COPIES[0], len(COPIES)))
    print('=' * 92)
    print('  %-6s %-4s %-10s %-10s %-10s %-10s %-10s' % ('次', '柱型', 'p', 'n', 'c', 'i', 'e'))
    for i, r in enumerate(runs):
        for col in ['M', 'X', 'A']:
            d = r[col]
            print('  #%-5d %-4s %-10s %-10s %-10s %-10s %-10s'
                  % (i, col, d['p'], d['n'], d['c'], d['i'], d['e']))

    KEYS = ['p', 'n', 'c', 'i', 'e', 'nv']
    bad = []
    for col in ['M', 'X', 'A']:
        base = runs[0][col]
        for i in range(1, len(runs)):
            for k in KEYS:
                if runs[i][col][k] != base[k]:
                    bad.append((col, k, base[k], i, runs[i][col][k]))

    print('\n' + '=' * 92)
    if bad:
        print('★ 仪器【不确定】—— 同一份文件连测结果不一致：')
        for col, k, v0, i, vi in bad:
            print('   柱型 %s 字段 %s：第 0 次 = %s，第 %d 次 = %s' % (col, k, v0, i, vi))
        print('\n⇒ 后果：此前一切【哈希类】结论（n/c/i/e 逐位相同）**均不可用**，')
        print('   必须改为【同一次运行内的逐分量定量比对】。')
    else:
        print('✅ 仪器【确定】—— 4 次连测，5 个哈希 + 顶点数全部一致。')
        print('   ⇒ 之前 A 的颜色哈希变化**不是仪器抖动**，而是**源改动**引起；需另查源。')
    print('=' * 92)
    json.dump({'runs': runs, 'inconsistent': bad},
              open(os.path.join(OUT, '_det_check.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
