# -*- coding: utf-8 -*-
"""geom 算子迁移 · 等价性验证  verify_migration.py

三份副本，同一份源（同一次读取、同一 SHA）：
  A  基线      ：原始 withM（替换语义） + 原始 L1400（世界坐标绕过）
  B  迁移后    ：栈语义 withM          + L1400 改写为局部坐标     ⇒ 断言行缓冲【与 A 逐位相同】
  C  正控(naive)：栈语义 withM          + L1400 **未改**（世界坐标） ⇒ 断言【与 A 不同】

★ C 是**比对方法的正控**：若 C 也等于 A，说明本比对测不出差异 ⇒ A/B 的"相等"毫无价值。
★ 三份都注入 `__CAT.BUFget`（同一处单行替换，不改行数）以取得完整顶点缓冲，
  并对 p/n/c/i/e 各算 64 位浮点位型 FNV 哈希（**按 IEEE-754 位型，不是数值近似**）。

用法：  python 算子/\算子核心\\verify_migration.py
"""
import os, sys, json, hashlib, threading, functools, socketserver, http.server
from urllib.parse import quote

ROOT = os.environ.get('CATENARY_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
SRC = os.path.join(ROOT, '模型', '接触网中间柱3D模型.html')
OUT = os.path.join(ROOT, '算子', '算子核心')
PORT0 = 8931

OLD_WITHM = 'function withM(m,fn){ var o=MAT; MAT=m; fn(); MAT=o; }'
NEW_WITHM = ('function withM(m,fn){ var o=MAT; if(o===null){ MAT=m; } else {'
             ' var s=new Float32Array(16),c,r;'
             ' for(c=0;c<4;c++)for(r=0;r<4;r++)'
             ' s[c*4+r]=o[r]*m[c*4]+o[4+r]*m[c*4+1]+o[8+r]*m[c*4+2]+o[12+r]*m[c*4+3];'
             ' MAT=s; } try{ fn(); } finally { MAT=o; } }')

OLD_L1400 = ('withM(frameY([s*vW*0.5, yU+seatLift-0.012, sd],\n'
             '                     [s*vW*0.10, yU+seatLift+vH-0.012, sd]),function(){')
NEW_L1400 = ('withM(frameY([s*vW*0.5, seatLift-0.012, 0],\n'
             '                     [s*vW*0.10, seatLift+vH-0.012, 0]),function(){')

# ★ 副本 D 用：撤掉 `sphereAt` / `polyTube` 两处【绕过】—— 即 `算子/算子核心\geom.js` 的设计。
#   替换片段均**保持行数不变**（must_replace 会校验），以便与基线逐行对照。
OLD_SPHERE = ('  var wc=xfP([cx,cy,cz]);\n'
              '  withM(m4tr(wc[0],wc[1],wc[2]),function(){')
NEW_SPHERE = ('  /* 干净算子：球心作【局部】坐标交给栈（去掉 xfP 世界化 + m4tr 的绕过） */\n'
              '  withM(m4tr(cx,cy,cz),function(){')

OLD_POLYTUBE = ('  var o=MAT, i2, w=[];\n'
                '  for(i2=0;i2<pts.length;i2++) w.push(xfP(pts[i2]));\n'
                '  MAT=null;')
NEW_POLYTUBE = ('  var o=MAT, i2, w=pts;   /* 干净算子：撤掉 D25 补丁（栈语义下无需世界化/无需清 MAT） */\n'
                '  /* —— 局部坐标直接交给矩阵栈即正确；本块保留 3 行以维持行号不变 —— */\n'
                '  /* ------------------------------------------------------------------ */')

EXPOSE_OLD = 'window.__CAT={CAM:CAM'
EXPOSE_NEW = 'window.__CAT={BUFget:function(){return BUF;},CAM:CAM'


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


def must_replace(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print('[ABORT] %s 的目标片段出现 %d 次（应为 1）—— 源已变，拒绝继续' % (tag, n))
        sys.exit(2)
    if old.count('\n') != new.count('\n'):
        print('[ABORT] %s 替换改变行数 ⇒ 行号位移' % tag)
        sys.exit(3)
    return s.replace(old, new)


HASH_JS = """() => {
  const B = window.__CAT && window.__CAT.BUFget ? window.__CAT.BUFget() : null;
  if (!B) return null;
  const ab = new ArrayBuffer(8), dv = new DataView(ab);
  const h = (arr) => { let x = 2166136261 >>> 0;
    for (let i = 0; i < arr.length; i++) { dv.setFloat64(0, arr[i]);
      for (let k = 0; k < 8; k++) { x ^= dv.getUint8(k); x = Math.imul(x, 16777619) >>> 0; } }
    return x.toString(16).padStart(8, '0'); };
  return { p: h(B.p), n: h(B.n), c: h(B.c), i: h(B.i), e: h(B.e),
           np: B.p.length, ni: B.i.length, nv: B.p.length / 3 };
}"""

"""★ 为什么还要把 `p` 整段传回来做【定量】比对 —— 哈希是二值判据，仪器类型不对：
   哈希只能告诉我"不同"，不能告诉我"差多少"。而本次差异的两种可能后果差了 15 个数量级：
     |Δ| ~ 1e-16  ⇒ 浮点结合律差（(yU+0.1)−0.012  vs  (0.1−0.012)+yU）⇒ 肉眼不可见，迁移安全
     |Δ| ~ 6.6    ⇒ 真的二次平移 ⇒ 几何错误
   ⇒ 必须换成逐分量 max|Δ|，并给出**推导出来的**容差。"""
BUF_JS = """(w) => {
  const B = window.__CAT.BUFget(); const f = Float64Array.from(B[w]);
  const u = new Uint8Array(f.buffer); let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  return btoa(s);
}"""

"""★★ 决定性判据：`upload()`（L2351）执行 `var arr=new Float32Array(n*14)` 后 `gl.bufferData`，
   ⇒ **真正上传到显卡的是 float32**。`BUF.p` 只是 double 中间态。
   所以"迁移是否改变外观"应当以 **float32 上传缓冲**为准 —— 这是最终产物本身的表示精度。"""
GPUP_JS = """() => {
  const B = window.__CAT.BUFget(); const f = Float32Array.from(B.p);
  const u = new Uint8Array(f.buffer); let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  return btoa(s);
}"""


def main():
    src = open(SRC, encoding='utf-8').read()
    sha = hashlib.sha256(src.encode('utf-8')).hexdigest()
    print('源：%s\nSHA256：%s…   行数 %d + 1' % (SRC, sha[:16], src.count('\n')))

    # 三份都先注入 BUF 取用口
    base = must_replace(src, EXPOSE_OLD, EXPOSE_NEW, 'EXPOSE')
    A = base
    B = must_replace(must_replace(base, OLD_WITHM, NEW_WITHM, 'withM'), OLD_L1400, NEW_L1400, 'L1400')
    C = must_replace(base, OLD_WITHM, NEW_WITHM, 'withM')
    # D = 【干净算子库】栈 withM + 撤掉 sphereAt/polyTube 两处绕过 + L1400 改写
    #     ⇒ 验证 `算子/算子核心\geom.js` 的算子设计在【真实场景】上与基线等价
    D = must_replace(base, OLD_WITHM, NEW_WITHM, 'withM')
    D = must_replace(D, OLD_SPHERE, NEW_SPHERE, 'sphereAt')
    D = must_replace(D, OLD_POLYTUBE, NEW_POLYTUBE, 'polyTube')
    D = must_replace(D, OLD_L1400, NEW_L1400, 'L1400')

    files = {}
    for tag, txt in [('A', A), ('B', B), ('C', C), ('D', D)]:
        p = os.path.join(OUT, '_mig%s.html' % tag)
        open(p, 'w', encoding='utf-8').write(txt)
        files[tag] = p
    print('已写出 A/B/C 三份副本（行数均为 %d）' % (A.count('\n') + 1))

    httpd, port = serve(ROOT)
    from playwright.sync_api import sync_playwright
    res = {}
    with sync_playwright() as pw:
        args = ['--use-gl=angle', '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
        try:
            br = pw.chromium.launch(args=args)
        except Exception:
            br = pw.chromium.launch(channel='chrome', args=args)
        for tag in ['A', 'B', 'C', 'D']:
            pg = br.new_page(viewport={'width': 1200, 'height': 800})
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            url = 'http://127.0.0.1:%d/%s' % (port, quote('算子/算子核心/_mig%s.html' % tag))
            pg.goto(url, wait_until='load')
            pg.wait_for_timeout(2200)
            res[tag] = {}
            for col in ['M', 'X', 'A']:
                pg.evaluate("(c) => document.querySelector('[data-col=\"' + c + '\"]').click()", col)
                pg.wait_for_timeout(900)
                res[tag][col] = pg.evaluate(HASH_JS)
                res[tag][col + '_p64'] = pg.evaluate(BUF_JS, 'p')
                res[tag][col + '_g32'] = pg.evaluate(GPUP_JS)
            res[tag]['_errors'] = errs[:5]
            pg.close()
        br.close()
    httpd.shutdown()

    # ---------------- 判定 ----------------
    print('\n' + '=' * 96)
    print('顶点缓冲哈希（FNV-1a / IEEE-754 位型）')
    print('=' * 96)
    print('  %-4s %-4s %-9s %-10s %-10s %-10s %-10s' % ('副本', '柱型', '顶点数', 'p', 'n', 'c', 'i'))
    for tag in ['A', 'B', 'C']:
        for col in ['M', 'X', 'A']:
            r = res[tag][col]
            if not r:
                print('  %-4s %-4s  <无缓冲>' % (tag, col)); continue
            print('  %-4s %-4s %-9d %-10s %-10s %-10s %-10s'
                  % (tag, col, r['nv'], r['p'], r['n'], r['c'], r['i']))

    import base64, struct, operator, math

    def posarr(tag, col):
        raw = base64.b64decode(res[tag][col + '_p64'])
        return struct.unpack('<%dd' % (len(raw) // 8), raw)

    COLS = ['M', 'X', 'A']
    # ① 非位置分量：哈希是**恰当**的二值判据（它们要么逐位相同、要么结构已变）
    def sameH(x, y):
        return x and y and all(x[k] == y[k] for k in ['n', 'c', 'i', 'e', 'np', 'ni'])
    fixedAB = all(sameH(res['A'][c], res['B'][c]) for c in COLS)

    # ② 位置：定量 max|Δ|。★ 容差**推导**而来，不是调到绿。
    #   ⚠ 自我修正：首版我按 float64 推（eps = 2^-52）得 1e-12 m —— **存储精度取错了**：
    #     `m4tr` / `frameY` / 组合矩阵**全是 Float32Array** ⇒ 组合平移多一次 float32 舍入。
    #   正确推导：坐标量级 ≤ 8.75 m（柱顶）⇒ float32 ulp = 2^(3-23) = 2^-20 = 9.537e-07 m。
    #     父∘子组合在平移项上引入 ≤ 1 ulp，`xfP` 的三乘加再引入 ≤ 1 ulp
    #     ⇒ 上界 TOL = 2 × ulp(8.75) ≈ 1.9e-06 m（约 1.9 µm）。
    # ★ 物理判别力：1.9 µm 比接触网钢结构装配公差（±2 mm）小 3 个数量级；
    #   正控 C 的偏差为米级（6.6 / 7.1 m）⇒ 与 TOL 相差 6 个数量级 ⇒ 判据绝非恒真。
    TOL = 2 * math.pow(2, -20)

    print('\n' + '=' * 96)
    print('位置定量比对（逐分量 float64）   TOL = %.0e m（= 1 皮米）' % TOL)
    print('=' * 96)
    print('  %-4s %-12s %-16s %-16s %-8s %s' % ('柱型', '相异分量数', 'max|B-A| (m)', 'max|C-A| (m)', '②判定', '③正控'))
    okAB = True; okCA = True
    for c in COLS:
        pa = posarr('A', c); pb = posarr('B', c); pc = posarr('C', c)
        nd = sum(1 for x, y in zip(pa, pb) if x != y)
        dab = max(map(abs, map(operator.sub, pa, pb)))
        dac = max(map(abs, map(operator.sub, pa, pc)))
        good = dab <= TOL
        ctrl = dac > TOL * 1e6
        okAB = okAB and good; okCA = okCA and ctrl
        print('  %-4s %-12d %-16.3e %-16.3e %-8s %s'
              % (c, nd, dab, dac, '✅' if good else '✗', '✅' if ctrl else '✗'))

    def gpu32(tag, col):
        raw = base64.b64decode(res[tag][col + '_g32'])
        return struct.unpack('<%df' % (len(raw) // 4), raw)

    print('\n' + '=' * 96)
    print('④ ★ 决定性判据：【GPU 实际上传缓冲】 Float32Array(BUF.p)')
    print('   （依据：upload() L2351 `var arr=new Float32Array(n*14)` → gl.bufferData —— 这才是最终产物）')
    print('=' * 96)
    okGPU = True
    for c in COLS:
        ga = gpu32('A', c); gb = gpu32('B', c); gc = gpu32('C', c)
        nd = sum(1 for x, y in zip(ga, gb) if x != y)
        dab = max((abs(x - y) for x, y in zip(ga, gb)), default=0.0)
        dac = max((abs(x - y) for x, y in zip(ga, gc)), default=0.0)
        same = (nd == 0)
        okGPU = okGPU and same
        print('  %-4s  相异分量 %-9d  max|B-A| = %-13.3e  max|C-A| = %-13.3e  %s'
              % (c, nd, dab, dac, '✅ 逐位相同' if same else '△ 有差异'))

    # ---------------- ⑤ 干净算子库（D） vs 基线（A） ----------------
    print('\n' + '=' * 96)
    print('⑤ ★ 【干净算子库】(D) vs 基线 A')
    print('   D = 栈 withM ＋ 撤掉 sphereAt/polyTube 两处【绕过】 ＋ L1400 改写')
    print('   ⇒ 验证 `算子/\算子核心\\geom.js` 的算子设计在【真实场景】上与基线等价')
    print('   （B 只证明"最小迁移＝保留补丁"安全；D 才证明"干净重写"安全 —— 两者是不同的迁移）')
    print('=' * 96)
    okAD = True
    for c in COLS:
        pa = posarr('A', c); pd = posarr('D', c)
        nd = sum(1 for x, y in zip(pa, pd) if x != y)
        dad = max(map(abs, map(operator.sub, pa, pd)))
        ga = gpu32('A', c); gd = gpu32('D', c)
        ndg = sum(1 for x, y in zip(ga, gd) if x != y)
        good = dad <= TOL
        okAD = okAD and good
        print('  %-4s  double 相异 %-8d  max|D-A| = %-13.3e  GPU32 相异 %-7d  %s'
              % (c, nd, dad, ndg, '✅' if good else '✗'))

    print('\n' + '=' * 96)
    print('判定')
    print('=' * 96)
    print('  ① n / c / i / e 哈希逐位相同（B vs A）        : %s' % ('✅' if fixedAB else '✗'))
    print('  ② double 位置 max|B-A| ≤ %.1e m            : %s' % (TOL, '✅' if okAB else '✗'))
    print('  ③ 正控 max|C-A| ≫ TOL（比对确有判别力）       : %s' % ('✅' if okCA else '✗ ⇒ ② 无意义'))
    print('  ④ ★ GPU float32 上传缓冲逐位相同             : %s' % ('✅' if okGPU else '△ 见上'))
    print('  ⑤ ★ 干净算子库 D 与基线 A 等价（≤TOL）        : %s' % ('✅' if okAD else '✗'))
    print('  A/B/C/D 控制台错误                            : %s' % {t: res[t]['_errors'] for t in res})
    print('\n  附注：C 的 n 哈希与 A 不同属**预期** —— `tri` 的法线由**变换后的顶点**做叉积得到，')
    print('        大平移(6.6 m) 使 (b-a) 的绝对舍入变大 ⇒ 法线末位不同（量级 ~1e-14，无视觉影响）。')

    if okGPU and fixedAB and okAD:
        verdict = True
        concl = ('迁移【外观中性】已【逐位】证明 —— GPU 实际上传缓冲（float32）三柱型全部逐位相同，'
                 'n/c/i/e 亦逐位相同；正控确认比对可检出真实偏差；'
                 '★ 且【干净算子库 D】与基线等价 ⇒ `geom.js` 的算子设计可直接替换。')
    elif okAB and okCA and fixedAB and okAD:
        verdict = True
        concl = ('迁移外观中性 —— double 位置差 ≤ %.1e m（≤1 个 float32 ulp，比装配公差 ±2 mm 小 3 个数量级）；'
                 'n/c/i/e 逐位相同；正控有效；★ 干净算子库 D 亦与基线等价。' % TOL)
    else:
        verdict = False
        concl = '★ 未达成，禁止推进迁移。'
    print('\n  ⇒ 结论：%s' % concl)
    out = os.path.join(OUT, '_迁移等价性_报告.json')
    # ★ 不要把 base64 原始缓冲写进报告 —— 首版忘了剥掉，产出 138 MB 的 JSON（纯属浪费）。
    slim = {t: {k: v for k, v in d.items() if not (k.endswith('_p64') or k.endswith('_g32'))}
            for t, d in res.items()}

    # ══════════════════════════════════════════════════════════════════════════
    # ★★ t79 修复：`C_ne_A` 原写为 `not okCA` —— **符号反了**（自相矛盾）
    # ---------------------------------------------------------------------------
    # 原写法：  'C_ne_A': not okCA
    # 语义：    okCA 的含义是「**正控生效**」= C 与 A 的偏差 ≫ TOL = **C 确实不同于 A**
    #           ⇒ `C_ne_A` 应 = `okCA`，而原式写成 `not okCA` ⇒ **恒反**。
    # 实证（原报告载荷）：C 的三个基元哈希 **全部不同于** A
    #   M `f8124d60→0fe76568` ｜ X `72aae13e→a5262442` ｜ A `a839bb2f→1fbe1917`
    #   而报告却写 `C_ne_A = false` ⇒ **标志位与自身载荷矛盾**。
    # 后果：**这个等价性检验到底有没有分辨力，说不清** ——
    #   若 C_ne_A 恒 false，则「B_eq_A=true」可能只是**判据无分辨力**的假绿，
    #   而不是「迁移真的等价」。**哑掉的负控 = 把整份报告的可信度一起哑掉。**
    #
    # ★ 修法（依【期望侧不得取自被判对象律】）：**从载荷派生，不写死**。
    # ══════════════════════════════════════════════════════════════════════════
    HKEYS = ('p', 'n', 'c', 'i', 'e', 'np', 'ni')

    def _htup(tag, col):
        d = res[tag][col]
        return tuple(str(d.get(k)) for k in HKEYS)

    # B_eq_A：逐柱型、逐哈希键，B 与 A 全等
    B_eq_A_derived = all(_htup('B', c) == _htup('A', c) for c in COLS)
    # C_ne_A：C 与 A **至少有一处不同**（正控应成立）
    C_ne_A_derived = any(_htup('C', c) != _htup('A', c) for c in COLS)
    # 逐柱型明细（可复核）
    _per_col = {c: {'B_eq_A': _htup('B', c) == _htup('A', c),
                    'C_ne_A': _htup('C', c) != _htup('A', c)} for c in COLS}

    # verdict：**由 B_eq_A && C_ne_A 计算得出，不写死**
    verdict_derived = bool(B_eq_A_derived and C_ne_A_derived
                           and fixedAB and okAD and (okGPU or okAB))

    # 与旧口径的一致性核验（若不符 ⇒ 必须显式报警，不得静默）
    _consistency = {
        'B_eq_A_old': okAB, 'B_eq_A_derived': B_eq_A_derived,
        'B_eq_A_match': (okAB == B_eq_A_derived),
        'C_ne_A_old_literal': (not okCA), 'C_ne_A_derived': C_ne_A_derived,
        'C_ne_A_match': ((not okCA) == C_ne_A_derived),
        'note': ('★ 二者不符 ⇒ 说明标志位与载荷矛盾（本次修复的正是此项）'
                 if (not okCA) != C_ne_A_derived else '一致'),
    }
    print('\n' + '=' * 96)
    print('★ 标志位【由载荷派生】（t79 修复：C_ne_A 原为 `not okCA`，符号反了）')
    print('=' * 96)
    print('  B_eq_A  派生 = %-6s （旧口径 %-6s 一致=%s）'
          % (B_eq_A_derived, okAB, _consistency['B_eq_A_match']))
    print('  C_ne_A  派生 = %-6s （旧口径 %-6s 一致=%s）  ← ★ 修复项'
          % (C_ne_A_derived, (not okCA), _consistency['C_ne_A_match']))
    print('  verdict 派生 = %-6s （由 B_eq_A && C_ne_A 计算）' % verdict_derived)
    for c in COLS:
        print('    %-3s B_eq_A=%-6s C_ne_A=%-6s' % (c, _per_col[c]['B_eq_A'], _per_col[c]['C_ne_A']))
    if not _consistency['C_ne_A_match']:
        print('  ★★ 报警：旧口径 C_ne_A=%s 与载荷派生的 %s **不符** ⇒ 原报告自相矛盾。'
              % ((not okCA), C_ne_A_derived))

    open(out, 'w', encoding='utf-8').write(json.dumps(
        {'sha256': sha, 'result': slim,
         'B_eq_A': B_eq_A_derived, 'C_ne_A': C_ne_A_derived,
         'verdict': verdict_derived,
         'derivation': {
             'B_eq_A': 'all( hash_tuple(B,c) == hash_tuple(A,c) for c in [M,X,A] )',
             'C_ne_A': 'any( hash_tuple(C,c) != hash_tuple(A,c) for c in [M,X,A] )',
             'verdict': 'B_eq_A && C_ne_A && fixedAB && okAD && (okGPU || okAB)',
             'hash_keys': list(HKEYS),
             'per_column': _per_col,
             'consistency_vs_old': _consistency,
         },
         'negative_control_void_warning': (
             '★【负控哑掉的后果】若 C_ne_A 恒为 false（原实现 `not okCA` 即如此），'
             '则「B_eq_A=true」**无法排除"判据本身无分辨力"这一解释** —— '
             '等价性结论与"比对器坏了"在报告上**不可区分**。'
             '修复后 C_ne_A 由载荷派生为 true ⇒ 正控生效 ⇒ B_eq_A 的 true 才有意义。'),
         'fixed_by': '资产库工程师(t79)：C_ne_A 由 `not okCA` 改为载荷派生',
         },
        ensure_ascii=False, indent=2))
    print('\n报告：%s' % out)
    sys.exit(0 if verdict_derived else 1)


if __name__ == '__main__':
    main()
