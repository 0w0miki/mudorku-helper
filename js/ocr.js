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
      // 区域名全是全大写短词，限制字符集 + 单行模式能显著减少乱猜
      api.SetVariable('tessedit_char_whitelist', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ');
      api.SetVariable('tessedit_pageseg_mode', '7');
      api.SetVariable('user_defined_dpi', '300');
      engine = { M, api };
      return engine;
    })();
    return loading.catch(err => { loading = null; throw err; });
  }

  /** 每个徽章裁出来放大 → PNG → 交给 tesseract 读一行字 */
  async function readBadges(raster, badges, opts) {
    const opt = opts || {};
    const { M, api } = await ready(opt.onStatus);
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

  root.MurdokuOCR = {
    ready,
    readBadges,
    /** 引擎已经加载好了吗（UI 用它决定按钮文字） */
    isLoaded: () => !!engine,
    sources: { core: CORE_SRC, data: DATA_SRC },
  };
})(typeof window !== 'undefined' ? window : globalThis);
