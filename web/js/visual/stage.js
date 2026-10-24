/**
 * CoverStage —— 3D 专辑封面舞台
 *
 * 能力：
 *   1. 真实厚度的专辑封面，鼠标可任意拖动转动（带惯性）
 *   2. 切歌时封面以 N×N 拼图块状、波浪顺序翻转拼接成新封面
 *   3. 封面周围律动光效（背光 / 频谱环 / 光环 / 粒子），随音乐能量起伏，可整体关闭
 *   4. 从封面自动提取主题色供全局 UI 使用
 *
 * 光效组独立于封面组，因此旋转封面不会带动光效，二者互不影响。
 */

import * as THREE from 'three';

const SIZE = 2.35;          // 封面边长
const THICK = 0.155;        // 封面厚度
const TILES = 5;            // 拼图块行列数（5×5 = 25 块）
const TILE_Z = THICK / 2 + 0.006;

/* ---------------- 缓动 ---------------- */
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/* ---------------- 生成径向渐变纹理（光晕用） ---------------- */
function makeGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.32, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- 生成方形边框辉光纹理（贴住封面边缘向外绽开） ---------------- */
function makeFrameTexture() {
  const s = 512;
  // 亮线位置：配合外层平面尺寸 SIZE*1.26，使亮线正好落在封面边沿
  const edge = 52;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);

  // 由内向外衰减的柔光（画布边缘处最淡）
  for (let i = 0; i < 64; i++) {
    const t = i / 63;                 // 0 在亮线处 → 1 在画布边缘
    const x = edge * (1 - t);
    const a = 0.085 * Math.pow(1 - t, 2.4);
    ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(4)})`;
    ctx.lineWidth = 3.2;
    ctx.strokeRect(x, x, s - x * 2, s - x * 2);
  }

  // 亮线本体
  ctx.strokeStyle = 'rgba(255,255,255,0.62)';
  ctx.lineWidth = 2.6;
  ctx.strokeRect(edge, edge, s - edge * 2, s - edge * 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- 占位封面 ---------------- */
function makePlaceholderTexture() {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#221b3a');
  g.addColorStop(0.5, '#151626');
  g.addColorStop(1, '#0c1a22');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  const r = ctx.createRadialGradient(s * 0.34, s * 0.28, 0, s * 0.34, s * 0.28, s * 0.8);
  r.addColorStop(0, 'rgba(124,108,255,0.55)');
  r.addColorStop(1, 'rgba(124,108,255,0)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, (s / 2) * (i / 6), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.font = '500 150px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♪', s / 2, s / 2 + 8);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- 从图片提取主题色 ---------------- */
function extractPalette(img) {
  try {
    const s = 40;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, s, s);
    const data = ctx.getImageData(0, 0, s, s).data;

    let r = 0, g = 0, b = 0, n = 0;
    let bestSat = 0, br = 124, bg = 108, bb = 255;

    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i], pg = data[i + 1], pb = data[i + 2];
      const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
      const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
      if (lum < 18 || lum > 244) continue;
      r += pr; g += pg; b += pb; n++;

      // 找最鲜艳的颜色作为强调色
      const sat = max === 0 ? 0 : (max - min) / max;
      const score = sat * (0.45 + lum / 255);
      if (sat > 0.22 && score > bestSat) { bestSat = score; br = pr; bg = pg; bb = pb; }
    }
    if (!n) return { main: [124, 108, 255], accent: [124, 108, 255] };
    const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];

    // 提亮强调色，保证在深色背景上可见
    const lift = (v) => Math.round(Math.min(255, 58 + v * 0.82));
    return {
      main: avg,
      accent: [lift(br), lift(bg), lift(bb)]
    };
  } catch (_) {
    return { main: [124, 108, 255], accent: [124, 108, 255] };
  }
}

/* ================================================================== */

export class CoverStage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onPalette = opts.onPalette || (() => {});
    this.getLevels = opts.getLevels || (() => ({ bass: 0, energy: 0, spectrum: null }));

    this.glowEnabled = true;
    this.particlesEnabled = true;
    this.puzzleEnabled = true;
    this._fading = false;          // 淡入淡出过渡中：暂停每帧呼吸缩放，避免覆盖补间
    this.autoRotate = false;

    this.rotation = { x: -0.06, y: -0.42 };
    this.velocity = { x: 0, y: 0 };
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };
    this.pointerDownAt = 0;
    this.idleTimer = 0;

    this.hasCover = false;
    this.currentTex = null;
    this.transition = null;
    this.tileMap = [];
    this.backTileMap = [];   // 背面的拼图块（镜像布局）
    this.time = 0;
    this._lastNow = 0;
    this.flash = 0;          // 切歌时的一次性光爆强度

    // 平滑后的能量值
    this.smooth = { bass: 0, energy: 0, bands: new Float32Array(48) };

    this._initRenderer();
    this._initScene();
    this._initCover();
    this._initGlow();
    this._bindEvents();

    this.resize();
    this._start();
  }

  /* ---------------- 初始化 ---------------- */
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(0, 0, 6.4);
    this.camera.lookAt(0, 0, 0);

    // 光照：给封面侧边厚度提供立体感
    this.scene.add(new THREE.AmbientLight(0x8894b8, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(2.4, 3.2, 4.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7c6cff, 1.6);
    rim.position.set(-3, -1.6, -2.2);
    this.scene.add(rim);
    this.rimLight = rim;

    // 封面组（可旋转）
    this.coverGroup = new THREE.Group();
    this.scene.add(this.coverGroup);

    // 光效组（不随封面旋转）
    this.glowGroup = new THREE.Group();
    this.scene.add(this.glowGroup);
  }

  _initCover() {
    // --- 底板（提供厚度与侧边） ---
    const sideMat = new THREE.MeshStandardMaterial({
      color: 0x161826, roughness: 0.46, metalness: 0.72
    });
    const frontMat = new THREE.MeshStandardMaterial({ color: 0x0a0b12, roughness: 0.9 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x0d0e18, roughness: 0.7, metalness: 0.35 });

    const geo = new THREE.BoxGeometry(SIZE, SIZE, THICK);
    // BoxGeometry 材质顺序：+x, -x, +y, -y, +z, -z
    this.baseBox = new THREE.Mesh(geo, [sideMat, sideMat, sideMat, sideMat, frontMat, backMat]);
    this.coverGroup.add(this.baseBox);

    // --- 背面封面（转过去时也能看到图） ---
    const backGeo = new THREE.PlaneGeometry(SIZE, SIZE);
    this.backMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.backCover = new THREE.Mesh(backGeo, this.backMat);
    this.backCover.position.z = -THICK / 2 - 0.002;
    this.backCover.rotation.y = Math.PI;
    this.coverGroup.add(this.backCover);

    // --- 正面的 N×N 拼图块 ---
    this.tilesGroup = new THREE.Group();
    this.coverGroup.add(this.tilesGroup);

    const tileW = SIZE / TILES;
    const tileH = SIZE / TILES;
    // 略微放大消除接缝
    const tileGeo = new THREE.PlaneGeometry(tileW * 1.02, tileH * 1.02);

    this.placeholderTex = makePlaceholderTexture();

    for (let r = 0; r < TILES; r++) {
      for (let c = 0; c < TILES; c++) {
        const pivot = new THREE.Group();
        pivot.position.set(
          -SIZE / 2 + (c + 0.5) * tileW,
          SIZE / 2 - (r + 0.5) * tileH,
          TILE_Z
        );

        const mat = new THREE.MeshBasicMaterial({
          map: this._sliceTexture(this.placeholderTex, r, c),
          toneMapped: false
        });
        const mesh = new THREE.Mesh(tileGeo, mat);
        pivot.add(mesh);
        this.tilesGroup.add(pivot);

        this.tileMap.push({
          row: r, col: c, pivot, mesh, mat,
          baseZ: TILE_Z,
          baseRotY: 0,
          baseMat: mat
        });
      }
    }

    // --- 背面的 N×N 拼图块 ---
    // 背面整体绕 Y 轴转了 180°，所以位置要镜像 x、保留 y，
    // 这样从背后看到的分块位置和正面一一对应，翻块效果两面一致。
    this.backTilesGroup = new THREE.Group();
    this.coverGroup.add(this.backTilesGroup);

    for (let r = 0; r < TILES; r++) {
      for (let c = 0; c < TILES; c++) {
        const pivot = new THREE.Group();
        pivot.position.set(
          SIZE / 2 - (c + 0.5) * tileW,
          SIZE / 2 - (r + 0.5) * tileH,
          -TILE_Z
        );
        pivot.rotation.y = Math.PI;

        const mat = new THREE.MeshBasicMaterial({
          map: this._sliceTexture(this.placeholderTex, r, c),
          toneMapped: false
        });
        const mesh = new THREE.Mesh(tileGeo, mat);
        pivot.add(mesh);
        this.backTilesGroup.add(pivot);

        this.backTileMap.push({
          row: r, col: c, pivot, mesh, mat,
          baseZ: -TILE_Z,
          baseRotY: Math.PI,
          baseMat: mat
        });
      }
    }

    // 初始显示占位封面，保证空库时也有 3D 实体可以转动
    this._applyInstant(this.placeholderTex);
    this.backMat.map = this.placeholderTex;
    this.backMat.needsUpdate = true;
    this.hasCover = true;      // 视作已有封面，首曲切换时可直接播放拼图动画
    this.currentTex = this.placeholderTex;
    this.coverGroup.scale.setScalar(0.84);
    this.coverGroup.visible = true;
    this._popIn();
  }

  /** 从一张基准纹理切出某一格的子纹理 */
  _sliceTexture(baseTex, row, col) {
    const tex = baseTex.clone();
    tex.needsUpdate = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1 / TILES, 1 / TILES);
    tex.offset.set(col / TILES, 1 - (row + 1) / TILES);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  _initGlow() {
    // 光晕都位于封面之后，depthTest 保持开启，这样封面才能真正遮住它们
    // （此前用 depthTest:false 会让光晕盖在封面之上，把画面糊成一片白）

    // --- 背后主光晕 ---
    const glowTex = makeGlowTexture();
    this.glowMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.34,
      color: 0x7c6cff
    });
    this.backGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glowMat);
    this.backGlow.position.z = -0.62;
    this.backGlow.scale.setScalar(SIZE * 2.6);
    this.backGlow.renderOrder = -3;
    this.glowGroup.add(this.backGlow);

    // --- 更收紧的亮芯（贴边勾一圈呼吸光） ---
    this.coreMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.18,
      color: 0xffffff
    });
    this.coreGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.coreMat);
    this.coreGlow.position.z = -0.58;
    this.coreGlow.scale.setScalar(SIZE * 1.75);
    this.coreGlow.renderOrder = -2;
    this.glowGroup.add(this.coreGlow);

    // --- 封面边缘辉光框：从封面四周溢出的光，让实体"发光" ---
    const frameTex = makeFrameTexture();
    this.frameMat = new THREE.MeshBasicMaterial({
      map: frameTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.55,
      color: 0x7c6cff,
      side: THREE.DoubleSide   // 封面转到背面时光框依然在
    });
    this.frameGlow = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 1.26, SIZE * 1.26), this.frameMat);
    this.frameGlow.position.z = -0.135;   // 略在封面之后，光从边缘向外溢出
    this.frameGlow.renderOrder = -1;
    // 跟随封面旋转：光属于封面实体，转起来才不会脱节
    this.coverGroup.add(this.frameGlow);

    // --- 频谱环：48 根向外的光条 ---
    this.SPECTRUM_N = 48;
    this.spectrumBars = [];
    const barGeo = new THREE.PlaneGeometry(0.042, 1);
    barGeo.translate(0, 0.5, 0); // 底部对齐原点，便于沿径向伸展

    for (let i = 0; i < this.SPECTRUM_N; i++) {
      const angle = (i / this.SPECTRUM_N) * Math.PI * 2;
      const mat = new THREE.MeshBasicMaterial({
        color: 0x7c6cff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        opacity: 0.8
      });
      const bar = new THREE.Mesh(barGeo, mat);
      const R = SIZE * 0.56;
      bar.position.set(Math.cos(angle) * R, Math.sin(angle) * R, -0.30);
      bar.rotation.z = angle - Math.PI / 2;
      bar.scale.y = 0.02;
      bar.renderOrder = -1;
      this.spectrumBars.push({ mesh: bar, mat, angle, baseOpacity: 0.8 });
      this.glowGroup.add(bar);
    }

    // --- 光环 ---
    this.rings = [];
    for (let i = 0; i < 2; i++) {
      const r = SIZE * (0.78 + i * 0.22);
      const geo = new THREE.RingGeometry(r, r + 0.0035, 128);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.08 - i * 0.025,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.position.z = -0.32;
      ring.renderOrder = -1;
      this.rings.push({ mesh: ring, mat, speed: i === 0 ? 0.06 : -0.035 });
      this.glowGroup.add(ring);
    }

    // --- 粒子 ---
    const COUNT = 260;
    const pos = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = SIZE * (0.66 + Math.random() * 0.95);
      pos[i * 3] = Math.cos(a) * rr;
      pos[i * 3 + 1] = Math.sin(a) * rr * 0.92;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 1.2 - 0.45;
      seeds[i] = Math.random();
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.particleMat = new THREE.PointsMaterial({
      size: 0.026,
      color: 0xbfb6ff,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      sizeAttenuation: true
    });
    this.particles = new THREE.Points(pGeo, this.particleMat);
    this.particles.position.z = -0.3;
    this.particles.renderOrder = -1;
    this.particleSeeds = seeds;
    this.particleBase = pos.slice();
    this.glowGroup.add(this.particles);
  }

  /* ---------------- 交互 ---------------- */
  _bindEvents() {
    const el = this.canvas;

    // 容器尺寸变化（窗口缩放 / 布局调整）→ 重新计算渲染尺寸，防拉伸变形
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
    } else {
      window.addEventListener('resize', () => this.resize());
    }

    this._onDown = (e) => {
      this.dragging = true;
      this.pointerDownAt = performance.now();
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;
      this.velocity.x = 0;
      this.velocity.y = 0;
      el.setPointerCapture?.(e.pointerId);
    };

    this._onMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.x = e.clientX;
      this.lastPointer.y = e.clientY;

      const k = 0.0072;
      this.rotation.y += dx * k;
      this.rotation.x += dy * k;
      // 限制上下翻转，避免转到背面再也转不回来
      this.rotation.x = Math.max(-1.35, Math.min(1.35, this.rotation.x));

      this.velocity.y = Math.max(-0.085, Math.min(0.085, dx * k));
      this.velocity.x = Math.max(-0.085, Math.min(0.085, dy * k));
      this.idleTimer = 0;
    };

    this._onUp = (e) => {
      this.dragging = false;
      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);

    // 双击复位
    this._onDblClick = () => this.resetAngle();
    el.addEventListener('dblclick', this._onDblClick);
  }

  resetAngle() {
    this.rotation.x = -0.06;
    this.rotation.y = -0.42;
    this.velocity.x = 0;
    this.velocity.y = 0;
  }

  /* ---------------- 尺寸 ---------------- */
  resize() {
    const holder = this.canvas.parentElement;
    if (!holder) return;
    const w = holder.clientWidth || 600;
    const h = holder.clientHeight || 600;
    if (w < 2 || h < 2) return;

    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // 根据视口计算相机距离，让封面占据合适比例
    const vFov = (this.camera.fov * Math.PI) / 180;
    const margin = 1.18; // 给频谱环留一点呼吸空间
    const needH = (SIZE * margin) / (2 * Math.tan(vFov / 2));
    const needW = (SIZE * margin) / (2 * Math.tan(vFov / 2) * this.camera.aspect);
    this.camera.position.z = Math.max(needH, needW, 4.2);
    this.camera.updateProjectionMatrix();
  }

  /* ---------------- 封面设置 ---------------- */

  /** 加载纹理 */
  async _loadTexture(url) {
    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loader.load(url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          resolve(tex);
        },
        undefined,
        () => reject(new Error('封面加载失败'))
      );
    });
  }

  /**
   * 设置封面
   * @param {string} url 图片地址
   * @param {object} opt { puzzle:boolean, instant:boolean }
   */
  async setCover(url, opt = {}) {
    // stage 不自己决定用哪种模式，由调用方（状态机）显式指定
    const mode = opt.mode || (opt.instant || opt.puzzle === false ? 'instant' : 'animate');
    let tex;
    try {
      tex = await this._loadTexture(url);
    } catch (err) {
      console.warn('[stage] 封面加载失败，使用占位图', err);
      tex = this.placeholderTex;
    }

    // 纹理加载期间可能已经切到下一首了。此时绝不能应用，
    // 否则会出现"画面停在上一首、声音已经是下一首"的错位。
    if (opt.isCurrent && !opt.isCurrent()) {
      if (tex !== this.placeholderTex) {
        setTimeout(() => { try { tex.dispose(); } catch (_) {} }, 800);
      }
      return false;
    }

    // 提取主题色（用原始 image 画到小 canvas）
    try {
      if (tex.image) {
        const pal = extractPalette(tex.image);
        this.glowMat.color.setRGB(pal.accent[0] / 255, pal.accent[1] / 255, pal.accent[2] / 255);
        this.frameMat.color.setRGB(pal.accent[0] / 255, pal.accent[1] / 255, pal.accent[2] / 255);
        this.rimLight.color.setRGB(pal.accent[0] / 255, pal.accent[1] / 255, pal.accent[2] / 255);
        // 频谱条往白色偏一点，保证在彩色背景上也够亮
        const toWhite = (v) => (v * 0.52 + 255 * 0.48) / 255;
        for (const b of this.spectrumBars) {
          b.mat.color.setRGB(toWhite(pal.accent[0]), toWhite(pal.accent[1]), toWhite(pal.accent[2]));
        }
        this.particleMat.color.setRGB(
          Math.min(1, pal.accent[0] / 255 * 1.1 + 0.1),
          Math.min(1, pal.accent[1] / 255 * 1.1 + 0.1),
          Math.min(1, pal.accent[2] / 255 * 1.1 + 0.3)
        );
        this.onPalette(pal);
      }
    } catch (_) {}

    if (!this.hasCover) {
      this._applyInstant(tex);
      this.hasCover = true;
      this.currentTex = tex;
      // 首次弹出动画
      this.coverGroup.visible = true;
      this._popIn();
      return;
    }

    if (mode === 'animate') {
      // 等动画真正结束才返回，状态机据此判断视觉是否完成
      await this._startPuzzle(tex);
    } else if (mode === 'fade') {
      // 关闭拼图时的降级动画：旧封面淡出 → 新封面淡入（带轻微缩放）
      await this._fadeSwap(tex, opt.isCurrent);
    } else {
      this.finishPuzzle();
      this._applyInstant(tex);
    }
    this.currentTex = tex;
  }

  /** 封面所有面片材质（拼块 + 底板） */
  _coverMats() {
    const mats = [];
    const push = (m) => { if (m && mats.indexOf(m) === -1) mats.push(m); };
    this.tileMap.concat(this.backTileMap).forEach(t => push(t.mat));
    push(this.backMat);
    return mats;
  }

  /** 简易补间（rAF + smoothstep），返回 Promise 便于串行拼接 */
  _tween(dur, fn) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const p = clamp01((now - start) / dur);
        fn(p * p * (3 - 2 * p), p);          // smoothstep 缓动
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /**
   * 平滑切入切出（拼图关闭时使用）
   * 旧封面向外淡出并轻微放大 → 换图 → 新封面略小、从内侧淡入到正常大小
   *
   * 注意：主循环 _tick 每帧都会写 coverGroup.scale（低频呼吸）。
   * 所以整个过渡期间必须用 _fading 把呼吸缩放挡住，否则缩放补间会被立刻覆盖，
   * 用户只会看到透明度变化 —— 这正是之前"关了拼图就显得生硬"的原因。
   */
  async _fadeSwap(tex, isCurrent) {
    if (this._puzzleResolve) {           // 上一段拼图动画先收尾，避免 Promise 悬挂
      const r = this._puzzleResolve;
      this._puzzleResolve = null;
      r();
    }
    this._popping = false;
    this._fading = true;
    this.transition = null;

    const mats = this._coverMats();
    mats.forEach((m) => { m.transparent = true; m.needsUpdate = true; });
    const setOpacity = (v) => { for (const m of mats) m.opacity = v; };
    const reset = () => {
      setOpacity(1);
      mats.forEach((m) => { m.transparent = false; m.needsUpdate = true; });
      this.coverGroup.scale.setScalar(1);
      this.coverGroup.position.z = 0;
      this._fading = false;
    };

    this.coverGroup.visible = true;

    // 1) 旧封面向外淡出：放大 6% + 微微后退，180ms
    await this._tween(180, (e) => {
      setOpacity(1 - e);
      this.coverGroup.scale.setScalar(1 + 0.06 * e);
      this.coverGroup.position.z = -0.1 * e;
    });

    this._applyInstant(tex);

    // 已经被下一首顶替：直接落位，不再播入场
    if (isCurrent && !isCurrent()) { reset(); return false; }

    // 2) 新封面从内侧淡入：92% → 100%，带一点回弹感，340ms
    await this._tween(340, (e, raw) => {
      // raw 是线性进度，用来叠一个轻微的 easeOutBack（结尾不过冲太多，避免晃动）
      const back = raw < 1 ? 1 - Math.pow(1 - raw, 3) + Math.sin(raw * Math.PI) * 0.035 : 1;
      setOpacity(Math.min(1, raw * 1.25));
      this.coverGroup.scale.setScalar(0.92 + 0.08 * back);
      this.coverGroup.position.z = -0.1 * (1 - back);
    });

    reset();
    return true;
  }

  /** 立即切换（不带动画） */
  _applyInstant(tex) {
    for (const t of this.tileMap.concat(this.backTileMap)) {
      const sliced = this._sliceTexture(tex, t.row, t.col);
      t.mat.map = sliced;
      t.mat.needsUpdate = true;
      this._disposeOldMap(t);
      t.pivot.rotation.y = t.baseRotY;
      t.pivot.position.z = t.baseZ;
    }
    // 底板也同步，翻块缝隙里露出的就是这张图
    this.backMat.map = tex;
    this.backMat.needsUpdate = true;
  }

  _disposeOldMap(tile) {
    const old = tile._lastMap;
    if (old && old !== tile.mat.map && old !== this.placeholderTex) {
      // 延迟释放，避免正在渲染的帧还在用
      setTimeout(() => { try { old.dispose(); } catch (_) {} }, 1200);
    }
    tile._lastMap = tile.mat.map;
  }

  _popIn() {
    const start = performance.now();
    const dur = 900;
    this._popping = true;
    const tick = (now) => {
      const p = clamp01((now - start) / dur);
      const k = easeOutBack(p);
      this.coverGroup.scale.setScalar(0.62 + 0.38 * k);
      if (p < 1) requestAnimationFrame(tick);
      else {
        this.coverGroup.scale.setScalar(1);
        this._popping = false;
      }
    };
    requestAnimationFrame(tick);
  }

  /**
   * 拼图切换动画
   * 每块依次翻转：转到侧面 → 换纹理 → 转回正面
   */
  _startPuzzle(newTex) {
    const now = performance.now();
    const DURATION = 620;

    // 上一个转场还没结束就被顶替，先让它 resolve，避免 Promise 悬挂
    if (this._puzzleResolve) {
      const r = this._puzzleResolve;
      this._puzzleResolve = null;
      r();
    }

    // 切歌瞬间来一次光爆，让转场更有冲击力
    this.flash = 1;

    this.transition = {
      start: now,
      items: this.tileMap.concat(this.backTileMap).map(t => {
        // 对角波浪扩散。jitter 用行列算出确定值，
        // 这样正反两面的同一块会同时翻，视觉上才是"一整块卡片在动"
        const wave = (t.row + t.col) * 46;
        const jitter = ((t.row * 37 + t.col * 61) % 97) * 1.1;
        return {
          tile: t,
          delay: wave + jitter,
          duration: DURATION,
          swapped: false,
          newMap: this._sliceTexture(newTex, t.row, t.col),
          // 轻微的随机位移，让拼块更有"飞入"感
          ox: (Math.random() - 0.5) * 0.06,
          oy: (Math.random() - 0.5) * 0.06
        };
      }),
      newTex
    };

    // 背面的封面同步更新（不参与拼图）
    this.backMat.map = newTex;
    this.backMat.needsUpdate = true;

    return new Promise((resolve) => { this._puzzleResolve = resolve; });
  }

  /** 立即结束正在进行的拼图动画（中途 seek / 切到 instant 模式时用） */
  finishPuzzle() {
    const tr = this.transition;
    if (!tr) {
      if (this._puzzleResolve) {
        const r = this._puzzleResolve;
        this._puzzleResolve = null;
        r();
      }
      return false;
    }

    for (const it of tr.items) {
      if (!it.swapped) {
        this._disposeOldMap(it.tile);
        it.tile.mat.map = it.newMap;
        it.tile.mat.needsUpdate = true;
        it.swapped = true;
      }
      it.tile.pivot.rotation.y = it.tile.baseRotY;
      it.tile.pivot.position.z = it.tile.baseZ;
    }
    this.transition = null;

    if (this._puzzleResolve) {
      const r = this._puzzleResolve;
      this._puzzleResolve = null;
      r();
    }
    return true;
  }

  /** 每帧更新拼图动画 */
  _updatePuzzle(now) {
    const tr = this.transition;
    if (!tr) return;
    let allDone = true;

    for (const it of tr.items) {
      const t = (now - tr.start - it.delay) / it.duration;
      if (t < 0) { allDone = false; continue; }
      const p = clamp01(t);
      if (p >= 1) {
        it.tile.pivot.rotation.y = it.tile.baseRotY;
        it.tile.pivot.position.z = it.tile.baseZ;
        continue;
      }
      allDone = false;

      const tile = it.tile;
      // 正面的块朝 +z 弹，背面的块朝 -z 弹，两边都是"向外翻"
      const zDir = tile.baseRotY === 0 ? 1 : -1;

      if (p < 0.5) {
        // 前半段：转离正面
        const k = easeInOutCubic(p * 2);
        tile.pivot.rotation.y = tile.baseRotY - (Math.PI / 2) * k;
        tile.pivot.position.z = tile.baseZ + Math.sin(k * Math.PI) * 0.42 * zDir;
      } else {
        // 后半段：换图后转回正面
        if (!it.swapped) {
          this._disposeOldMap(tile);
          tile.mat.map = it.newMap;
          tile.mat.needsUpdate = true;
          it.swapped = true;
        }
        const raw = (p - 0.5) * 2;
        const k = easeOutBack(raw);
        tile.pivot.rotation.y = tile.baseRotY + (Math.PI / 2) * (1 - k);
        const clamped = clamp01(k);
        tile.pivot.position.z = tile.baseZ + Math.sin((1 - clamped) * Math.PI) * 0.42 * zDir;
      }
    }

    if (allDone) {
      this.transition = null;
      // 清理没换掉的块（理论上不会发生）
      for (const it of tr.items) {
        if (!it.swapped) {
          this._disposeOldMap(it.tile);
          it.tile.mat.map = it.newMap;
          it.tile.mat.needsUpdate = true;
        }
      }
      // 通知等待"视觉完成"的调用方（状态机）
      if (this._puzzleResolve) {
        const r = this._puzzleResolve;
        this._puzzleResolve = null;
        r();
      }
    }
  }

  /* ---------------- 开关 ---------------- */
  setGlow(on) {
    this.glowEnabled = on;
    this.glowGroup.visible = on;
    // 边缘辉光挂在封面组里（要跟随旋转），需要单独控制
    if (this.frameGlow) this.frameGlow.visible = on;
  }
  setParticles(on) {
    this.particlesEnabled = on;
    this.particles.visible = on;
  }
  setAutoRotate(on) { this.autoRotate = on; }
  setPuzzle(on) { this.puzzleEnabled = on; }

  /* ---------------- 主循环 ---------------- */
  _start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _tick() {
    const now = performance.now();
    const dt = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.05) : 0.016;
    this._lastNow = now;
    this.time += dt;

    /* --- 旋转与惯性 --- */
    if (!this.dragging) {
      // 惯性衰减
      this.rotation.y += this.velocity.y;
      this.rotation.x += this.velocity.x;
      this.rotation.x = Math.max(-1.35, Math.min(1.35, this.rotation.x));
      this.velocity.y *= 0.895;
      this.velocity.x *= 0.895;
      if (Math.abs(this.velocity.y) < 0.00012) this.velocity.y = 0;
      if (Math.abs(this.velocity.x) < 0.00012) this.velocity.x = 0;

      if (this.autoRotate) this.rotation.y += dt * 0.22;

      // 静止一段时间后，轻微回正倾斜（不影响 y 轴角度）
      this.idleTimer += dt;
      if (this.idleTimer > 4 && !this.autoRotate) {
        this.rotation.x += (-0.06 - this.rotation.x) * Math.min(1, dt * 0.9);
      }
    } else {
      this.idleTimer = 0;
    }

    // 轻微呼吸感：封面本身随低频轻微起伏
    const breath = Math.sin(this.time * 0.8) * 0.014;
    this.coverGroup.rotation.x = this.rotation.x + breath * 0.4;
    this.coverGroup.rotation.y = this.rotation.y;
    this.coverGroup.rotation.z = Math.sin(this.time * 0.5) * 0.006;
    if (!this._popping && !this._fading) {
      const s = 1 + this.smooth.bass * 0.016;
      this.coverGroup.scale.setScalar(s);
    }

    /* --- 能量平滑 --- */
    const lv = this.getLevels() || {};
    const targetBass = lv.bass || 0;
    const targetEnergy = lv.energy || 0;
    const lerp = (a, b, k) => a + (b - a) * k;
    this.smooth.bass = lerp(this.smooth.bass, targetBass, 0.28);
    this.smooth.energy = lerp(this.smooth.energy, targetEnergy, 0.22);

    /* --- 拼图动画 --- */
    this._updatePuzzle(now);

    /* --- 光效 --- */
    // 切歌光爆衰减
    this.flash = Math.max(0, this.flash - dt * 1.5);

    if (this.glowGroup.visible) {
      const bass = this.smooth.bass;
      const energy = this.smooth.energy;
      const boost = 1 + this.flash * 1.9;

      // 主光晕：随低频脉动
      const glowScale = SIZE * (2.5 + bass * 0.7 + this.flash * 1.4 + Math.sin(this.time * 1.6) * 0.035);
      this.backGlow.scale.setScalar(glowScale);
      this.glowMat.opacity = (0.14 + bass * 0.62) * boost;

      this.coreGlow.scale.setScalar(SIZE * (1.62 + energy * 0.34));
      this.coreMat.opacity = (0.09 + energy * 0.20) * boost;

      // 边缘辉光：低频一来就明显亮起并向外扩
      this.frameMat.opacity = (0.34 + bass * 0.6) * boost;
      const fk = 1 + bass * 0.032 + this.flash * 0.06;
      this.frameGlow.scale.set(fk, fk, 1);

      // 频谱环：48 根光条镜像映射到 48 个频段，绕封面形成对称的声场
      const spec = lv.spectrum;
      const N = this.spectrumBars.length;
      const half = N / 2;
      for (let i = 0; i < N; i++) {
        const bar = this.spectrumBars[i];
        let v;
        if (spec && spec.length) {
          const k = i < half ? i : N - 1 - i;         // 关于 0° 轴对称
          const idx = Math.min(spec.length - 1, Math.floor((k / half) * spec.length));
          v = spec[idx] || 0;
        } else {
          v = 0.12 + Math.abs(Math.sin(this.time * 1.2 + i * 0.35)) * 0.18;
        }
        v = Math.max(0, Math.min(1, v));
        const targetLen = 0.045 + v * 0.58;
        bar.mesh.scale.y += (targetLen - bar.mesh.scale.y) * 0.38;
        bar.mat.opacity = 0.18 + v * 0.72;
      }

      // 光环缓慢旋转
      for (const r of this.rings) {
        r.mesh.rotation.z += r.speed * dt;
        r.mat.opacity = 0.06 + energy * 0.12;
      }

      // 粒子
      if (this.particles.visible) {
        const arr = this.particles.geometry.attributes.position.array;
        const base = this.particleBase;
        for (let i = 0; i < this.particleSeeds.length; i++) {
          const s = this.particleSeeds[i];
          const sp = 0.06 + s * 0.1;
          arr[i * 3 + 1] = base[i * 3 + 1] + Math.sin(this.time * sp + s * 10) * 0.1;
          arr[i * 3] = base[i * 3] + Math.cos(this.time * sp * 0.8 + s * 7) * 0.08;
        }
        this.particles.geometry.attributes.position.needsUpdate = true;
        this.particles.rotation.z += dt * 0.012;
        this.particleMat.opacity = 0.16 + energy * 0.42;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.renderer.dispose();
  }
}
