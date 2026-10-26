#!/usr/bin/env node
/**
 * 本地 webhook 接收器，用来在没有真实 IM 机器人时验证推送链路。
 *
 *   node tools/mock-im.mjs 8899
 *
 * 收到的请求体会追加写入 tools/mock-im.log，并按各平台的成功响应格式返回。
 */

import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8899);
const logPath = new URL('./mock-im.log', import.meta.url).pathname;

const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;

  await appendFile(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), url: request.url, body })}\n`,
  );

  console.log(`[mock-im] ${request.method} ${request.url} ${body.length}B`);
  response.writeHead(200, { 'content-type': 'application/json' });
  // 同时满足飞书 {"code":0} 和钉钉 {"errcode":0} 的成功判定
  response.end(JSON.stringify({ code: 0, errcode: 0, msg: 'success' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-im] listening on http://127.0.0.1:${port}  →  ${logPath}`);
});
