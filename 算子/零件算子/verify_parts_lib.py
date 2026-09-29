# -*- coding: utf-8 -*-
"""零件算子库 vs 交付件 · 注入式等价性验证  verify_parts_lib.py

目的：把 `算子/\零件算子\\parts.js` 的 9 个算子**注入真实场景**，与基线逐分量比对。
      **"忠实照抄"是声明，不是证据** —— 证据必须来自实测。

方法（沿用已验证的注入法）：
  1) 取交付件一份，**只重命名** 9 个原算子定义（`function boltAt(` → `function boltAt_orig(`）
     —— 重命名**不改行数**，原实现作为死代码保留；
  2) 在 `function part(id,fn){` 前插入：parts.js 全文 + 一个 shim + 用库版本**覆盖**这 9 个名字；
  3) 另取一份纯基线（不注入库）；
  4) 两版各跑 M/X/A 三柱型，逐分量比对。

★ 预期（**可证伪，且是本次特有的**）：
   · **位置 p**：差 ≤ 1 个 float32 ulp（栈语义组合舍入）
   · **法线 n / 零件ID i / 展开 e**：逐位相同
   · **颜色 c**：**只在【原本是 NaN 的那 3552 个顶点】上不同** ——
     因为库版修了交付件 `L736` 的 `col`/`caps` 传反（芯股颜色 undefined）。
     **⇒ 若颜色在别处也不同，说明我的移植改坏了东西。**

用法：  python "算子/\零件算子\\verify_parts_lib.py"
"""
import os
import io
import sys
import json
import base64
import struct
import threading
import functools
import socketserver
import http.server
from urllib.parse import quote

ROOT = os.environ.get('CATENARY_ROOT') or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
SRC = os.path.join(ROOT, '模型', '接触网中间柱3D模型.html')
OUT = os.path.join(ROOT, '算子', '零件算子')
LIB = os.path.join(OUT, 'parts.js')
PORT0 = 9081

EXPOSE_OLD = 'window.__CAT={CAM:CAM'
EXPOSE_NEW = 'window.__CAT={BUFget:function(){return BUF;},CAM:CAM'
BLOCK_SUBS = []   # t120：运行时按现档抽取（免嵌入长字面、免跨代失效）

def build_block_subs(src):
    """★ t268（2026-09-28）：咬槽族改由 ``jointClamp`` 走**与其余 17 算子同一条注入路**（见 RENAME/PRELUDE）
    ⇒ DROP_CLAMP_C 的**内联块锚点已不存在于现档**（旧档 ``part(PT.DROP_CLAMP_C,function(){`` 在
    ``接触网中间柱3D模型.html`` 中命中 **0** 次，原写法 ``ic[0]`` 直接 IndexError）。
    本函数只保留**仍然内联**的那一块：LOC_CLAMP。"""
    _L = src.split(chr(10))
    def _blk(i):
        d = 0
        for j in range(i, len(_L) + 1):
            d += _L[j-1].count("{") - _L[j-1].count("}")
            if j > i and d <= 0:
                return chr(10).join(_L[i-1:j])
    i31 = next(j for j, x in enumerate(_L, 1) if "part(PT.LOC_CLAMP,function(){" in x)
    n31 = "  part(PT.LOC_CLAMP,function(){ __PLib.locClamp(0, cY, sd, locatorPose); });"
    return [(_blk(i31), n31)]


ANCHOR = 'function part(id,fn){'

RENAME = [
    # ★ 2026-09-28 落库同步：锚点按【当刻现读签名】更新 —— 交付件 boltAt 自 L857 起含第 6 参 shaftDiameter
    #   （库实现 P.boltAt(p,dir,r,len,col,shaftDiameter) 同名同序）⇒ 旧字面 0 命中（EXIT 2/ABORT）。
    #   仅更新锚点字面，注入/替换语义一字不动。
    ('function boltAt(p,dir,r,len,col,shaftDiameter){', 'function boltAt_orig(p,dir,r,len,col,shaftDiameter){'),
    ('function pipeClamp(center,axis,r,t,col,extra){', 'function pipeClamp_orig(center,axis,r,t,col,extra){'),
    ('function ears(center,axis,span,plateW,plateT,plateL,col){', 'function ears_orig(center,axis,span,plateW,plateT,plateL,col){'),
    ('function rodInsulator(from,to,metalCol){', 'function rodInsulator_orig(from,to,metalCol){'),
    ('function extrudeProf(p0,p1,prof,segsPer,col,cap){', 'function extrudeProf_orig(p0,p1,prof,segsPer,col,cap){'),
    ('function strandCable(p0,p1,r,col,nStrand,twist,opt){', 'function strandCable_orig(p0,p1,r,col,nStrand,twist,opt){'),
    ('function uBoltClamp(center,axis,open,span,barR,depth,col,colNut,rObj){', 'function uBoltClamp_orig(center,axis,open,span,barR,depth,col,colNut,rObj){'),
    ('function flatEnd(p0,p1,thick,wid,col){', 'function flatEnd_orig(p0,p1,thick,wid,col){'),
    ('function discInsulator(from,to,n,col){', 'function discInsulator_orig(from,to,n,col){'),
    # 第二批（t11/t12 锚段与附加悬挂算子）
    # ★ t155（落码工程师2，队长裁②「只修锚点、语义不动」）：`pulleyBlock` 签名自 t149 起含可选参数
    #   `reachY` ⇒ 旧字面 0 命中（EXIT 2/ABORT）；本行按**当刻现读签名**同步（替换语义不变）。
    ('function pulleyBlock(center,axis,rBig,rSmall,nRope,col,reachY){', 'function pulleyBlock_orig(center,axis,rBig,rSmall,nRope,col,reachY){'),
    ('function angleSteel(p0,p1,leg1,leg2,thick,col,sgn){', 'function angleSteel_orig(p0,p1,leg1,leg2,thick,col,sgn){'),
    ('function weightStack(p0,p1,n,shape,col){', 'function weightStack_orig(p0,p1,n,shape,col){'),
    ('function guyAnchor(p,dir,plateW,legR,col){', 'function guyAnchor_orig(p,dir,plateW,legR,col){'),
    ('function addBracket(p0,dir,len,legA,legB,thick,col){', 'function addBracket_orig(p0,dir,len,legA,legB,thick,col){'),
    ('function addHanger(p0,dir,ringR,rodR,col,nrm){', 'function addHanger_orig(p0,dir,ringR,rodR,col,nrm){'),
    ('function addSaddle(ringC,ringR,axis,open,wireR,col){', 'function addSaddle_orig(ringC,ringR,axis,open,wireR,col){'),
    ('function pinInsulator(p0,p1,col){', 'function pinInsulator_orig(p0,p1,col){'),
    # ★ t99：咬槽族（t93 终态）
    ('function splitClampM(center, halfLen, boltDx, rObj){', 'function splitClampM_orig(center, halfLen, boltDx, rObj){'),
    # ★ t268（2026-09-28）：咬槽族已由 t150 起的统一算子 `jointClamp` 承载 ⇒ 按**同一注入机制**接管：
    #   交付件 `jointClamp` 定义改名保留为死代码，调用点**一字不动**，全部自动改走库实现。
    ('function jointClamp(id,wireId,seat,eyeOffset,attachSign,centerlineSeat){',
     'function jointClamp_orig(id,wireId,seat,eyeOffset,attachSign,centerlineSeat){'),
]

PRELUDE = """

/* ===== 零件算子库注入（t120 惰性取表：避免在 C 生效前急行求值）===== */
function __PShimGet(){ return {withM:withM, frameY:frameY, xfP:xfP, m4tr:m4tr, cylY:cylY, tube:tube,
  boxAt:boxAt, quad:quad, tri:tri,
  polyTube:(typeof polyTube!=='undefined'?polyTube:null),
  hexa:(typeof hexa!=='undefined'?hexa:null), loftY:loftY, sphereAt:sphereAt,
  quadNC:(typeof quadNC!=='undefined'?quadNC:null),
  /* ★ t268：`jointClamp` 移植所需的网关（惰性取值，免受 var 赋值顺序影响） */
  part:part, taperedTube:taperedTube, annulusTube:annulusTube, PT:PT,
  instLast:function(){ return AUDIT_INSTANCES[AUDIT_INSTANCES.length-1]; },
  buf:function(){ return BUF; },
  auditCtxGet:function(){ return AUDIT_SUPPORT_CTX; },
  auditCtxSet:function(v){ AUDIT_SUPPORT_CTX=v; },
  clampsPush:function(r){ AUDIT_CLAMPS.push(r); },
  pointMeshDistance:auditPointMeshDistance}; }
var __PLib = null;
function __PLibGet(){ if(!__PLib){ __PLib = PARTS.createParts(__PShimGet(), C); } return __PLib; }
function __W(n){ return function(){ return __PLibGet()[n].apply(null, arguments); }; }
var boltAt=__W('boltAt'), pipeClamp=__W('pipeClamp'), ears=__W('ears'),
    rodInsulator=__W('rodInsulator'), extrudeProf=__W('extrudeProf'),
    strandCable=__W('strandCable'), uBoltClamp=__W('uBoltClamp'),
    flatEnd=__W('flatEnd'), discInsulator=__W('discInsulator'),
    pulleyBlock=__W('pulleyBlock'), angleSteel=__W('angleSteel'),
    weightStack=__W('weightStack'), guyAnchor=__W('guyAnchor'),
    addBracket=__W('addBracket'), addHanger=__W('addHanger'),
    addSaddle=__W('addSaddle'), pinInsulator=__W('pinInsulator'),
    splitClampM=__W('splitClampM'), locClamp=__W('locClamp'),
    dropClampC=__W('dropClampC'), dropClampM=__W('dropClampM'),
    jointClamp=__W('jointClamp');
/* ===== 注入结束 ===== */
"""


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


BUF_JS = """(w) => {
  const B = window.__CAT.BUFget(); const f = Float64Array.from(B[w]);
  const u = new Uint8Array(f.buffer); let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
  return btoa(s);
}"""


def main():
    if not os.path.exists(LIB):
        print('[ABORT] 缺 %s' % LIB)
        sys.exit(2)
    src = open(SRC, encoding='utf-8').read()
    lib = open(LIB, encoding='utf-8').read()

    A = src.replace(EXPOSE_OLD, EXPOSE_NEW)
    if A == src:
        print('[ABORT] EXPOSE 注入点未命中')
        sys.exit(2)

    L = src
    for old, new in RENAME:
        if L.count(old) != 1:
            print('[ABORT] 重命名目标出现 %d 次（应为 1）：%s' % (L.count(old), old))
            sys.exit(2)
        L = L.replace(old, new)
    if L.count(ANCHOR) != 1:
        print('[ABORT] 插入锚点出现 %d 次（应为 1）' % L.count(ANCHOR))
        sys.exit(2)
    L = L.replace(ANCHOR, lib + '\n' + PRELUDE + '\n' + ANCHOR)
    for __old, __new in build_block_subs(src):   # ★ t99：内联块几何 → 库算子调用
        if L.count(__old) != 1:
            print('[ABORT] t99 块替换目标出现 %d 次（应为 1）' % L.count(__old))
            sys.exit(2)
        L = L.replace(__old, __new)
    if '--negctl' in sys.argv:   # ★ t120 负控：把注入文本里的算子参数改错 1 mm ⇒ 判红'
        _n = lib.replace('cy+0.017450', 'cy+0.018450', 1)
        if _n == lib:
            print('[ABORT] 负控扰动未命中（lib 内未找到目标字面）'); sys.exit(2)
        lib = _n
        print('[NEGCTL] 已把注入库 locClamp 片体中心扰动 +0.001 m ⇒ 顶点比对应判红')

    if '--negctl' in sys.argv:   # t120 负控：直接扰动注入版 L 的字面 ⇒ 顶点点位当差
        _c = L.count('cy+0.017450')
        L = L.replace('cy+0.017450', 'cy+0.018450', 1)
        print('[NEGCTL] L 扰动 hits=%d' % _c)
    L = L.replace(EXPOSE_OLD, EXPOSE_NEW)

    fa = os.path.join(OUT, '_libtest_A.html')
    fl = os.path.join(OUT, '_libtest_L.html')
    open(fa, 'w', encoding='utf-8', newline='').write(A)
    open(fl, 'w', encoding='utf-8', newline='').write(L)
    print('基线  : %s' % fa)
    print('注入库: %s  （+%d B）' % (fl, len(L) - len(A)))

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
        for tag, fn in (('A', fa), ('L', fl)):
            pg = br.new_page(viewport={'width': 1200, 'height': 800})
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto('http://127.0.0.1:%d/%s' % (port, quote('算子/零件算子/' + os.path.basename(fn))),
                    wait_until='load')
            pg.wait_for_timeout(2400)
            res[tag] = {'_errors': errs[:6]}
            for col in ['M', 'X', 'A']:
                pg.evaluate("(c) => document.querySelector('[data-col=\"' + c + '\"]').click()", col)
                pg.wait_for_timeout(900)
                for w in ['p', 'n', 'c', 'i', 'e']:
                    raw = base64.b64decode(pg.evaluate(BUF_JS, w))
                    res[tag][col + '_' + w] = raw
            pg.close()
        br.close()
    httpd.shutdown()

    def arr(tag, col, w):
        raw = res[tag][col + '_' + w]
        return struct.unpack('<%dd' % (len(raw) // 8), raw)

    def arr32(tag, col, w):
        raw = res[tag][col + '_' + w]
        return struct.unpack('<%df' % (len(raw) // 4), raw)

    import math
    TOL = 2 * math.pow(2, -20)      # 2 ulp(8.75 m)，与 verify_migration 同口径

    def isna(v):
        return isinstance(v, float) and v != v

    print('\n' + '=' * 96)
    print('注入库 vs 基线 · 逐分量比对   TOL = %.2e m（2 个 float32 ulp @8.75 m）' % TOL)
    print('=' * 96)
    ok = True
    for col in ['M', 'X', 'A']:
        pa = arr('A', col, 'p'); pl = arr('L', col, 'p')
        import collections
        print('  %s : 顶点数 A=%-8d L=%-8d %s' % (col, len(pa)//3, len(pl)//3, '✅' if len(pa)==len(pl) else '✗ **长度不等 ⇒ 逐分量比对无意义**'))
        _ia = arr('A', col, 'i'); _il = arr('L', col, 'i')
        _ca = collections.Counter(_ia); _cl = collections.Counter(_il)
        if _ca != _cl:
            _d = sorted(set(_ca) | set(_cl))
            print('       逐件顶点数差异：' + ', '.join('%g:%d→%d' % (k, _ca.get(k, 0), _cl.get(k, 0)) for k in _d if _ca.get(k, 0) != _cl.get(k, 0)))
        else:
            print('       逐件顶点数：逐件相同 ✅')
        nd = sum(1 for x, y in zip(pa, pl) if x != y)
        dmax = max(abs(x - y) for x, y in zip(pa, pl))
        okp = dmax <= TOL
        # n / i / e 逐位
        same_fixed = {}
        for w in ['n', 'i', 'e']:
            a = arr('A', col, w); l = arr('L', col, w)
            same_fixed[w] = all(x == y for x, y in zip(a, l))
        # 颜色：应【只在原本 NaN 的顶点】不同
        ca = arr('A', col, 'c'); cl = arr('L', col, 'c')
        nanA = set(k for k, v in enumerate(ca) if isna(v))
        diffc = [k for k, (x, y) in enumerate(zip(ca, cl)) if not (x == y or (isna(x) and isna(y)))]
        offnan = [k for k in diffc if k not in nanA]
        okc = (len(offnan) == 0)
        oki = all(same_fixed.values())
        ok = ok and okp and okc and oki
        print('  %s : 位置 max|Δ|=%-11.3e (相异 %-7d) %s ｜ n/i/e 逐位 %s ｜ '
              '颜色相异 %-7d（其中【非原本 NaN】%d）%s'
              % (col, dmax, nd, '✅' if okp else '✗',
                 '✅' if oki else '✗', len(diffc), len(offnan), '✅' if okc else '✗'))
        print('        A 的 NaN 分量数 = %d；L 的 NaN 分量数 = %d'
              % (len(nanA), sum(1 for v in cl if isna(v))))

    print('\n  控制台错误：%s' % {t: res[t]['_errors'] for t in res})
    print('\n' + '=' * 96)
    if ok:
        print('  ⇒ 判定：**零件算子库与交付件等价** ——')
        print('     位置差 ≤ 2 个 float32 ulp；n/i/e 逐位相同；')
        print('     颜色差异【全部落在原本为 NaN 的顶点上】= 正是库版修好的 L736 缺陷。')
    else:
        print('  ⇒ 判定：★ 不等价 —— 移植有实质偏差，须逐项排查。')
    print('=' * 96)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
