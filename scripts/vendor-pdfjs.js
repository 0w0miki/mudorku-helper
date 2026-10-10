#!/usr/bin/env node
/*! 把 pdf.js 打包成经典 IIFE 脚本放进 vendor/pdfjs/（因为 file:// 下动态 import() 会被 CORS 拦，
 *  而经典 <script> + blob worker 可用）。
 *
 *  重新生成：pnpm run vendor:pdfjs
 *  产物：vendor/pdfjs/pdf.min.js（主库）
 *        vendor/pdfjs/pdf.worker.inline.js（worker 源码以字符串形式内联，避免 file:// 下 fetch 不到）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const OUT = path.resolve(__dirname, '..', 'vendor', 'pdfjs');
const TMP = path.join(require('node:os').tmpdir(), 'murdoku-pdfjs-' + process.pid);

const entryMain = path.join(TMP, 'entry-main.js');
const entryWorker = path.join(TMP, 'entry-worker.js');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(entryMain, "import * as pdfjsLib from 'pdfjs-dist';\nwindow.pdfjsLib = pdfjsLib;\n");
fs.writeFileSync(entryWorker, "import 'pdfjs-dist/build/pdf.worker.mjs';\n");

const common = {
  bundle: true, format: 'iife', minify: true, target: ['es2020'], legalComments: 'none',
  nodePaths: [path.resolve(__dirname, '..', 'node_modules')],   // 入口文件在临时目录里，得显式指路
};

esbuild.buildSync(Object.assign({ entryPoints: [entryMain], outfile: path.join(OUT, 'pdf.min.js') }, common));
esbuild.buildSync(Object.assign({ entryPoints: [entryWorker], outfile: path.join(TMP, 'worker.js') }, common));

const workerSrc = fs.readFileSync(path.join(TMP, 'worker.js'), 'utf8');
fs.writeFileSync(
  path.join(OUT, 'pdf.worker.inline.js'),
  '/* 由 scripts/vendor-pdfjs.js 生成，请勿手改 */\nwindow.__PDFJS_WORKER_SRC__=' + JSON.stringify(workerSrc) + ';\n'
);
fs.rmSync(TMP, { recursive: true, force: true });

const ver = require('pdfjs-dist/package.json').version;
console.log('pdfjs-dist ' + ver + ' → ' + OUT);
for (const f of ['pdf.min.js', 'pdf.worker.inline.js']) {
  console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB');
}
