/* ================================================================================
 * 接触网 3D 零件库 —— 零件算子层  parts.js
 * --------------------------------------------------------------------------------
 * 定位：`geom.js` 提供【几何算子】（矩阵/挤出/管/球…）；本文件提供【零件算子】
 *       —— 即"构成一个零件的那组几何动作"，是**可复用零部件资产的本体**。
 *
 * ★ 设计三条（与 `算子/接口规范_零件资产.md` 的硬契约一致）：
 *   ① **无模块级可变状态**：全部经 `createParts(g, C)` 注入 —— `g` 是 geom 实例，
 *      `C` 是调色板。同一进程可并存多套（多场景/多调色板），旧实现做不到。
 *   ② **不依赖隐式前提**：不依赖"调用点恰好在帧外"。几何用栈语义（见 geom.js），
 *      故零件算子**可在任意父帧内被安全调用与组合**。
 *   ③ **单一事实来源**：常量（如 `R` 半径表）只在此处定义一次，外部引用。
 *
 * ★ 忠实性：本批算子**逐式照抄**交付件 `接触网中间柱3D模型.html` 的对应实现
 *   （只改两点：`C.` → 注入的调色板；几何调用 → `g.` 前缀 + 栈语义）。
 *   是否逐位等价**不由本文件的注释保证**，而由
 *   `算子/零件算子\verify_parts_lib.py`（注入真实场景 + 全顶点缓冲比对）实测。
 *
 * ★ 本批（9 个）：boltAt / pipeClamp / ears / rodInsulator / extrudeProf /
 *   uBoltClamp / flatEnd / discInsulator / strandCable
 *   余下（8 个）：pulleyBlock / angleSteel / weightStack / guyAnchor / addBracket /
 *   addHanger / addSaddle / pinInsulator —— 下一批。
 *
 * 出处行号（交付件 158,146 B / 2851DDD5 版）：boltAt L595｜pipeClamp L604｜ears L622｜
 *   rodInsulator L641｜extrudeProf L670｜strandCable L726｜uBoltClamp L760｜flatEnd L798｜
 *   discInsulator L829
 * ================================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PARTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==============================================================================
   * createParts(g, C)
   *   g : geom.js 的 createGeom() 实例（提供 withM/frameY/xfP/m4tr/cylY/tube/
   *       sphereAt/polyTube/boxAt/quad/tri/loftY/hexa）
   *   C : 调色板（本批用到 insulMetal / insulCore / insulShed；其余走参数 col）
   * ============================================================================== */
  function createParts(g, C) {
    if (!g) throw new Error('createParts: 需要 geom 实例');
    C = C || {};
    var P = {};   /* 本层导出的零件算子表 */

    var withM = g.withM, frameY = g.frameY, xfP = g.xfP, m4tr = g.m4tr;
    var cylY = g.cylY, tube = g.tube, boxAt = g.boxAt, quad = g.quad, tri = g.tri;
    var sphereAt = g.sphereAt, loftY = g.loftY;

    /* ---------------------------------------------------------------- 螺栓
     * 六角头 + 螺杆。p=头部基点, dir=螺杆方向, r=半径, len=螺杆长。 */
    P.boltAt = function (p, dir, r, len, col, shaftDiameter) {
      var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      var d = [dir[0] / L * len, dir[1] / L * len, dir[2] / L * len];
      withM(frameY(p, [p[0] + d[0], p[1] + d[1], p[2] + d[2]]), function () {
        cylY(r, r, 0, len * 0.34, 6, col, true, col);
        var shaftR = shaftDiameter == null ? r * 0.60 : shaftDiameter / 2;
        cylY(shaftR, shaftR, 0, len, 8, col, true, col);
      });
    };

    /* ------------------------------------------------------------ 环形管卡
     * 抱在管上的卡箍 + 一颗紧固螺栓。
     * extra = 螺栓穿出方向（缺省 [0,1,0]）。 */
    P.pipeClamp = function (center, axis, r, t, col, extra) {
      var L = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      var a = [axis[0] / L, axis[1] / L, axis[2] / L];
      var p0 = [center[0] - a[0] * t / 2, center[1] - a[1] * t / 2, center[2] - a[2] * t / 2];
      var p1 = [center[0] + a[0] * t / 2, center[1] + a[1] * t / 2, center[2] + a[2] * t / 2];
      withM(frameY(p0, p1), function () { cylY(r, r, 0, t, 16, col, true, col); });
      var o = extra || [0, 1, 0];
      P.boltAt([center[0] + o[0] * (r + 0.010), center[1] + o[1] * (r + 0.010), center[2] + o[2] * (r + 0.010)],
               o, 0.008, 0.030, col);
    };

    /* -------------------------------------------------------------- 双耳板
     * 两片平行耳板（沿 axis 伸出，夹住另一根管）+ 穿心螺栓。
     * ★ D24 修复照抄：`side` 取 axis 在 **XZ 平面内**的垂线；axis 平行 Y（竖直）时
     *   `side=[0,0,0]` 退化 ⇒ 两片板落点重合且穿心螺栓方向为 0（塌成一点不可见）。
     *   补退化分支：竖直轴时取 **X 轴**为跨向。
     *   安全性：vpush 次数不变 ⇒ 顶点/面数不变；非竖直轴走 else 分支逐字节等价。 */
    P.ears = function (center, axis, span, plateW, plateT, plateL, col) {
      var L = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      var a = [axis[0] / L, axis[1] / L, axis[2] / L];
      var side = [-a[2], 0, a[0]];
      var sl = Math.hypot(side[0], side[2]);
      if (sl < 1e-6) side = [1, 0, 0];
      else side = [side[0] / sl, 0, side[2] / sl];
      for (var s = -1; s <= 1; s += 2) {
        var c = [center[0] + side[0] * s * span / 2, center[1], center[2] + side[2] * s * span / 2];
        withM(frameY(c, [c[0] + a[0] * plateL, c[1] + a[1] * plateL, c[2] + a[2] * plateL]), function () {
          boxAt(0, plateL / 2, 0, plateT / 2, plateL / 2, plateW / 2, col);
        });
      }
      P.boltAt([center[0] + side[0] * span / 2, center[1], center[2] + side[2] * span / 2],
               [-side[0], 0, -side[2]], 0.007, span + 0.032, col);
    };

    /* ---------------------------------------------------------- 棒式绝缘子
     * A16：瓷质宽裙 —— 细芯棒 + 宽大外翻伞裙（裙边下弯、裙间留间隙）+ 两端金属金具。
     * 依据 TB/T 3199.1-2018 表1：单绝缘 H=760、伞裙外径 D≤230 mm ⇒ shedR ≤ 0.115（取 0.112）。
     * ⚠ 与 `discInsulator`（盘形）是**两种形态**，SPEC_锚段 §2.6.10 明令禁止互相冒充。 */
    P.rodInsulator = function (from, to, metalCol) {
      var L = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      withM(frameY(from, to), function () {
        var S = 16, end = 0.062, core = 0.019, shedR = 0.112;
        cylY(0.052, 0.052, 0, end * 0.55, S, metalCol, true, metalCol);
        cylY(0.058, 0.048, 0.006, 0.014, S, metalCol, false, metalCol);
        cylY(0.030, 0.019, end * 0.55, end, S, metalCol, false, metalCol);
        cylY(0.052, 0.052, L - end * 0.55, L, S, metalCol, true, metalCol);
        cylY(0.048, 0.058, L - 0.014, L - 0.006, S, metalCol, false, metalCol);
        cylY(0.019, 0.030, L - end, L - end * 0.55, S, metalCol, false, metalCol);
        cylY(core, core, end, L - end, S, C.insulCore, false, C.insulCore);
        var n = 13, span = L - 2 * end - 0.05, pitch = span / n;
        for (var i = 0; i < n; i++) {
          var t0 = end + 0.025 + i * pitch;
          cylY(core, shedR, t0, t0 + 0.008, S, C.insulShed, false, C.insulShed);
          cylY(shedR, shedR * 0.98, t0 + 0.008, t0 + 0.020, S, C.insulShed, false, C.insulShed);
          cylY(shedR * 0.98, core, t0 + 0.020, t0 + 0.030, S, C.insulShed, false, C.insulShed);
        }
      });
    };

    /* ------------------------------------------------------- 任意轮廓挤出
     * 把 2D 轮廓 prof=[[u,v],...] 沿轴线挤出。轮廓 (u,v) 映射到与轴线垂直的局部平面。
     * cap !== false 时封两端面（扇形三角化，要求轮廓凸或近似凸）。
     * ★ 用途：接触线异型断面、绞线股等。 */
    P.extrudeProf = function (p0, p1, prof, segsPer, col, cap) {
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6) return;
      var n = prof.length;
      withM(frameY(p0, p1), function () {
        for (var i = 0; i < n; i++) {
          var a = prof[i], b = prof[(i + 1) % n];
          quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], L, b[1]], [a[0], L, a[1]], col);
        }
        if (cap !== false) {
          for (var k = 0; k < 2; k++) {
            var yy = k ? L : 0;
            for (var j = 1; j < n - 1; j++) {
              if (k) tri([prof[0][0], yy, prof[0][1]], [prof[j][0], yy, prof[j][1]], [prof[j + 1][0], yy, prof[j + 1][1]], col);
              else tri([prof[0][0], yy, prof[0][1]], [prof[j + 1][0], yy, prof[j + 1][1]], [prof[j][0], yy, prof[j][1]], col);
            }
          }
        }
      });
    };

    /* ------------------------------------------------------- U 型螺栓线夹
     * U 形抱箍（两根螺纹柱 + 底部横杆）+ 压板 + 螺母。
     * center=被抱物中心, axis=被抱物轴线方向, open=U 形开口朝向（压板一侧）,
     * span=两柱中心距之半, barR=柱半径, depth=U 形深度, rObj=被夹件半径。
     * ★ L783-790 的 D17 + F5 两处修复**逐字照抄**（含 `+0.006` 只能算一次的原因）。 */
    P.uBoltClamp = function (center, axis, open, span, barR, depth, col, colNut, rObj) {
      colNut = colNut || col;
      var L = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      var a = [axis[0] / L, axis[1] / L, axis[2] / L];
      var o = Math.hypot(open[0], open[1], open[2]) || 1;
      var ov = [open[0] / o, open[1] / o, open[2] / o];
      var s = [a[1] * ov[2] - a[2] * ov[1], a[2] * ov[0] - a[0] * ov[2], a[0] * ov[1] - a[1] * ov[0]];
      var sl = Math.hypot(s[0], s[1], s[2]) || 1;
      s = [s[0] / sl, s[1] / sl, s[2] / sl];
      function at(u, v, w) {
        return [center[0] + s[0] * u + ov[0] * v + a[0] * w,
                center[1] + s[1] * u + ov[1] * v + a[1] * w,
                center[2] + s[2] * u + ov[2] * v + a[2] * w];
      }
      var back = -depth;
      for (var k = -1; k <= 1; k += 2) {
        tube(at(k * span, back, 0), at(k * span, back + depth + 0.030, 0), barR, 7, col, true);
        withM(frameY(at(k * span, back + depth + 0.012, 0), at(k * span, back + depth + 0.030, 0)), function () {
          cylY(barR * 1.7, barR * 1.7, 0, 0.014, 6, colNut, true, colNut);
        });
      }
      tube(at(-span, back, 0), at(span, back, 0), barR, 7, col, true);
      /* 压板必须压在被夹件的**外表面**上（D17）。F5：`+0.006` 曾算两次。
         现写法 rp = R（帧原点落在表面）⇒ 压板中心 = R + t/2 = R + 0.006 ✓ */
      var rp = (rObj || span * 0.5);
      withM(frameY(at(0, rp, 0), at(0, rp + 0.012, 0)), function () {
        boxAt(0, 0.006, 0, span + barR * 2.2, 0.006, 0.030, col);
      });
    };

    /* ------------------------------------------------------------ 压扁管端
     * 斜腕臂上端扁头：沿 X 压扁，厚≈壁厚×2，长 len。
     * 实现：两段收敛的扁盒 + 端部封板，沿管轴线方向。 */
    P.flatEnd = function (p0, p1, thick, wid, col) {
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6) return;
      withM(frameY(p0, p1), function () {
        var n = 6;
        for (var i = 0; i < n; i++) {
          var t0 = i / n, t1 = (i + 1) / n;
          var y0 = L * t0, y1 = L * t1;
          var r0 = wid * (1 - t0 * 0.86), r1 = wid * (1 - t1 * 0.86);
          var h0 = thick / 2 + (wid - thick / 2) * Math.pow(1 - t0, 2.6);
          var h1 = thick / 2 + (wid - thick / 2) * Math.pow(1 - t1, 2.6);
          quad([-h0, y0, -r0], [h0, y0, -r0], [h0, y1, -r1], [-h0, y1, -r1], col);
          quad([h0, y0, -r0], [h0, y0, r0], [h0, y1, r1], [h0, y1, -r1], col);
          quad([h0, y0, r0], [-h0, y0, r0], [-h0, y1, r1], [h0, y1, r1], col);
          quad([-h0, y0, r0], [-h0, y0, -r0], [-h0, y1, -r1], [-h0, y1, r1], col);
        }
        var hT = thick / 2, rT = wid * 0.14;
        quad([-hT, L, -rT], [hT, L, -rT], [hT, L, rT], [-hT, L, rT], col);
      });
    };

    /* -------------------------------------------------------- 盘形悬式绝缘子串
     * 铁帽 + 瓷盘（外翻伞唇）+ 钢脚，沿 from→to 串 n 片。
     * ★ 与 `rodInsulator`（棒式伞裙）是**两种形态**，禁止互相冒充。
     * 盘径取 φ0.220（≈实物 XP-70 的 φ255 量级，按本模型整体比例略收），片距 = L/n。 */
    P.discInsulator = function (from, to, n, col) {
      var L = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      if (L < 1e-6 || !(n > 0)) return;
      withM(frameY(from, to), function () {
        var pitch = L / n, i;
        cylY(0.013, 0.013, 0, L, 8, C.insulMetal, false, C.insulMetal);
        for (i = 0; i < n; i++) {
          var y0 = i * pitch, m = pitch;
          cylY(0.030, 0.034, y0 + 0.00 * m, y0 + 0.26 * m, 12, C.insulMetal, true, C.insulMetal);
          cylY(0.034, 0.110, y0 + 0.26 * m, y0 + 0.40 * m, 16, col, false, col);
          cylY(0.110, 0.110, y0 + 0.40 * m, y0 + 0.52 * m, 16, col, false, col);
          cylY(0.110, 0.044, y0 + 0.52 * m, y0 + 0.68 * m, 16, col, false, col);
          cylY(0.026, 0.016, y0 + 0.68 * m, y0 + 0.86 * m, 10, C.insulMetal, false, C.insulMetal);
        }
      });
    };

    /* ------------------------------------------------------------ 绞线
     * 中心股 + 外层 nStrand 股沿轴线螺旋缠绕（D20 改判：外层股由"一串小球"改为螺旋 polyTube
     * —— 面数 −87%，且由离散珠串变连续螺旋股，是**双赢不是取舍**）。
     * opt（缺省 = 旧行为，逐面不变）：{segsPer, coreSeg, beadSeg, minSegs}
     *   —— 供附加导线降面：仍须是螺旋绞线（**禁光圆柱**），只降采样密度不改形态。
     * 返回 { L, segs, strands } 供调用方查账。 */
    P.strandCable = function (p0, p1, r, col, nStrand, twist, opt) {
      nStrand = nStrand || 6;
      opt = opt || {};
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6) return null;
      var segs = Math.max(opt.minSegs || 12, Math.round(L / (opt.segsPer || 0.06)));
      var coreSeg = opt.coreSeg || 8, beadSeg = opt.beadSeg || 6;
      var rr = r * 0.62, bead = r * 0.30;
      var strands = [];
      withM(frameY(p0, p1), function () {
        /* ★ 芯股：原交付件此处实参错位（`cylY(rr,rr,0,L,coreSeg,true,col)` ⇒ col=true，
           导致芯股颜色为 undefined ⇒ 1.33% 顶点颜色 NaN）。库侧直接写正确顺序。 */
        cylY(rr, rr, 0, L, coreSeg, col, true, col);
        for (var s = 0; s < nStrand; s++) {
          var ph = s / nStrand * 6.283185307;
          var pts = [];
          for (var i = 0; i <= segs; i++) {
            var t = i / segs, a = ph + twist * t * 6.283185307;
            pts.push(xfP([rr * Math.cos(a), L * t, rr * Math.sin(a)]));
          }
          strands.push(pts);
        }
      });
      /* 帧外调用 polyTube（其内部自带帧语义；栈语义下同样正确） */
      for (var s2 = 0; s2 < strands.length; s2++) g.polyTube(strands[s2], bead, 6, col);
      return { L: L, segs: segs, coreSeg: coreSeg, beadSeg: beadSeg, nStrand: nStrand };
    };

    /* ============================================================ 第二批（t11/t12）
     * 出处行号（交付件 158,146 B / 2851DDD5 版）：pulleyBlock L849｜angleSteel L895｜
     *   weightStack L910｜guyAnchor L926｜addBracket L963｜addHanger L987｜
     *   addSaddle L1030｜pinInsulator L1099
     * ============================================================ */

    /* ---------------------------------------------------------- 补偿滑轮组
     * 同架**大轮 + 小轮**（V 形绳槽）+ 两片夹板 + 销轴 + 吊挂耳。
     * axis = 轮平面法线（本项目沿 X ⇒ 满足 SPEC_锚段 §3.10.2「滑轮平面与地面铅垂」）。
     * 返回 {big,small,rBig,rSmall,perp,axis,rope} 供补偿绳按**切线**取折点。 */
    P.pulleyBlock = function (center,axis,rBig,rSmall,nRope,col,reachY) {
  var L=Math.hypot(axis[0],axis[1],axis[2])||1;
  var a=[axis[0]/L,axis[1]/L,axis[2]/L];
  /* 轮平面内"向下"方向（垂直于轮轴） */
  var dn=[0,-1,0], k=dn[0]*a[0]+dn[1]*a[1]+dn[2]*a[2];
  var pp=[dn[0]-k*a[0],dn[1]-k*a[1],dn[2]-k*a[2]];
  var pl=Math.hypot(pp[0],pp[1],pp[2])||1; pp=[pp[0]/pl,pp[1]/pl,pp[2]/pl];
  var t=0.028, off=rBig+rSmall+0.02;
  var cB=[center[0],center[1],center[2]];
  var cS=[center[0]+pp[0]*off, center[1]+pp[1]*off, center[2]+pp[2]*off];
  function wheel(c,r){
    var h0=[c[0]-a[0]*t/2,c[1]-a[1]*t/2,c[2]-a[2]*t/2];
    var h1=[c[0]+a[0]*t/2,c[1]+a[1]*t/2,c[2]+a[2]*t/2];
    withM(frameY(h0,h1),function(){
      var rg=r*0.84;
      cylY(rg,rg,0,t,18,col,true,col);                 /* 轮盘本体（含两端面） */
      cylY(r,r,0,t*0.30,18,col,false,col);             /* 轮缘段 1 */
      cylY(r,rg,t*0.30,t*0.50,18,col,false,col);       /* V 形绳槽·左斜面 */
      cylY(rg,r,t*0.50,t*0.70,18,col,false,col);       /* V 形绳槽·右斜面 */
      cylY(r,r,t*0.70,t,18,col,false,col);             /* 轮缘段 2 */
      cylY(0.016,0.016,-0.010,t+0.010,10,C.fitDark,true,C.fitDark);  /* 轮毂 */
    });
  }
  wheel(cB,rBig); wheel(cS,rSmall);
  /* 销轴（大/小轮各一根，沿轮轴贯穿） */
  P.boltAt([cB[0]-a[0]*0.055,cB[1]-a[1]*0.055,cB[2]-a[2]*0.055], a, 0.010, 0.110, C.fitDark);
  P.boltAt([cS[0]-a[0]*0.055,cS[1]-a[1]*0.055,cS[2]-a[2]*0.055], a, 0.010, 0.110, C.fitDark);
  /* 两片夹板（沿轮轴各一片，夹住两轮）——正方形板：与"向下"方向无关 ⇒ 任意轮轴朝向都能罩住两轮 */
  var mid=[(cB[0]+cS[0])/2,(cB[1]+cS[1])/2,(cB[2]+cS[2])/2];
  var hs=Math.max(rBig, off/2)+0.022;
  for(var s=-1;s<=1;s+=2){
    var pc=[mid[0]+a[0]*s*(t/2+0.007), mid[1]+a[1]*s*(t/2+0.007), mid[2]+a[2]*s*(t/2+0.007)];
    withM(frameY([pc[0]-a[0]*0.007,pc[1]-a[1]*0.007,pc[2]-a[2]*0.007],
                 [pc[0]+a[0]*0.007,pc[1]+a[1]*0.007,pc[2]+a[2]*0.007]),function(){
      boxAt(0,0.007,0, hs,0.007,hs, col);
    });
  }
  /* 吊挂耳（朝上，接下锚角钢）
     ★ t149（用户令）：`reachY` = 下锚角钢水平肢**底面**高程 ⇒ 耳板长度按它反解
     （原写死 0.055 ⇒ 耳顶与肢底留 0.068 m 空档 ⇒ 滑轮组悬空；肢 B 底面高程 = steelY，留 0.002 m 装配间隙 ⇒ 无共面三角级计数）；缺省仍 0.055 ⇒ 其它调用点逐位不变。 */
  var up=[-pp[0],-pp[1],-pp[2]];
  var hp=[cB[0]+up[0]*(rBig+0.012), cB[1]+up[1]*(rBig+0.012), cB[2]+up[2]*(rBig+0.012)];
  var earL=0.055;
  if(reachY!==undefined) earL=Math.max(0.055, reachY-hp[1]);
  ears([hp[0],hp[1],hp[2]],[up[0],up[1],up[2]], 0.048,0.050,0.010,earL, C.fit);
  return {big:cB, small:cS, rBig:rBig, rSmall:rSmall, perp:pp, axis:a, rope:nRope};
};

    /* --------------------------------------------------------------- 角钢
     * 下锚角钢 / 限制架立杆：**两段 boxAt 组成 L 形（禁止用单个方盒）**。
     * p0→p1 = 角钢长度方向；leg1/leg2 = 两肢长度；thick = 肢厚；含两端加劲肋。 */
    P.angleSteel = function (p0,p1,leg1,leg2,thick,col,sgn) {
  /* ★ t149（用户令）：新增 `sgn`（缺省 +1 ⇒ 原行为逐位不变）。肢 B 沿【局部 ±z】伸出；
     局部 +z = 世界 −Z（p0→p1 沿 ±X 时）⇒ `sgn=-1` ⇒ 水平肢朝【田野侧(+Z)】伸出。
     锚柱下锚角钢用 −1（原 +1 ⇒ 肢朝线路侧(−Z)**伸进支柱体内** ⇒ 滑轮组埋柱）。 */
  var sg=(sgn===undefined)?1:sgn;
  var L=Math.hypot(p1[0]-p0[0],p1[1]-p0[1],p1[2]-p0[2]);
  if(L<1e-6) return;
  withM(frameY(p0,p1),function(){
    boxAt(leg2/2, L/2, thick/2, leg2/2, L/2, thick/2, col);                     /* 肢 A */
    boxAt(thick/2, L/2, sg*(thick+leg1)/2, thick/2, L/2, (leg1-thick)/2, col);  /* 肢 B（方向可反） */
    /* 两端加劲肋（薄板，斜撑在两口之间） */
    var gl=Math.min(0.070, leg2*0.6);
    boxAt(gl/2, 0.014, (gl)/2, gl/2, 0.014, gl/2, col);
    boxAt(gl/2, L-0.014, (gl)/2, gl/2, 0.014, gl/2, col);
  });
};

    /* -------------------------------------------------------------- 坠砣串
     * n 块**带倒角长方体**（A 型混凝土 0.30×0.30×0.110），块间留 5 mm 缝。
     * ★ 禁止做成一整根光柱（SPEC_锚段 §3.10.6 像不像判据：能数出 N 块且块间有缝）。 */
    P.weightStack = function (p0, p1, n, shape, col) {
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6 || !(n > 0)) return;
      var w = (shape && shape.w) || 0.30, ch = (shape && shape.ch) || 0.022;
      var h = w / 2;
      /* ★ t225（用户令 §9.227）：`shape.circ` ⇒ **圆盘**截面（正 20 边形，半径 h）；缺省仍为倒角方盘。
       * 【原句保留（作废）】`var prof = [[-h + ch, -h], [h - ch, -h], [h, -h + ch], [h, h - ch], [h - ch, h], [-h + ch, h], [-h, h - ch], [-h, -h + ch]];` */
      var prof, i0, a0;
      if (shape && shape.circ) { prof = []; for (i0 = 0; i0 < 20; i0++) { a0 = 2 * Math.PI * i0 / 20; prof.push([h * Math.cos(a0), h * Math.sin(a0)]); } }
      else { prof = [[-h + ch, -h], [h - ch, -h], [h, -h + ch], [h, h - ch],
                     [h - ch, h], [-h + ch, h], [-h, h - ch], [-h, -h + ch]]; }
      withM(frameY(p0, p1), function () {
        var pitch = L / n, gap = Math.min(0.005, pitch * 0.15), th = pitch - gap, i;
        for (i = 0; i < n; i++) {
          var y0 = i * pitch + gap * 0.5, y1 = y0 + th;
          loftY(prof, y0, prof, y1, 3, col);
        }
      });
    };

    /* ------------------------------------------------------- 拉线锚板 + 拉杆
     * 锚板**垂直于拉线**（法线沿 dir），拉杆与拉线成一条直线。 */
    P.guyAnchor = function (p, dir, plateW, legR, col) {
      var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      var d = [dir[0] / L, dir[1] / L, dir[2] / L];
      withM(frameY(p, [p[0] + d[0] * 0.34, p[1] + d[1] * 0.34, p[2] + d[2] * 0.34]), function () {
        cylY(legR, legR, 0, 0.34, 10, col, true, col);
        cylY(legR * 1.5, legR * 1.5, 0.34 - 0.020, 0.34, 10, col, true, col);   /* 端部墩头 */
      });
      withM(frameY([p[0] - d[0] * 0.011, p[1] - d[1] * 0.011, p[2] - d[2] * 0.011],
                   [p[0] + d[0] * 0.011, p[1] + d[1] * 0.011, p[2] + d[2] * 0.011]), function () {
        boxAt(0, 0.011, 0, plateW / 2, 0.011, plateW / 2, col);
      });
    };

    /* ------------------------------------------------- ① 附加导线肩架（t12）
     * **角钢悬臂 + 根部贴柱板 + 4×M16 + 斜撑**，自柱身伸出。
     * ★ 装配纪律（[公开] 施工交底 §一.5）：「螺杆头在 H 型钢柱外侧」
     *   ⇒ 根部**贴柱板在柱面之外**（z ∈ [zf, zf+t]），螺栓自外侧穿入柱内
     *   ⇒ **不得把贴板埋进柱身**（G2 缺陷：旧写法中心 z = zf−0.030 会埋入翼缘）。
     * p0 = 根部（柱面 zf），dir = 悬臂方向（+Z 田野侧）；返回挂点坐标。 */
    P.addBracket = function (p0, dir, len, legA, legB, thick, col) {
      var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      var d = [dir[0] / L, dir[1] / L, dir[2] / L];
      var tip = [p0[0] + d[0] * len, p0[1] + d[1] * len, p0[2] + d[2] * len];
      P.angleSteel(p0, tip, legA, legB, thick, col);
      var t = 0.012, hw = 0.052, hh = 0.048;
      boxAt(0, p0[1], p0[2] + t / 2, hw, hh, t / 2, C.cast);
      for (var k = -1; k <= 1; k += 2) {
        P.boltAt([-0.062, p0[1] + k * 0.026, p0[2] + t], [0, 0, -1], 0.008, 0.100, C.fit);
      }
      var mid = [p0[0] + d[0] * len * 0.55, p0[1] + d[1] * len * 0.55, p0[2] + d[2] * len * 0.55];
      var foot = [p0[0], p0[1] - 0.20, p0[2]];
      tube(mid, foot, 0.009, 8, col, true);
      return tip;
    };

    /* ------------------------------------------------------ ② 吊环（t12）
     * **上端 M16 螺纹杆 + 下端闭合圆环**，本体热弯曲焊接（Q235A）。
     * 图6 标注：M16-8g、螺纹段 50~80 mm。（M16、螺纹段 50~80 为图6 实测）
     * p0 = 螺纹杆顶端（接肩架角钢下缘），dir = 向下（挂环朝向），
     * nrm = **环平面法线**（缺省 X = 沿导线轴 ⇒ 环面垂直于导线，环不碰线）。返回环心。 */
    P.addHanger = function (p0, dir, ringR, rodR, col, nrm) {
      var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      var d = [dir[0] / L, dir[1] / L, dir[2] / L];
      nrm = nrm || [1, 0, 0];
      var nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
      var n = [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl];
      var e2 = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]];
      var e2l = Math.hypot(e2[0], e2[1], e2[2]) || 1;
      e2 = [e2[0] / e2l, e2[1] / e2l, e2[2] / e2l];
      var rodLen = 0.075;                                /* 螺纹段 50~80 ⇒ 取 75 mm */
      var p1 = [p0[0] + d[0] * rodLen, p0[1] + d[1] * rodLen, p0[2] + d[2] * rodLen];
      withM(frameY(p0, p1), function () {
        cylY(rodR, rodR, 0, rodLen, 10, col, true, col);
        for (var q = 0; q < 5; q++) cylY(rodR * 1.28, rodR * 1.28, 0.010 + q * 0.013, 0.018 + q * 0.013, 10, C.fitDark, true, C.fitDark);
      });
      withM(frameY(p0, [p0[0] - d[0] * 0.014, p0[1] - d[1] * 0.014, p0[2] - d[2] * 0.014]), function () {
        cylY(0.013, 0.013, 0, 0.014, 6, C.fitDark, true, C.fitDark);   /* 螺母 + 垫圈 */
      });
      var c = [p1[0] + d[0] * ringR, p1[1] + d[1] * ringR, p1[2] + d[2] * ringR];
      var N = 14, pts = [];
      for (var i = 0; i <= N; i++) {
        var a2 = i / N * 6.283185307, ca = Math.cos(a2), sa = Math.sin(a2);
        pts.push([c[0] + (d[0] * ca + e2[0] * sa) * ringR,
                  c[1] + (d[1] * ca + e2[1] * sa) * ringR,
                  c[2] + (d[2] * ca + e2[2] * sa) * ringR]);
      }
      g.polyTube(pts, rodR * 0.92, 8, col);
      return c;
    };

    /* --------------------------------------- ③ 杵座鞍子（t12，图3 D 型）
     * **杵座球头 + 铸造本体（半圆挂线槽）+ 压块 + U 螺栓 + 锁紧销**。
     * D 型 = 本体 D 型 + U 螺栓（力矩 25 N·m）；本体 ZG270-500 精密铸造 ⇒ 收分圆润，非方盒。
     * ★ 装配链（图1 表1：零件1 = 吊环，零件2 = 杵座鞍子）：
     *     吊环圆环 → **杵座球头坐在环内** → 杵座颈 → 本体 → 挂线槽 → 导线
     *   ⇒ 本体顶面 = 环内下缘（ringC.y − ringR），挂线槽中心再低 V。
     * ★ 本地正交帧函数原命名为 `P`，与导出的算子表同名（遮蔽）—— 本库改名 `Q`，
     *   以免重蹈交付件 D26（`C` 遮蔽调色板）那一族的覆辙。
     * 返回 {center:挂线槽中心, axis, open, side, r}。 */
    P.addSaddle = function (ringC, ringR, axis, open, wireR, col) {
      var L = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      var a = [axis[0] / L, axis[1] / L, axis[2] / L];
      var o = Math.hypot(open[0], open[1], open[2]) || 1;
      var ov = [open[0] / o, open[1] / o, open[2] / o];
      var s = [a[1] * ov[2] - a[2] * ov[1], a[2] * ov[0] - a[0] * ov[2], a[0] * ov[1] - a[1] * ov[0]];
      var sl = Math.hypot(s[0], s[1], s[2]) || 1;
      s = [s[0] / sl, s[1] / sl, s[2] / sl];
      var W = 0.032;                     /* 本体半宽（沿 side） */
      var H = 0.030, V = 0.030;          /* 本体下沿 / 上沿（沿 open，相对槽心） */
      var rg = wireR * 1.15;             /* 挂线槽半径（留间隙） */
      var halfL = 0.042;                 /* 本体沿导线轴半长 */
      var blkTop = -rg * 0.45;           /* 底块顶面（圆弧下段埋入底块 ⇒ 呈"槽"观感） */
      var c = [ringC[0], ringC[1] - ringR - V, ringC[2]];
      function Q(u, v, w) {
        return [c[0] + s[0] * u + ov[0] * v + a[0] * w,
                c[1] + s[1] * u + ov[1] * v + a[1] * w,
                c[2] + s[2] * u + ov[2] * v + a[2] * w];
      }
      var N = 8, i2;
      function arcPt(t) { var th = -Math.PI + t * Math.PI; return [rg * Math.cos(th), rg * Math.sin(th)]; }
      /* 杵座球头（坐在吊环环内，留间隙）+ 杵座颈（连到本体顶面） */
      sphereAt(ringC[0], ringC[1], ringC[2], ringR * 0.55, col, 10);
      withM(frameY([ringC[0], ringC[1] - ringR * 0.55, ringC[2]], [ringC[0], ringC[1] - ringR, ringC[2]]), function () {
        cylY(ringR * 0.34, ringR * 0.34, 0, ringR * 0.55, 10, col, true, col);
      });
      /* 底块（凸盒） */
      quad(Q(-rg, -H, -halfL), Q(rg, -H, -halfL), Q(rg, -H, halfL), Q(-rg, -H, halfL), col);
      quad(Q(-rg, blkTop, -halfL), Q(-rg, blkTop, halfL), Q(rg, blkTop, halfL), Q(rg, blkTop, -halfL), col);
      quad(Q(-rg, -H, -halfL), Q(-rg, blkTop, -halfL), Q(rg, blkTop, -halfL), Q(rg, -H, -halfL), col);
      quad(Q(-rg, -H, halfL), Q(rg, -H, halfL), Q(rg, blkTop, halfL), Q(-rg, blkTop, halfL), col);
      quad(Q(-rg, -H, -halfL), Q(-rg, -H, halfL), Q(-rg, blkTop, halfL), Q(-rg, blkTop, -halfL), col);
      quad(Q(rg, -H, -halfL), Q(rg, blkTop, -halfL), Q(rg, blkTop, halfL), Q(rg, -H, halfL), col);
      /* 左 / 右肩块（凸盒） */
      for (var sd = -1; sd <= 1; sd += 2) {
        var u0 = sd * rg, u1 = sd * W;
        quad(Q(u0, -H, -halfL), Q(u1, -H, -halfL), Q(u1, -H, halfL), Q(u0, -H, halfL), col);
        quad(Q(u0, V, -halfL), Q(u0, V, halfL), Q(u1, V, halfL), Q(u1, V, -halfL), col);
        quad(Q(u0, -H, -halfL), Q(u0, V, -halfL), Q(u1, V, -halfL), Q(u1, -H, -halfL), col);
        quad(Q(u0, -H, halfL), Q(u1, -H, halfL), Q(u1, V, halfL), Q(u0, V, halfL), col);
      }
      /* 半圆挂线槽壳（N 片梯形，构成圆弧托面；槽口朝 open 正向） */
      for (i2 = 0; i2 < N; i2++) {
        var q0 = arcPt(i2 / N), q1 = arcPt((i2 + 1) / N);
        quad(Q(q0[0], q0[1], -halfL), Q(q1[0], q1[1], -halfL), Q(q1[0], q1[1], halfL), Q(q0[0], q0[1], halfL), C.fitDark);
      }
      /* 压块（盖在槽口上方，压住导线）—— 铸钢，loftY 收分（非直角盒） */
      withM(frameY(Q(0, V + 0.004, 0), Q(0, V + 0.022, 0)), function () {
        loftY([[-W * 0.92, -halfL * 0.92], [W * 0.92, -halfL * 0.92], [W * 0.92, halfL * 0.92], [-W * 0.92, halfL * 0.92]],
              0, [[-W * 0.62, -halfL * 0.72], [W * 0.62, -halfL * 0.72], [W * 0.62, halfL * 0.72], [-W * 0.62, halfL * 0.72]],
              0.018, 4, col);
      });
      /* U 螺栓（D 型：两根螺纹柱 + U 底横杆 + 螺母）—— 跨距 2×0.026 */
      var back = -H - 0.024;
      for (var k = -1; k <= 1; k += 2) {
        tube(Q(k * 0.026, back, 0), Q(k * 0.026, V + 0.032, 0), 0.0055, 7, C.fit, true);
        withM(frameY(Q(k * 0.026, V + 0.018, 0), Q(k * 0.026, V + 0.032, 0)), function () {
          cylY(0.0094, 0.0094, 0, 0.014, 6, C.fitDark, true, C.fitDark);
        });
      }
      tube(Q(-0.026, back, 0), Q(0.026, back, 0), 0.0055, 7, C.fit, true);
      /* 锁紧销（W 型，QSn4-3 锡青铜，型材冲压）—— 横穿压块 */
      withM(frameY(Q(-W * 1.05, V + 0.013, 0), Q(W * 1.05, V + 0.013, 0)), function () {
        cylY(0.0042, 0.0042, 0, 2 * W * 1.05, 8, C.earth, true, C.earth);
      });
      return { center: c, axis: a, open: ov, side: s, r: wireR };
    };

    /* ------------------------------------- ④ 针式绝缘子（t12，P-10T）
     * **瓷质本体（伞裙） + 钢脚（下端螺纹） + 顶槽绑扎**。轴线沿 dir。 */
    P.pinInsulator = function (p0, p1, col) {
      var L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L < 1e-6) return;
      withM(frameY(p0, p1), function () {
        var n = 4, i;
        cylY(0.011, 0.011, 0, L * 0.26, 10, C.fitDark, true, C.fitDark);        /* 钢脚 */
        cylY(0.016, 0.020, L * 0.26, L * 0.34, 12, C.insulCore, false, C.insulCore);
        for (i = 0; i < n; i++) {                                               /* 伞裙（外翻、裙边下弯） */
          var y0 = L * 0.34 + i * (L * 0.50 / n);
          cylY(0.020, 0.052, y0, y0 + 0.010, 14, col, false, col);
          cylY(0.052, 0.050, y0 + 0.010, y0 + 0.020, 14, col, false, col);
          cylY(0.050, 0.022, y0 + 0.020, y0 + 0.028, 14, col, false, col);
        }
        cylY(0.020, 0.026, L * 0.84, L * 0.94, 12, col, true, col);             /* 顶部承线槽座 */
        cylY(0.026, 0.026, L * 0.94, L, 12, col, true, col);
      });
    };

    P._api = { g: g, C: C };
    P.locClamp = function (x, cy, cz, locatorPose) {
    var hx31=0.037;   /* ★ t155（裁Ⅰ）：长度 74 mm（现档 L2108 逐字） */
    for(var s=-1;s<=1;s+=2){
      boxAt(x, cy+0.017450, cz+s*0.007225, hx31, 0.017500, 0.000775, C.fit);   /* ★ t186（用户令 §9.205-1）：片体 Y 跨 [cY−0.00005, cY+0.03495]，35 mm 包络；孔距52/M10；图13曲面轮廓仍待实体验收 */   /* t155 旧句【原句保留（作废）】`cy+0.009225, 0.009275` */
      boxAt(x, cy+0.000875, cz+s*0.005550, hx31, 0.000925, 0.000900, C.fit);   /* 突出部（现档 L2047 逐字） */
    }
    for(var t=-1;t<=1;t+=2)
      P.boltAt([x+t*0.026, cy+0.01745, cz-0.0122],[0,0,1],0.0050,0.02440,C.fitDark,0.010);   /* ★ t155：跨导线 24.4 mm（现档 L2114 逐字） */
      if(locatorPose){
        var axis=locatorPose.pinDirWorld, q=locatorPose.qWorld,
            so=[q[0]-0.008*axis[0],q[1]-0.008*axis[1],q[2]-0.008*axis[2]],
            se=[q[0]+0.008*axis[0],q[1]+0.008*axis[1],q[2]+0.008*axis[2]];
        g.annulusTube(so,se,0.009,0.0055,16,C.fitDark);   /* φ18/11 销孔（现档 L3077 逐字） */
        boxAt(x, cy+0.018, cz, 0.015,0.004,0.008, C.cast); /* socket-to-clamp 实桥（现档 L3078 逐字） */
      }
    };

    /* ===== 咬槽族（吊弦线夹/定位线夹）★ t268（2026-09-28）：**按交付件现档 `jointClamp` 逐句移植** =====
       旧句（`hangerClamp` 系）与交付件**不是同一件**，且它调的 `g.buf()/g.mat()/g.xfN()` 在注入 shim 中
       并不存在 ⇒ 是**跑不起来的死代码**。本笔按交付件 `接触网中间柱3D模型.html` L4088-4123 重提，
       几何次序/常量/审计记录逐句对齐；网关由 shim 提供（part/instLast/buf/auditCtx/pointMeshDistance/
       taperedTube/PT）。调用点**一字不动**（模型仍写 `jointClamp(id,wireId,seat,eyeOffset,attachSign,centerlineSeat)`）。
       验收：`verify_parts_lib.py` 正控 EXIT 0（位置 ≤2 ulp；n/i/e 逐位；颜色仅原 NaN 处异）＋ 负控 EXIT 1。 */
    P.jointClamp = function (id, wireId, seat, eyeOffset, attachSign, centerlineSeat) {
      var centerlineR=0.012, tubeR=0.0035, ri=centerlineR-tubeR, outer=centerlineR+tubeR,
          cy=seat[1]+eyeOffset,
          eye={center:[seat[0],cy,seat[2]+0.008], axis:[0,0,1], innerRadius:ri, outerRadius:outer, tubeRadius:tubeR,
               attach:[seat[0],cy+attachSign*ri,seat[2]+0.008]},
          ranges=[], i, a, b, s, t, j, v, rad, d,
          best=Infinity, attach=null, nearTarget=[seat[0],cy+attachSign*ri,eye.center[2]];
      var ctx=g.auditCtxGet(); g.auditCtxSet(wireId+'@'+seat[0].toFixed(3));
      var body, ring, neck;
      try{
        g.part(id,function(){
          for(s=-1;s<=1;s+=2) g.boxAt(seat[0],seat[1],seat[2]+s*0.008,0.021,0.006,0.001,C.fit);
          for(t=-1;t<=1;t+=2) P.boltAt([seat[0]+t*0.010,seat[1]+0.006,seat[2]-0.009],[0,0,1],0.0035,0.018,C.fitDark);
        });
        body=g.instLast();
        g.part(id,function(){ for(i=0;i<32;i++){ a=i*Math.PI/16; b=(i+1)*Math.PI/16;
          g.tube([eye.center[0]+centerlineR*Math.cos(a),cy+centerlineR*Math.sin(a),eye.center[2]],
                 [eye.center[0]+centerlineR*Math.cos(b),cy+centerlineR*Math.sin(b),eye.center[2]],tubeR,8,C.fitDark,true); } });
        ring=g.instLast();
        for(j=ring.triangleStart;j<ring.triangleEnd;j++){
          v=[g.buf().p[j*3],g.buf().p[j*3+1],g.buf().p[j*3+2]];
          rad=Math.hypot(v[0]-eye.center[0],v[1]-cy);
          if(attachSign*(v[1]-cy)<=0||rad>=centerlineR-tubeR*0.25) continue;
          d=Math.hypot(v[0]-nearTarget[0],v[1]-nearTarget[1],v[2]-nearTarget[2]);
          if(d<best){ best=d; attach=v; }
        }
        if(!attach) throw new Error('joint clamp has no inner-eye mesh vertex: '+wireId);
        eye.attach=attach.slice(); eye.attachPlacementDistance=best;
        var neckTip=[seat[0],cy-attachSign*outer,eye.center[2]];
        g.part(id,function(){ g.taperedTube([seat[0],seat[1],seat[2]],neckTip,0.010,tubeR,12,C.fitDark,true); });
        neck=g.instLast();
      } finally { g.auditCtxSet(ctx); }
      ranges.push({triangleStart:body.triangleStart,triangleEnd:body.triangleEnd},
                  {triangleStart:ring.triangleStart,triangleEnd:ring.triangleEnd});
      var holeNeckClearance=g.pointMeshDistance(eye.center,{triangleStart:neck.triangleStart,triangleEnd:neck.triangleEnd})-ri;
      var rec={clampId:wireId+'@'+seat[0].toFixed(6)+':'+id, partId:id, wireId:wireId, wireSeat:(centerlineSeat||seat).slice(),
        bodyDatum:seat.slice(), eye:eye, meshRanges:ranges, connectorRadius:0.010,
        neckTriangleRange:{triangleStart:neck.triangleStart,triangleEnd:neck.triangleEnd}, holeNeckClearance:holeNeckClearance,
        eyeMeshDistance:g.pointMeshDistance(eye.attach,ranges[1]), bodySeatMeshDistance:g.pointMeshDistance(seat,ranges[0]),
        ringSeamGap:0, evidence:'project_assumption', status:'pending'};
      g.clampsPush(rec); return rec;
    };
    /* 具名薄封装：参数按交付件调用点口径（seat＝导线**顶面**，即中心线 + 0.00645）。
       ⚠ `hx`（片体半长）在现档构造里已不再参数化（片体固定 0.021×0.006×0.001）⇒ 保留形参仅为兼容旧调用。 */
    P.dropClampC=function(x,cy,cz,hx,wireId){ return P.jointClamp(g.PT().DROP_CLAMP_C, wireId||'contact-main',[x,cy+0.00645,cz],0.025,1,[x,cy,cz]); };
    P.dropClampM=function(x,cy,cz,halfLen,boltDx,rObj,wireId){ return P.jointClamp(g.PT().DROP_CLAMP_M, wireId||'messenger-main',[x,cy,cz],-0.025,-1,[]); };
    P.splitClampM=function(center,halfLen,boltDx,rObj,wireId){ return P.jointClamp(g.PT().SPLIT_CLAMP_M, wireId||'messenger-main',center,-0.025,-1,[]); };
    return P;
  
}




    /* t120 件31 定位线夹（按现档 0C457DD7A8758A01 重提；L2046/2047/2050） */

  return { createParts: createParts };
});
