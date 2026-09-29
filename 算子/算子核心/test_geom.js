/* ================================================================================
 * geom.js 验收测试  test_geom.js     运行：  node 算子/算子核心\test_geom.js
 * --------------------------------------------------------------------------------
 * 判据设计三问（SPEC §7）：
 *   ① 能红吗？—— 用例 B/C/F 均内置【负控】：用 legacy 实现跑同一条断言，**必须失败**。
 *                 若负控也"通过"，说明该断言恒真 ⇒ 是假断言 ⇒ 本测试自己报错。
 *   ② 目标可达吗？—— 全部目标值为**闭式手算值**，非"跑一遍记下来"的记录值。
 *   ③ 施加对象正确吗？—— A/D 比对的是**顶点缓冲逐位**，不是"看起来差不多"。
 *
 * 用例：
 *   A  顶层调用：栈语义 vs 旧语义，顶点缓冲【逐位全等】（改架构不改外观的硬保证）
 *   B  嵌套调用：帧内 tube 的世界几何 = 闭式值；★负控：legacy 必须失败
 *   C  异常路径：嵌套中抛异常后 MAT/DEPTH/池指针必然复位；★负控：legacy 必然泄漏
 *   D  算子级逐位等价：tube / sphereAt / polyTube 三个"绕过手法"顶层逐位不变
 *   E  深层嵌套：三层平移复合 = (1,1,1)；峰值深度与池回收正确
 *   F  矩阵恒等式：P·frameY(a,b) ≡ frameY(P·a, P·b) 的端点映射；★负控：故意漏乘必须失败
 * ================================================================================ */
'use strict';
var path = require('path');
var GEOM = require(path.join(__dirname, 'geom.js'));

var PASS = 0, FAIL = 0, NOTES = [];
function ok(cond, label, detail) {
  if (cond) { PASS++; console.log('  \u2713 ' + label + (detail ? '   ' + detail : '')); }
  else { FAIL++; console.log('  \u2717 ' + label + (detail ? '   ' + detail : '')); }
}
function head(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function f(x) { return (Math.round(x * 1e6) / 1e6).toFixed(6); }

var COL = [0.5, 0.5, 0.5];

/* ---------- 公共：顶层场景（全部调用发生在 MAT===null，即"顶层"） ---------- */
function buildTopLevelScene(g) {
  g.reset();
  g.setId(1, [0, 0, 0]);
  g.boxAt(0, 0, 0, 0.5, 0.3, 0.2, COL);
  g.tube([0, 0, 0], [1, 2, 3], 0.05, 8, COL, true);
  g.sphereAt(1, 2, 3, 0.1, COL, 10);
  g.polyTube([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], 0.03, 6, COL);
  g.cylY(0.10, 0.08, 0, 1, 12, COL, true, [0.5, 0.5, 0.5]);
  g.loftY([[0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1], [0.1, -0.1]], 0,
          [[0.05, 0.05], [-0.05, 0.05], [-0.05, -0.05], [0.05, -0.05]], 1, 3, COL);
  g.setId(2, [0, 0, 0]);
  g.withM(g.m4tr(3, 0, 0), function () {           /* 顶层 withM：必须是"采用"而非"相乘" */
    g.boxAt(0, 0, 0, 0.2, 0.2, 0.2, COL);
  });
  return g;
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;   /* 逐位，非近似 */
  return true;
}
function bufsEqual(A, B) {
  return arraysEqual(A.p, B.p) && arraysEqual(A.n, B.n) &&
         arraysEqual(A.c, B.c) && arraysEqual(A.i, B.i) && arraysEqual(A.e, B.e);
}

/* ================================ A ================================ */
head('A  顶层调用：栈语义 vs 旧语义 —— 顶点缓冲【逐位全等】');
(function () {
  var S = buildTopLevelScene(GEOM.createGeom()).buf();               /* 栈语义（正式） */
  var L = buildTopLevelScene(GEOM.createGeom({ legacy: true })).buf();/* 旧语义（对照） */
  var nv = S.p.length / 3;
  ok(nv > 0, 'A1 场景非空', '顶点 ' + nv + ' / 三角 ' + (S.p.length / 9));
  ok(S.p.length === L.p.length, 'A2 顶点数一致', S.p.length / 3 + ' vs ' + L.p.length / 3);
  ok(arraysEqual(S.p, L.p), 'A3 位置逐位全等');
  ok(arraysEqual(S.n, L.n), 'A4 法线逐位全等');
  ok(arraysEqual(S.c, L.c), 'A5 颜色逐位全等');
  ok(arraysEqual(S.i, L.i), 'A6 零件 ID 逐位全等');
  ok(arraysEqual(S.e, L.e), 'A7 拾取/展开 逐位全等');
  ok(bufsEqual(S, L), 'A8 ★ 整缓冲逐位全等（改架构不改外观的硬保证）');
})();

/* ================================ B ================================ */
head('B  嵌套调用：帧内 tube 的世界几何 = 闭式值   ★含负控');
/* 闭式推导：P = frameY([0,0,0],[0,0,1]) ⇒ 局部 +Y 映射到世界 +Z。
   在 P 内建 tube([0,0,0],[0,1,0], r=0.1) ⇒ 世界轴线应为 (0,0,0)→(0,0,1)。
   ⇒ 全部顶点应满足 max hypot(x,y) = 0.1；z 只有 {0,1} 两个取值。 */
function probeNestedTube(g) {
  g.reset(); g.setId(1, [0, 0, 0]);
  g.withM(g.frameY([0, 0, 0], [0, 0, 1]), function () {
    g.tube([0, 0, 0], [0, 1, 0], 0.1, 6, COL, true);
  });
  var p = g.buf().p, zs = {}, maxr = 0, zmin = 1e9, zmax = -1e9;
  for (var i = 0; i < p.length; i += 3) {
    var r = Math.hypot(p[i], p[i + 1]);
    if (r > maxr) maxr = r;
    zs[p[i + 2].toFixed(9)] = 1;
    if (p[i + 2] < zmin) zmin = p[i + 2];
    if (p[i + 2] > zmax) zmax = p[i + 2];
  }
  return { maxr: maxr, zmin: zmin, zmax: zmax, ndistinctZ: Object.keys(zs).length, nv: p.length / 3 };
}
(function () {
  var s = probeNestedTube(GEOM.createGeom());
  ok(Math.abs(s.maxr - 0.1) < 1e-9, 'B1 世界径向最大半径 = 0.1', 'maxr=' + f(s.maxr));
  ok(Math.abs(s.zmin - 0) < 1e-9 && Math.abs(s.zmax - 1) < 1e-9,
     'B2 世界 z 跨度 = [0,1]（轴向指向 +Z）', 'z=[' + f(s.zmin) + ',' + f(s.zmax) + ']');
  ok(s.ndistinctZ === 2, 'B3 z 只有两个取值 {0,1}（= 带端盖的直管）', 'distinct=' + s.ndistinctZ);

  /* ★ 负控：旧语义必须在此断言上失败 —— 否则 B 是假断言 */
  var l = probeNestedTube(GEOM.createGeom({ legacy: true }));
  var legacyFails = !(Math.abs(l.zmin - 0) < 1e-9 && Math.abs(l.zmax - 1) < 1e-9);
  ok(legacyFails, 'B4 ★负控：旧语义在同一断言上【必须失败】（否则 B 恒真=假断言）',
     'legacy z=[' + f(l.zmin) + ',' + f(l.zmax) + ']  ⇒ 轴向被丢帧、指向 +Y 而非 +Z');
})();

/* ================================ C ================================ */
head('C  异常路径：嵌套中抛异常后状态必然复位   ★含负控');
function probeThrow(g) {
  var threw = false;
  try {
    g.withM(g.m4tr(1, 0, 0), function () {
      g.withM(g.m4tr(0, 2, 0), function () {
        g.boxAt(0, 0, 0, 1, 1, 1, COL);
        throw new Error('INJECTED');
      });
    });
  } catch (e) { threw = (e.message === 'INJECTED'); }
  return { threw: threw, matNull: g.mat() === null, depth: g.depth(), pool: g.poolInUse(), peak: g.peak() };
}
(function () {
  var s = probeThrow(GEOM.createGeom());
  ok(s.threw, 'C1 注入异常已抛出（说明确实走到了嵌套里层）');
  ok(s.matNull, 'C2 异常后 MAT 复位为 null');
  ok(s.depth === 0, 'C3 异常后 DEPTH 归零', 'depth=' + s.depth);
  ok(s.pool === 0, 'C4 异常后矩阵池指针归零（否则池会泄漏至耗尽）', 'PN=' + s.pool);
  ok(s.peak === 2, 'C5 峰值深度记录正确 = 2', 'peak=' + s.peak);

  var l = probeThrow(GEOM.createGeom({ legacy: true }));
  var legacyLeaks = !(l.matNull && l.depth === 0 && l.pool === 0);
  ok(legacyLeaks, 'C6 ★负控：旧语义在同一断言上【必须失败】',
     'legacy MAT=' + (l.matNull ? 'null' : '非null') + ' depth=' + l.depth + ' pool=' + l.pool);
})();

/* ================================ D ================================ */
head('D  算子级逐位等价：三个"绕过手法"在顶层必须完全不变');
(function () {
  var cases = [
    ['tube',      function (g) { g.tube([1, 2, 3], [4, 1, 0], 0.07, 9, COL, true); }],
    ['sphereAt',  function (g) { g.sphereAt(0.3, 1.7, -2.2, 0.12, COL, 12); }],
    ['polyTube',  function (g) { g.polyTube([[0, 0, 0], [1, 0.5, 0], [1, 1, 1], [2, 1, 1]], 0.04, 7, COL); }],
    ['polyTube帧内', function (g) { g.withM(g.m4tr(0, 5, 0), function () { g.polyTube([[0, 0, 0], [1, 0, 0]], 0.04, 6, COL); }); }]
  ];
  cases.forEach(function (c, k) {
    var gs = GEOM.createGeom(); gs.reset(); gs.setId(1, [0, 0, 0]); c[1](gs);
    var gl = GEOM.createGeom({ legacy: true }); gl.reset(); gl.setId(1, [0, 0, 0]); c[1](gl);
    var same = bufsEqual(gs.buf(), gl.buf());
    /* 前三个是"顶层"调用，必须逐位相同；第 4 个是帧内调用 ⇒ 本就应当【不同】（旧的是错的） */
    var expectSame = (k < 3);
    ok(expectSame ? same : !same,
       'D' + (k + 1) + ' ' + c[0] + (expectSame ? ' 顶层逐位全等' : ' 帧内【应当不同】（旧的是错的）'),
       expectSame ? ('顶点 ' + gs.buf().p.length / 3) : '已确认语义修正生效');
  });
})();

/* ================================ E ================================ */
head('E  深层嵌套：三层平移复合与池回收');
(function () {
  var g = GEOM.createGeom(); g.reset(); g.setId(1, [0, 0, 0]);
  g.withM(g.m4tr(1, 0, 0), function () {
    g.withM(g.m4tr(0, 1, 0), function () {
      g.withM(g.m4tr(0, 0, 1), function () {
        g.boxAt(0, 0, 0, 0.1, 0.1, 0.1, COL);   /* 盒心应为世界 (1,1,1) */
      });
    });
  });
  var p = g.buf().p, cx = 0, cy = 0, cz = 0, n = p.length / 3;
  for (var i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
  ok(n === 36, 'E1 盒 = 6 面 × 6 顶点 = 36 顶点', '实际 ' + n);
  ok(Math.abs(cx / n - 1) < 1e-9 && Math.abs(cy / n - 1) < 1e-9 && Math.abs(cz / n - 1) < 1e-9,
     'E2 复合平移 = (1,1,1)（闭式手算）', '(' + f(cx / n) + ',' + f(cy / n) + ',' + f(cz / n) + ')');
  ok(g.peak() === 3, 'E3 峰值深度 = 3', 'peak=' + g.peak());
  ok(g.poolInUse() === 0, 'E4 池已完全回收', 'PN=' + g.poolInUse());
  ok(g.mat() === null, 'E5 退出后 MAT = null');
})();

/* ================================ F ================================ */
head('F  矩阵恒等式：P·frameY(a,b) 的端点映射   ★含负控');
(function () {
  var P = GEOM.m4mul(GEOM.m4tr(1, 2, 3), GEOM.frameY([0, 0, 0], [0.3, 1, -0.7]));
  var a = [0.2, -0.4, 0.9], b = [1.1, 0.6, -0.3];
  var L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  var F = GEOM.frameY(a, b);
  var M = GEOM.m4mul(P, F);
  function apply(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  /* ★★ 容差【由存储精度推导】，不是"调到绿"：
     矩阵存于 Float32Array（IEEE-754 binary32，24 位有效位）⇒ 单次乘加相对舍入
     eps = 2^-24 = 5.9605e-8。一条约 12 次乘加的点变换，前向误差界取 16·eps·|坐标量级|
     已是保守估计（16 覆盖链长与抵消）。
     ★ 自检该容差仍有判别力：负控误差 = 4.098949 ⇒ 比容差（~4e-6）大 **6 个数量级**
       ⇒ F1 绝非恒真。（若容差放到与负控同量级，F1 就退化为假断言。） */
  var F32EPS = Math.pow(2, -24);
  function tolOf(v) { return 16 * F32EPS * Math.max(1, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])); }

  var got = apply(M, [0, L, 0]);            /* 子帧局部 (0,L,0) = 线段另一端 */
  var want = apply(P, b);                   /* 期望 = 父帧作用在 b 上 */
  var err = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
  ok(err < tolOf(want), 'F1 (P·F)·(0,L,0) = P·b  （恒等式成立至 float32 精度）',
     'err=' + err.toExponential(2) + '  tol=' + tolOf(want).toExponential(2));
  var got0 = apply(M, [0, 0, 0]), want0 = apply(P, a);
  var err0 = Math.hypot(got0[0] - want0[0], got0[1] - want0[1], got0[2] - want0[2]);
  ok(err0 < tolOf(want0), 'F2 (P·F)·(0,0,0) = P·a',
     'err=' + err0.toExponential(2) + '  tol=' + tolOf(want0).toExponential(2));

  /* ★ 负控：若漏乘父帧（即旧语义 M=F），F1 必然失败 */
  var Mg = F;
  var gotg = apply(Mg, [0, L, 0]);
  var errg = Math.hypot(gotg[0] - want[0], gotg[1] - want[1], gotg[2] - want[2]);
  ok(errg > 1e-3, 'F3 ★负控：漏乘父帧时 F1 必须失败（否则 F1 恒真=假断言）', 'err=' + f(errg));
})();

/* ================================ 汇总 ================================ */
console.log('\n' + '='.repeat(78));
console.log('汇总：  PASS ' + PASS + '   FAIL ' + FAIL);
console.log('='.repeat(78));
if (FAIL) { console.log('\n\u2717 存在失败项'); process.exit(1); }
console.log('\n\u2713 全部通过');
