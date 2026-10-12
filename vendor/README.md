# vendor/：离线运行需要的第三方文件

这个项目不联网、不维护服务器，所以浏览器里要用的库**直接放在仓库里**，
用经典 `<script src>` 加载（点击时才加载，见 `js/ocr.js`）。

| 文件 | 大小 | 来源 | 许可 |
|---|---|---|---|
| `pdfjs/` | — | pdfjs-dist（渲染 PDF、读文字层） | Apache-2.0 |
| `tesseract-core-simd-lstm.wasm.js` | 3.9MB | tesseract.js-core 7.0.0，`tesseract-core-simd-lstm.wasm.js`（wasm 已内联成 base64，不需要 fetch） | Apache-2.0 |
| `tesseract-eng-data.js` | 3.8MB | `@tesseract.js-data/eng@1.0.0` 的 `4.0.0_best_int/eng.traineddata.gz`，base64 内联成 `window.MURDOKU_TESS_ENG_GZ` | Apache-2.0 |

为什么要内联：应用是从 `file://` 打开的，浏览器会挡掉 Worker 的创建和 `fetch`/`.wasm` 拉取，
只有"经典脚本 + 内联字节"这条路能在离线状态下稳定工作（`js/ocr.js` 在主线程里调 core，
不建 Worker）。这两个文件只在用户点「🔤 读区域名（OCR）」时才会被加载。

重建方法（升级版本时）：

```bash
CORE=node_modules/.pnpm/tesseract.js-core@7.0.0/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js
cp "$CORE" vendor/tesseract-core-simd-lstm.wasm.js
node -e "const fs=require('fs');
const gz=fs.readFileSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz');
fs.writeFileSync('vendor/tesseract-eng-data.js','window.MURDOKU_TESS_ENG_GZ=\"'+gz.toString('base64')+'\";');"
```
