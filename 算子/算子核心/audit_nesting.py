# -*- coding: utf-8 -*-
"""geom 算子迁移 · 【实证】嵌套调用点审计  audit_nesting.py

目的：不靠读代码猜 —— 用**栈追踪实测**出：真实场景里到底哪些 `withM` 调用点
      是在 `MAT != null`（即【嵌套】）时执行的。这些就是"栈语义"会改变行为的点，
      也就是迁移风险清单。

方法：
  1) 把交付 HTML 复制一份（★绝不改交付件），把 L450 的 `withM` 替换成**单行**插桩版
     —— 单行是为了**行号不移位**，这样栈里的行号能直接映射回源码。
  2) 起静态服务器 + Playwright 打开副本，依次点击 中间柱/转换柱/锚柱 三个按钮，
     每次重建场景时统计各调用点的嵌套次数与最大深度。
  3) 产出 JSON + 可读表格。

用法：  python 算子/\算子核心\\audit_nesting.py
"""
import os, sys, json, threading, functools, socketserver, http.server
from urllib.parse import quote

def _arg(flag, default):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


ROOT = os.environ.get('CATENARY_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
# ★★ t7（2026-09-18，判据工程师2）【负控注入通道 ＋ 第 114 条闸须打印所读靶律】：
#   原实现把源写死为交付主档 ⇒ **无法喂"已知坏样本"**（本件因此从来没有跑过负控）。
#   `--src` / `--out-html` / `--out-json` 三个注入点，**默认值 = 原值，逐位不变**。
SRC = os.path.abspath(_arg('--src', os.path.join(ROOT, '模型', '接触网中间柱3D模型.html')))
OUTDIR = os.path.join(ROOT, '算子', '算子核心')
DST = os.path.abspath(_arg('--out-html', os.path.join(OUTDIR, '_audit.html')))
OUTJSON = os.path.abspath(_arg('--out-json', os.path.join(OUTDIR, '_审计_嵌套调用点.json')))
PORT0 = 8911

OLD = 'function withM(m,fn){ var o=MAT; MAT=m; fn(); MAT=o; }'


# ★★★ t7 修（同一笔）：`__WSKIP` 由 `build_copy()` **现算注入**，替换原来的**硬编码 `450`**。
#   依据【行号不得用常数换算】（本会话血换的）：`450` 是**旧代**里 `withM` 定义所在行；
#   现档该定义在 **L531**（现读，采样 2026-09-18 23:1x）⇒ 原过滤器已失效 ⇒
#   **所有嵌套站点都会被归到 `withM` 定义那一行**（错），而不是真正的调用点行。
#   本件是一条判据 ⇒ 按【凡判据必须配负控】先跑负控（见下命令与报告），**先判红、再修**。
def inj_js(skip_line):
    """单行注入（不得含换行，否则行号移位 ⇒ 栈行号无法映射回源码）。"""
    return (
        'var __WS={},__WD=0,__WPEAK=0,__WTOT=0,__WSKIP=%d;'
        'window.__WRESET=function(){__WS={};__WD=0;__WPEAK=0;__WTOT=0;};'
        'window.__WAUDIT=function(){return {sites:__WS,peak:__WPEAK,total:__WTOT,depthNow:__WD};};'
        'function withM(m,fn){ var o=MAT; MAT=m; __WD++; __WTOT++; if(__WD>__WPEAK)__WPEAK=__WD;'
        ' if(__WD>1){ var __ls=((new Error()).stack||"").split("\\n"), __k=0;'
        ' for(var __i=1;__i<__ls.length;__i++){ var __mm=/:(\\d+):\\d+\\)?\\s*$/.exec(__ls[__i]);'
        ' if(__mm && +__mm[1]!==__WSKIP){ __k=+__mm[1]; break; } }'
        ' var __e=__WS[__k]||(__WS[__k]={n:0,maxd:0}); __e.n++; if(__WD>__e.maxd)__e.maxd=__WD; }'
        ' try{ fn(); } finally { MAT=o; __WD--; } }' % skip_line)


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


def trip(p):
    """第 114 条【闸须打印所读靶律】：判之前先打印本闸实际读的是哪一档。"""
    import hashlib, datetime
    raw = open(p, 'rb').read()
    st = os.stat(p)
    return ('%s ｜ %d B ｜ %s ｜ %s ｜ %d 行'
            % (os.path.relpath(p, ROOT).replace('\\', '/'), len(raw),
               hashlib.sha256(raw).hexdigest().upper()[:16],
               datetime.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
               len(raw.decode('utf-8', 'replace').splitlines())))


def build_copy():
    src = open(SRC, encoding='utf-8').read()
    n = src.count(OLD)
    if n != 1:
        print('[ABORT] 待替换的 withM 原句在 %s 中出现 %d 次（应为 1）—— 交付件可能已被改动，拒绝继续'
              % (os.path.relpath(SRC, ROOT).replace('\\', '/'), n))
        sys.exit(2)
    # ★ 现算"要跳过的行号"= `withM` 定义所在行（1-based，注入后行号不变）
    skip_line = src[:src.index(OLD)].count('\n') + 1
    out = src.replace(OLD, inj_js(skip_line))
    if out.count('\n') != src.count('\n'):
        print('[ABORT] 注入后行数改变 ⇒ 行号会移位，审计结论不可用')
        sys.exit(3)
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    open(DST, 'w', encoding='utf-8').write(out)
    print('注入行号 __WSKIP = %d（现算，= 源中 withM 定义行；**原为硬编码 450**）' % skip_line)
    return src.split('\n')


JS_CLICK = """(c) => { const b = document.querySelector('[data-col="' + c + '"]');
  if (!b) return 'NOBTN'; b.click(); return 'OK'; }"""


def main():
    print('[靶] 第 114 条：源 = %s' % trip(SRC))
    lines = build_copy()
    print('注入副本：%s（行数与源相同 = %d）' % (os.path.relpath(DST, ROOT).replace('\\', '/'), len(lines)))

    httpd, port = serve(ROOT)
    url = 'http://127.0.0.1:%d/%s' % (port, quote(os.path.relpath(DST, ROOT).replace('\\', '/')))
    from playwright.sync_api import sync_playwright

    report = {'url': url, 'cols': {}}
    with sync_playwright() as pw:
        args = ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
        try:
            b = pw.chromium.launch(args=args)
        except Exception:
            b = pw.chromium.launch(channel='chrome', args=args)
        pg = b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errs.append(m.type + ': ' + m.text) if m.type == 'error' else None)
        pg.goto(url, wait_until='load')
        pg.wait_for_timeout(2500)
        report['has_audit'] = pg.evaluate('() => typeof window.__WAUDIT === "function"')

        for col, name in [('M', '中间柱'), ('X', '转换柱'), ('A', '锚柱')]:
            pg.evaluate('() => window.__WRESET && window.__WRESET()')
            click = pg.evaluate(JS_CLICK, col)
            pg.wait_for_timeout(1500)
            a = pg.evaluate('() => window.__WAUDIT ? window.__WAUDIT() : null')
            if a:
                a['click'] = click
                a['name'] = name
            report['cols'][col] = a
        report['console_errors'] = errs[:20]
        b.close()
    httpd.shutdown()

    # ---------------- 汇总：按调用点行号合并三个柱型 ----------------
    agg = {}
    for col, a in report['cols'].items():
        if not a:
            continue
        for ln, e in a['sites'].items():
            r = agg.setdefault(int(ln), {'n': 0, 'maxd': 0, 'cols': []})
            r['n'] += e['n']
            r['maxd'] = max(r['maxd'], e['maxd'])
            r['cols'].append(col)
    report['aggregate'] = {str(k): v for k, v in sorted(agg.items())}

    path = OUTJSON
    report['src'] = trip(SRC)
    report['copy'] = trip(DST)
    report['wskip_line'] = None
    open(path, 'w', encoding='utf-8').write(json.dumps(report, ensure_ascii=False, indent=2))

    print('\n' + '=' * 100)
    print('【实证】在 MAT!=null（嵌套）时被执行的 withM 调用点 —— 这些就是栈语义会改行为的风险点')
    print('=' * 100)
    for a in report['cols'].values():
        if a:
            print('  %s(%s): withM 总调用 %-6d 峰值深度 %d  嵌套调用点 %d 个'
                  % (a['name'], a['click'], a['total'], a['peak'], len(a['sites'])))
    print('\n  合计唯一嵌套调用点：%d 个' % len(agg))
    if agg:
        print('\n  %-6s %-9s %-5s  %s' % ('行号', '嵌套次数', '峰值深', '源码'))
        for ln in sorted(agg):
            r = agg[ln]
            txt = lines[ln - 1].strip() if 0 < ln <= len(lines) else '<行号越界>'
            if len(txt) > 84:
                txt = txt[:84] + '…'
            print('  L%-5d %-9d %-5d  %s' % (ln, r['n'], r['maxd'], txt))
    else:
        print('\n  ★ 一个都没有 —— 说明现有全部 withM 调用点本来就在顶层执行，')
        print('    切换栈语义【不改变任何现有几何】。')
    if report['console_errors']:
        print('\n  控制台错误：')
        for e in report['console_errors'][:10]:
            print('    ' + e[:150])
    else:
        print('\n  控制台无错误 ✅')
    print('\n报告：%s' % path)


if __name__ == '__main__':
    main()
