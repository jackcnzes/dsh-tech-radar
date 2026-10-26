/**
 * 统一 HTTP 客户端。
 *
 * 为什么不用 Harness 的 web_fetch 工具：本机 DNS 是 fake-IP 模式
 * (x.com -> 198.18.0.57)，Harness 的抓取器会把 198.18.0.0/15 判定为非公网地址
 * 并直接拒绝，所以 X / Instagram 必须走子进程直连。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(url, status, body) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 带超时和重试的 fetch。
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, headers?: Record<string,string>, method?: string, body?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function getText(url, opts = {}) {
  const {
    timeoutMs = 45_000,
    retries = 2,
    headers = {},
    method = 'GET',
    body,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        body,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      if (!response.ok) throw new HttpError(url, response.status, text.slice(0, 500));
      return text;
    } catch (error) {
      lastError = error;
      // 4xx（除 429）不重试，避免把配额打光
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) break;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** GET 并解析 JSON。 */
export async function getJson(url, opts = {}) {
  const text = await getText(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
  });
  return JSON.parse(text);
}

/** POST JSON。 */
export async function postJson(url, payload, opts = {}) {
  return getText(url, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 去掉 HTML 标签和常见实体，并把连续空白压成一个空格。 */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 稳定短哈希，用于内容去重。 */
export function contentId(text) {
  const normalized = String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
