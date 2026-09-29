/* ================================================================================
 * 接触网 3D 零件库 —— 几何算子核心  geom.js
 * --------------------------------------------------------------------------------
 * 目标：为「可复用零部件资产 / 像搭积木一样拼装」提供一层【语义正确、可独立测试】
 *       的几何算子底座。零依赖，node 与浏览器通用。
 *
 * ★ 本文件【不碰交付件】《接触网中间柱3D模型.html》。它是新架构的第一块砖。
 *
 * --------------------------------------------------------------------------------
 * 一、要解决的根本问题：`withM` 是【替换】而非【叠加】
 * --------------------------------------------------------------------------------
 * 现行 HTML（L450）：
 *     function withM(m,fn){ var o=MAT; MAT=m; fn(); MAT=o; }
 * ⇒ 任何 `withM` **丢弃外层帧**。于是「在帧内调用算子」的语义就是错的，
 *   而代码里到处靠**人工规避**（把点先 xfP 升到世界、或临时 MAT=null）来绕开。
 *
 * 现行存在【三套互不相同的绕过手法】，运气各不相同：
 *   | 算子        | 绕过手法                          | 在帧内调用 |
 *   |-------------|-----------------------------------|-----------|
 *   | `tube`      | 无（直接 withM(frameY(p0,p1))）   | ★ 错 —— 局部点被当世界点，管子跑到世界原点附近 |
 *   | `sphereAt`  | 先 xfP 升世界 + withM(m4tr(wc))   | 侥幸对（球对旋转不敏感，掩盖了错误） |
 *   | `polyTube`  | D25 补丁：先 xfP + 临时 MAT=null  | 对，但属**打补丁**而非修根 |
 *
 * ★ 三套手法 = 三种运气。**只要修根，三种全部自动正确。**
 *
 * --------------------------------------------------------------------------------
 * 二、修法（本文件）
 * --------------------------------------------------------------------------------
 *     MAT = (MAT === null) ? m : mul(MAT, m)
 *
 * 数学依据（列主序、列向量约定，与现行 `m4mul` 一致）：
 *   `m4mul(a,b)` 实现 `o[r][c] = Σ_k a[r][k]*b[k][c]`，即 o = A·B。
 *   令 P 为父帧、F 为子帧（均为刚体 [R|t]，R 正交、比例 1），则
 *       (P·F)·(0,L,0) = R_P·(R_F·(0,L,0)) + R_P·t_F + t_P
 *                     = R_P·(t_F + L·dir_F) + t_P
 *                     = R_P·(p1_local) + t_P            (因 F·(0,L,0)=p1_local)
 *                     = P·p1_local                       ∎
 *   ⇒ `P·frameY(a,b)` **正是**变换后线段的世界帧 ⇒ 段体/端球自动跟随父帧。
 *   （绕轴滚转 roll 不影响：`cylY` 与端球对轴向滚转各向同性。）
 *
 * ★ 顶层调用（MAT===null）走 `MAT = m` 分支，**不乘、不分配** ⇒ 与旧实现
 *   **逐位相同**（见 test_geom.js 用例 A/D）。这是"改架构不改外观"的硬保证。
 *
 * --------------------------------------------------------------------------------
 * 三、顺带修掉的两个隐患
 * --------------------------------------------------------------------------------
 *   ① `try/finally`：旧写法 `fn()` 抛异常会**永久污染 MAT**（本会话 D26 的
 *      `C` 遮蔽全局调色板就抛过 `TypeError`，抛点之后 MAT 全错）。
 *      新写法异常路径下 MAT/DEPTH/池指针必然复位。
 *   ② **无模块级可变状态**：全部状态封装在 `createGeom()` 返回的实例里。
 *      旧代码的 `BUF/MAT/CUR_ID/CUR_EXP` 都是模块级单例 ⇒ 同时只能建一个场景。
 *      多柱/多场景需要多个实例。
 *
 * --------------------------------------------------------------------------------
 * 四、用法
 * --------------------------------------------------------------------------------
 *   node:   const g = require('./geom.js').createGeom();      // 栈语义（正式）
 *           const L = require('./geom.js').createGeom({legacy:true}); // 旧语义（仅供差分测试）
 *   browser: <script src="geom.js"></script>  →  window.GEOM.createGeom()
 *
 *   一个实例即一个「几何场景」：
 *       g.reset(); g.setId(7,[0,0,0]);
 *       g.withM(g.frameY([0,0,0],[0,1,0]), () => { g.tube(...); });
 *       g.buf.p / .n / .c / .i / .e   ← 与现行 HTML 的 BUF **完全同构**
 * ================================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GEOM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================== 矩阵（与现行 HTML 逐位一致） ============================== */
  function m4ident() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  /* o = A·B（列主序，列向量）—— 与现行 HTML L395 同一表达式，未改一字 */
  function m4mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  /* 写入版：o 必须与 a、b **不同一**（调用方保证） */
  function mulInto(o, a, b) {
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  function m4tr(x, y, z) { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); }
  function m4persp(fovy, asp, n, f) {
    var t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
    return o;
  }
  function m4ortho(l, r, b, t, n, f) {
    var o = new Float32Array(16);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
    return o;
  }
  function m4lookAt(e, c, up) {
    var zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    var zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  /* 以 p0→p1 为局部 +Y 轴的刚体帧；平移 = p0 —— 与现行 HTML L419 同一实现 */
  function frameY(p0, p1) {
    var yx = p1[0] - p0[0], yy = p1[1] - p0[1], yz = p1[2] - p0[2];
    var L = Math.hypot(yx, yy, yz) || 1; yx /= L; yy /= L; yz /= L;
    var ux = 0, uy = 0, uz = 1;
    if (Math.abs(yz) > 0.985) { ux = 1; uy = 0; uz = 0; }
    var xx = uy * yz - uz * yy, xy = uz * yx - ux * yz, xz = ux * yy - uy * yx;
    var XL = Math.hypot(xx, xy, xz) || 1; xx /= XL; xy /= XL; xz /= XL;
    var zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
    return new Float32Array([xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, p0[0], p0[1], p0[2], 1]);
  }

  /* ============================== 实例工厂 ============================== */
  function createGeom(opt) {
    opt = opt || {};
    var LEGACY = !!opt.legacy;          // 仅供差分测试：复现旧「替换」语义
    var g = {};

    /* --- 状态（全部实例私有；旧代码是模块级单例） --- */
    var MAT = null, DEPTH = 0, CUR_ID = 0, CUR_EXP = [0, 0, 0], BUF = null;
    var POOL = [], PN = 0;              // 嵌套帧的临时矩阵池 ⇒ 稳态零分配
    var HOOK = null, PEAK = 0;

    g.m4ident = m4ident; g.m4mul = m4mul; g.m4tr = m4tr;
    g.m4persp = m4persp; g.m4ortho = m4ortho; g.m4lookAt = m4lookAt; g.frameY = frameY;

    g.reset = function () { if (DEPTH) throw new Error('reset: cannot reset an active transform scope'); BUF = { p: [], n: [], c: [], i: [], e: [] }; MAT = null; PN = 0; DEPTH = 0; PEAK = 0; CUR_ID = 0; CUR_EXP = [0, 0, 0]; return g; };
    g.buf = function () { return BUF; };
    g.mat = function () { return MAT; };
    g.depth = function () { return DEPTH; };
    g.peak = function () { return PEAK; };
    g.poolInUse = function () { return PN; };
    g.setId = function (id, exp) { CUR_ID = id; CUR_EXP = exp ? [exp[0], exp[1], exp[2]] : [0, 0, 0]; return g; };
    g.setHook = function (h) { HOOK = h; return g; };
    g.stats = function () { return { verts: BUF ? BUF.p.length / 3 : 0, tris: BUF ? BUF.p.length / 9 : 0, peakDepth: PEAK, poolSize: POOL.length }; };

    /* ---------------------------------------------------------------
     * ★ 核心：withM
     *   栈语义（正式）：MAT = MAT ? mul(MAT,m) : m
     *   旧语义（legacy）：MAT = m          —— 仅用于证明"顶层逐位不变"
     * --------------------------------------------------------------- */
    function withM(m, fn) {
      var o = MAT, used = 0;
      if (LEGACY) {
        /* ★ legacy 分支必须**忠实复现旧实现的行为**，否则负控就是假的：
             旧代码  function withM(m,fn){ var o=MAT; MAT=m; fn(); MAT=o; }
           两个特征缺一不可 —— ①替换语义 ②**无 try/finally**（异常永久污染 MAT）。
           DEPTH/PEAK 仅仅是为了让审计钩子能用，不改变上述两点。
           （首版我误把 try/finally 放到本分支外面 ⇒ legacy 也成了异常安全的 ⇒
             用例 C6 负控失效。此注释即该缺陷的墓碑。） */
        MAT = m; DEPTH++; if (DEPTH > PEAK) PEAK = DEPTH;
        if (HOOK) HOOK(DEPTH, m, MAT);
        var r = fn();
        DEPTH--; MAT = o; return r;
      }
      if (o === null) {
        MAT = m;                          // 顶层：直接采用，零分配 —— 与旧实现逐位相同
      } else {
        var s = (PN < POOL.length) ? POOL[PN] : (POOL.push(new Float32Array(16)), POOL[PN]);
        PN++; used = 1;
        mulInto(s, o, m);                 // s = 父帧 · 子帧
        MAT = s;
      }
      DEPTH++; if (DEPTH > PEAK) PEAK = DEPTH;
      try { if (HOOK) HOOK(DEPTH, m, MAT); return fn(); }
      finally { DEPTH--; MAT = o; if (used) PN--; }   // ★ 异常路径也必然复位
    }
    g.withM = withM;

    g.xfP = function (p) {
      if (!MAT) return p; var m = MAT;
      return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
              m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
              m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    };
    g.xfN = function (n) {
      if (!MAT) return n; var m = MAT;
      return [m[0] * n[0] + m[4] * n[1] + m[8] * n[2],
              m[1] * n[0] + m[5] * n[1] + m[9] * n[2],
              m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
    };

    /* ============================== 顶点输出 ============================== */
    function vpush(p, n, c) {
      BUF.p.push(p[0], p[1], p[2]); BUF.n.push(n[0], n[1], n[2]);
      BUF.c.push(c[0], c[1], c[2], c.length > 3 ? c[3] : 1);
      BUF.i.push(CUR_ID);
      BUF.e.push(CUR_EXP[0], CUR_EXP[1], CUR_EXP[2]);
    }
    g.vpush = vpush;

    function tri(a, b, c, col) {
      a = g.xfP(a); b = g.xfP(b); c = g.xfP(c);
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.hypot(nx, ny, nz) || 1, n = [nx / L, ny / L, nz / L];
      vpush(a, n, col); vpush(b, n, col); vpush(c, n, col);
    }
    function quad(a, b, c, d, col) { tri(a, b, c, col); tri(a, c, d, col); }
    function quadNC(a, b, c, d, na, nb, nc, nd, col) {
      var A = g.xfP(a), B = g.xfP(b), C2 = g.xfP(c), D = g.xfP(d);
      var NA = g.xfN(na), NB = g.xfN(nb), NC = g.xfN(nc), ND = g.xfN(nd);
      vpush(A, NA, col); vpush(B, NB, col); vpush(C2, NC, col);
      vpush(A, NA, col); vpush(C2, NC, col); vpush(D, ND, col);
    }
    function quadC(a, b, c, d, ca, cb, cc, cd) {
      var A = g.xfP(a), B = g.xfP(b), C2 = g.xfP(c), D = g.xfP(d);
      var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      var vx = C2[0] - A[0], vy = C2[1] - A[1], vz = C2[2] - A[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.hypot(nx, ny, nz) || 1, n = [nx / L, ny / L, nz / L];
      vpush(A, n, ca); vpush(B, n, cb); vpush(C2, n, cc);
      vpush(A, n, ca); vpush(C2, n, cc); vpush(D, n, cd);
    }
    function hexa(c, col) {
      quad(c[0], c[3], c[2], c[1], col); quad(c[4], c[5], c[6], c[7], col);
      quad(c[0], c[1], c[5], c[4], col); quad(c[2], c[3], c[7], c[6], col);
      quad(c[3], c[0], c[4], c[7], col); quad(c[1], c[2], c[6], c[5], col);
    }
    function boxAt(cx, cy, cz, hx, hy, hz, col) {
      hexa([
        [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz],
        [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]
      ], col);
    }
    function loftY(prof0, y0, prof1, y1, segs, col) {
      var n = prof0.length, i, j, k;
      for (k = 0; k < segs; k++) {
        var t0 = k / segs, t1 = (k + 1) / segs, ya = y0 + (y1 - y0) * t0, yb = y0 + (y1 - y0) * t1;
        var A = [], B = [];
        for (i = 0; i < n; i++) {
          var a = prof0[i], b = prof1[i];
          A.push([a[0] + (b[0] - a[0]) * t0, ya, a[1] + (b[1] - a[1]) * t0]);
          B.push([a[0] + (b[0] - a[0]) * t1, yb, a[1] + (b[1] - a[1]) * t1]);
        }
        for (i = 0; i < n; i++) { j = (i + 1) % n; quad(A[i], A[j], B[j], B[i], col); }
      }
      for (k = 0; k < 2; k++) {
        var pr = k ? prof1 : prof0, yy = k ? y1 : y0;
        for (i = 1; i < n - 1; i++)
          tri([pr[0][0], yy, pr[0][1]], [pr[i][0], yy, pr[i][1]], [pr[i + 1][0], yy, pr[i + 1][1]], col);
      }
    }
    function cylY(r0, r1, y0, y1, segs, col, caps, colCap) {
      var h = y1 - y0, dr = r0 - r1, i;
      colCap = colCap || col;
      for (i = 0; i < segs; i++) {
        var a0 = i / segs * 6.283185307, a1 = (i + 1) / segs * 6.283185307;
        var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        var n0 = [c0 * h, dr, s0 * h], n1 = [c1 * h, dr, s1 * h];
        var l0 = Math.hypot(n0[0], n0[1], n0[2]) || 1; n0 = [n0[0] / l0, n0[1] / l0, n0[2] / l0];
        var l1 = Math.hypot(n1[0], n1[1], n1[2]) || 1; n1 = [n1[0] / l1, n1[1] / l1, n1[2] / l1];
        quadNC([r0 * c0, y0, r0 * s0], [r0 * c1, y0, r0 * s1], [r1 * c1, y1, r1 * s1], [r1 * c0, y1, r1 * s0],
               n0, n1, n1, n0, col);
      }
      if (caps) {
        for (i = 0; i < segs; i++) {
          var b0 = i / segs * 6.283185307, b1 = (i + 1) / segs * 6.283185307;
          if (r0 > 1e-6) {
            var p0 = [r0 * Math.cos(b0), y0, r0 * Math.sin(b0)], p1 = [r0 * Math.cos(b1), y0, r0 * Math.sin(b1)];
            vpush(g.xfP([0, y0, 0]), g.xfN([0, -1, 0]), colCap);
            vpush(g.xfP(p1), g.xfN([0, -1, 0]), colCap);
            vpush(g.xfP(p0), g.xfN([0, -1, 0]), colCap);
          }
          if (r1 > 1e-6) {
            var q0 = [r1 * Math.cos(b0), y1, r1 * Math.sin(b0)], q1 = [r1 * Math.cos(b1), y1, r1 * Math.sin(b1)];
            vpush(g.xfP([0, y1, 0]), g.xfN([0, 1, 0]), colCap);
            vpush(g.xfP(q0), g.xfN([0, 1, 0]), colCap);
            vpush(g.xfP(q1), g.xfN([0, 1, 0]), colCap);
          }
        }
      }
    }
    /* ---- tube：与现行 HTML **同一实现**；差别只在 withM 语义已修根 ⇒ 帧内自动正确 ---- */
    function tube(p0, p1, r, segs, col, caps) {
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6) return;
      withM(frameY(p0, p1), function () { cylY(r, r, 0, L, segs, col, caps !== false, col); });
    }
    /* ---- sphereAt：★ 去掉"先 xfP 升世界 + m4tr"的绕过手法 ----
       旧版靠"球对旋转不敏感"侥幸正确，本质是把父帧**主动丢弃**再手算补偿。
       新版直接把球心当**局部坐标**交给栈 —— 语义正确，且顶层逐位不变
       （顶层 xfP 返回原数组 ⇒ 旧版 wc≡[cx,cy,cz] ⇒ m4tr 参数完全一致）。 */
    function sphereAt(cx, cy, cz, r, col, segs) {
      segs = segs || 10;
      var rings = Math.max(4, Math.round(segs / 2));
      withM(m4tr(cx, cy, cz), function () {
        for (var i = 0; i < rings; i++) {
          var t0 = i / rings * Math.PI, t1 = (i + 1) / rings * Math.PI;
          for (var j = 0; j < segs; j++) {
            var a0 = j / segs * 6.283185307, a1 = (j + 1) / segs * 6.283185307;
            var P1 = function (t, a) { return [r * Math.sin(t) * Math.cos(a), r * Math.cos(t), r * Math.sin(t) * Math.sin(a)]; };
            var N1 = function (t, a) { return [Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)]; };
            quadNC(P1(t0, a0), P1(t0, a1), P1(t1, a1), P1(t1, a0),
                   N1(t0, a0), N1(t0, a1), N1(t1, a1), N1(t1, a0), col);
          }
        }
      });
    }
    /* ---- polyTube：★ 撤掉 D25 补丁（"先 xfP 世界化 + 临时 MAT=null"）----
       那个补丁是**为了绕开替换语义**而存在的；语义修根之后它反而会**双重变换**。
       新版回到最自然的写法：局部坐标直接交给栈。
       D25 的等价性结论仍成立（顶层调用逐位不变，见 test 用例 D）。 */
    function polyTube(pts, r, segs, col) {
      var i;
      for (i = 0; i < pts.length - 1; i++) {
        (function (a, b) {
          var L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          if (L < 1e-6) return;
          withM(frameY(a, b), function () { cylY(r, r, 0, L, segs, col, false, col); });
        })(pts[i], pts[i + 1]);
      }
      sphereAt(pts[0][0], pts[0][1], pts[0][2], r, col, 8);
      var L2 = pts[pts.length - 1];
      sphereAt(L2[0], L2[1], L2[2], r, col, 8);
    }

    g.tri = tri; g.quad = quad; g.quadNC = quadNC; g.quadC = quadC;
    g.hexa = hexa; g.boxAt = boxAt; g.loftY = loftY; g.cylY = cylY;
    g.tube = tube; g.sphereAt = sphereAt; g.polyTube = polyTube;

    g.reset();
    return g;
  }

  return { createGeom: createGeom, m4mul: m4mul, frameY: frameY, m4tr: m4tr };
});
