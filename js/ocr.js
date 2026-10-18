/*! Mudoku Helper — ocr.js
 * 截图没有文字层时读区域名：把 `vendor/` 里的 tesseract 核心（LSTM-only wasm）+ 英文模型
 * **按需**加载，在**主线程**跑 —— `file://` 下浏览器会挡掉 Worker 的创建与 wasm/fetch 拉取，
 * 而"经典脚本 + 内联 wasm + 内联模型"这条路完全不联网，反而最稳。
 *
 * 只有用户点了「🔤 读区域名（OCR）」才会加载这两个文件（共约 7.8MB），平时一点不影响。
 * 实测（contest 截图 17 个徽章，4× 放大、单行模式）：字母准确率 99%，
 * 唯一的系统性错误是"词间空格丢掉"——那部分交给 labels.mergeOcrText 用字块间距补回来。
 */
(function (root) {
  'use strict';

  const CORE_SRC = 'vendor/tesseract-core-simd-lstm.wasm.js';
  const DATA_SRC = 'vendor/tesseract-eng-data.js';
  const ZOOM = 4;                    // 徽章字高只有十几像素，放大 4× 后识别明显更稳

  let loading = null;
  let engine = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('加载失败：' + src + '（vendor 文件在不在？）'));
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /** 模型是 .gz（2.9MB），解压后写进 wasm 的虚拟文件系统 */
  async function gunzip(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('这个浏览器不支持 DecompressionStream，无法解压语言模型（Chrome / Edge 可以）');
    }
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new Uint8Array(out);
  }

  /** 加载 + 初始化（只做一次） */
  function ready(onStatus) {
    if (engine) return Promise.resolve(engine);
    if (loading) return loading;
    loading = (async () => {
      const say = m => { if (onStatus) onStatus(m); };
      say('加载 OCR 核心（3.8MB，只需一次）');
      await loadScript(CORE_SRC);
      say('加载英文模型（3.8MB，只需一次）');
      await loadScript(DATA_SRC);
      if (typeof root.TesseractCore !== 'function') throw new Error('OCR 核心没就绪（vendor 下的 tesseract 文件缺失？）');
      if (typeof root.MURDOKU_TESS_ENG_GZ !== 'string') throw new Error('英文模型没就绪（vendor/tesseract-eng-data.js 缺失？）');
      say('解压语言模型…');
      const model = await gunzip(b64ToBytes(root.MURDOKU_TESS_ENG_GZ));
      say('初始化识别引擎…');
      const M = await root.TesseractCore({ TesseractProgress() {} });
      M.FS.writeFile('./eng.traineddata', model);
      const api = new M.TessBaseAPI();
      if (api.Init(null, 'eng', 1) === -1) throw new Error('识别引擎初始化失败（语言模型不完整？）');
      // 字符集**每次调用**按需设置（见 readBadges 的 opt.chars）：
      // 区域名徽章是全大写短词，限制成 A–Z 能显著减少乱猜 ✓；
      // 但图例物品名是**小写**（fire / tree / chair…），用大写字符集会把它们全丢掉 ✗（踩过）
      api.SetVariable('tessedit_pageseg_mode', '7');
      api.SetVariable('user_defined_dpi', '300');
      engine = { M, api };
      return engine;
    })();
    return loading.catch(err => { loading = null; throw err; });
  }

  /** 每个徽章裁出来放大 → PNG → 交给 tesseract 读一行字 */
  const UPPER_ONLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';                      // 区域名徽章：全大写
  const WORDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'- ";  // 物品名/说明行

  async function readBadges(raster, badges, opts) {
    const opt = opts || {};
    const { M, api } = await ready(opt.onStatus);
    api.SetVariable('tessedit_char_whitelist', opt.chars != null ? opt.chars : UPPER_ONLY);
    const src = document.createElement('canvas');
    src.width = raster.width; src.height = raster.height;
    const sctx = src.getContext('2d');
    const frame = sctx.createImageData(raster.width, raster.height);
    frame.data.set(raster.data);
    sctx.putImageData(frame, 0, 0);

    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const out = [];
    for (let i = 0; i < badges.length; i++) {
      const b = badges[i];
      const z = opt.zoom || ZOOM;
      cv.width = Math.max(8, Math.round(b.w * z));
      cv.height = Math.max(8, Math.round(b.h * z));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, cv.width, cv.height);
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      M.FS.writeFile('/input', bytes);
      if (api.SetImageFile(1, 0) === 1) throw new Error('第 ' + (i + 1) + ' 个标签的图读不进去');
      api.Recognize(null);
      const text = api.GetUTF8Text();
      api.Clear();
      out.push({ text: text || '', badge: b, x: b.x, y: b.y });
      if (opt.onProgress) opt.onProgress(i + 1, badges.length);
    }
    return out;
  }

  /**
   * 对**一整块区域**做一次 OCR，返回**词级框**（tesseract 的 TSV 输出）。
   * 为什么要这个：以前只能"先按行墨量猜出名字排、再按列投影猜名字框" ✗ ——
   * 猜出来的框会互相粘连（"flowers shark"）。词级框是 OCR 自己给出的，直接准 ✓
   * @param {object} raster 栅格
   * @param {{x,y,w,h}} box 要识别的区域（栅格坐标）
   * @param {{zoom?:number,psm?:number,chars?:string,minConf?:number,onStatus?:Function}} [opts]
   * @returns {Promise<Array<{text:string,x:number,y:number,w:number,h:number,conf:number,line:number}>>}
   */
  async function readWords(raster, box, opts) {
    const opt = opts || {};
    const { M, api } = await ready(opt.onStatus);
    // **大区域要分块**：整幅放大 5 倍会超过 OCR 能处理的尺寸，结果会被悄悄截断 ✗
    // （真实图例截图 1210×772 时就漏掉了整组名字）。分块后每块也更容易识别小字 ✓
  const maxSide = opt.maxTile || 300;  // 放 5 倍后 1500px，稳在 OCR 的舒适区
    if (box.w > maxSide * 1.6 || box.h > maxSide * 1.6) {
      const parts = [];
   const step = Math.round(maxSide * 0.72);        // 28% 重叠：每个词至少完整落在某一块里
      for (let y = box.y; y < box.y + box.h; y += step) {
        for (let x = box.x; x < box.x + box.w; x += step) {
          const tw = Math.min(maxSide, box.x + box.w - x);
          const th = Math.min(maxSide, box.y + box.h - y);
          if (tw < 12 || th < 12) continue;
          const part = await readWords(raster, { x, y, w: tw, h: th }, Object.assign({}, opt, { maxTile: Infinity }));
          for (const w of part) parts.push(w);
        }
      }
      // 去重：被别的词框"含住大半"的碎片丢掉（分块边缘会把词切成 "tombstc"+"tone" ✗）
      const inside = (a, b2) => {
        const ox = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
        const oy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
        return ox > 0 && oy > 0 && (ox * oy) / (a.w * a.h) > 0.7;
      };
      const out = [];
      for (const w of parts.slice().sort((a, b2) => (b2.w * b2.h) - (a.w * a.h))) {
        if (out.some(q => q.text === w.text && Math.abs(q.x - w.x) < 3 && Math.abs(q.y - w.y) < 3)) continue;
        if (out.some(q => inside(w, q))) continue;             // 小块里读出来的半截词
        out.push(w);
      }
      return out;
    }
    api.SetVariable('tessedit_char_whitelist', opt.chars != null ? opt.chars : WORDS);
    api.SetVariable('tessedit_pageseg_mode', String(opt.psm != null ? opt.psm : 11)); // 11 = 稀疏文字
    const z = opt.zoom || 3;
    const bx = Math.max(0, Math.round(box.x)), by = Math.max(0, Math.round(box.y));
    const bw = Math.max(1, Math.min(raster.width - bx, Math.round(box.w)));
    const bh = Math.max(1, Math.min(raster.height - by, Math.round(box.h)));
    const src = document.createElement('canvas');
    src.width = raster.width; src.height = raster.height;
    const sctx = src.getContext('2d');
    const frame = sctx.createImageData(raster.width, raster.height);
    frame.data.set(raster.data);
    sctx.putImageData(frame, 0, 0);
    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(bw * z));
    cv.height = Math.max(8, Math.round(bh * z));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, bx, by, bw, bh, 0, 0, cv.width, cv.height);
    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    M.FS.writeFile('/input', bytes);
    if (api.SetImageFile(1, 0) === 1) throw new Error('这块图读不进去');
    api.Recognize(null);
    const tsv = api.GetTSVText() || '';
    api.Clear();
    const out = [];
    for (const line of tsv.split('\n')) {
      if (!line) continue;
      const f = line.split('\t');
      if (f.length < 12) continue;
      if (Number(f[0]) !== 5) continue;                       // 5 = word 级
      const conf = Number(f[10]);
      const text = String(f.slice(11).join('\t')).trim();
      if (!text || !(conf >= (opt.minConf != null ? opt.minConf : 20))) continue;
      out.push({
        text, conf,
        x: bx + Number(f[6]) / z, y: by + Number(f[7]) / z,
        w: Number(f[8]) / z, h: Number(f[9]) / z,
        line: Number(f[4]),
      });
    }
    return out;
  }

  root.MurdokuOCR = {
    UPPER_ONLY,
    WORDS,
    readWords,
    ready,
    readBadges,
    /** 引擎已经加载好了吗（UI 用它决定按钮文字） */
    isLoaded: () => !!engine,
    sources: { core: CORE_SRC, data: DATA_SRC },
  };
})(typeof window !== 'undefined' ? window : globalThis);
