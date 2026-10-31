/**
 * Cloudflare Worker 代理脚本
 * 特性：
 *   1) 内置 Web UI，首页带起始 URL 输入框
 *   2) 支持 Cookie：自动保存上游 Set-Cookie 并以「按目标域名隔离」的方式回传
 *   3) 支持重定向：默认自动跟随 3xx，并把上游 Cookie 在每一跳累积
 *   4) 自动改写 HTML 中的链接/资源地址，使其仍走本代理（href/src/action/style url()/meta refresh）
 *
 * 部署：将该文件作为 Worker 的入口（如 worker.js / index.js），无需 KV。
 */

const PROXY_PATH = '/proxy';

/* ---------- 工具函数 ---------- */

function hostKey(host) {
  // 生成可用于 Cookie 名的 key（去掉 base64 的 = + /）
  return btoa(host).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function cookieNameForHost(host) {
  return 'pj_' + hostKey(host);
}

// 解析浏览器发给 Worker 自身的 Cookie，取出我们存起来的「各目标域名 -> {name:value}」
function parseWorkerCookies(header) {
  const jar = {}; // key -> {name: value}
  if (!header) return jar;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (name.startsWith('pj_')) {
      const key = name.slice(3);
      try {
        jar[key] = JSON.parse(decodeURIComponent(val));
      } catch (e) {
        /* 忽略损坏数据 */
      }
    }
  }
  return jar;
}

// 解析上游的单个 Set-Cookie，更新到 jarObj
function applySetCookie(setCookieStr, jarObj) {
  if (!setCookieStr) return;
  const firstPair = setCookieStr.split(';')[0];
  const eq = firstPair.indexOf('=');
  if (eq < 0) return;
  const n = firstPair.slice(0, eq).trim();
  const v = firstPair.slice(eq + 1).trim();
  const lower = setCookieStr.toLowerCase();

  // 判断是否过期（需删除）
  const maxAge = (lower.match(/max-age\s*=\s*(-?\d+)/) || [])[1];
  const expires = (lower.match(/expires\s*=\s*([^;]+)/) || [])[1];
  let expired = false;
  if (maxAge !== undefined) {
    if (parseInt(maxAge, 10) <= 0) expired = true;
  } else if (expires) {
    const d = new Date(expires.trim());
    if (!isNaN(d.getTime()) && d.getTime() <= Date.now()) expired = true;
  }

  if (expired) delete jarObj[n];
  else jarObj[n] = v;
}

// 把相对/绝对地址改写成仍走本代理的绝对地址
function proxify(val, baseUrl) {
  if (!val) return val;
  let abs;
  try {
    abs = new URL(val, baseUrl).toString();
  } catch (e) {
    return val;
  }
  if (!/^https?:\/\//i.test(abs)) return val; // 只代理 http/https
  return PROXY_PATH + '?url=' + encodeURIComponent(abs);
}

// 改写 HTML 中的资源地址
function rewriteHtml(html, baseUrl) {
  // 常见属性
  html = html.replace(
    /(href|src|action|data-src|poster|codebase)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (m, attr, dq, sq) => {
      const val = dq !== undefined ? dq : sq;
      return attr + '="' + proxify(val, baseUrl) + '"';
    }
  );
  // CSS url(...)
  html = html.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, val) => {
    return 'url(' + q + proxify(val, baseUrl) + q + ')';
  });
  // <meta http-equiv="refresh" content="0; url=...">
  html = html.replace(
    /(content\s*=\s*["']?\d+\s*;\s*url\s*=\s*)(["']?)([^"'>]+)\2/gi,
    (m, pre, q, val) => pre + q + proxify(val, baseUrl) + q
  );
  return html;
}

function isHtml(contentType) {
  return !!contentType && /^text\/html/i.test(contentType);
}

/* ---------- Web UI ---------- */

const WEBUI = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Worker 代理</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background:#f5f6f8; }
  header { background:#1f2937; color:#fff; padding:12px 16px; }
  header h1 { margin:0 0 10px; font-size:16px; font-weight:600; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input, select, button, textarea { font-size:14px; border-radius:6px; border:1px solid #d1d5db; padding:8px 10px; }
  #url { flex:1; min-width:240px; }
  button { background:#2563eb; color:#fff; border:none; cursor:pointer; }
  button:hover { background:#1d4ed8; }
  .adv { width:100%; margin-top:8px; display:none; }
  .adv.show { display:block; }
  textarea { width:100%; min-height:54px; font-family:monospace; }
  .toggle { background:#374151; }
  #status { margin-left:auto; font-size:12px; color:#9ca3af; }
  iframe { width:100%; height:calc(100vh - 120px); border:none; background:#fff; }
</style>
</head>
<body>
<header>
  <h1>Cloudflare Worker 代理</h1>
  <div class="row">
    <input id="url" placeholder="输入要访问的网址，例如 https://example.com" />
    <select id="method">
      <option>GET</option>
      <option>POST</option>
    </select>
    <button onclick="go()">访问</button>
    <button class="toggle" onclick="toggleAdv()">高级</button>
    <span id="status"></span>
  </div>
  <div id="adv" class="adv">
    <textarea id="cookie" placeholder="自定义 Cookie（可选），格式： name1=value1; name2=value2"></textarea>
  </div>
</header>
<iframe id="view"></iframe>
<script>
function toggleAdv(){
  document.getElementById('adv').classList.toggle('show');
}
function go(){
  var u = document.getElementById('url').value.trim();
  if(!u) return;
  if(!/^https?:\\/\\//i.test(u)) u = 'https://' + u;
  var params = '?url=' + encodeURIComponent(u);
  var cookie = document.getElementById('cookie').value.trim();
  if(cookie) params += '&c=' + encodeURIComponent(cookie);
  var target = '/proxy' + params;
  document.getElementById('status').textContent = '加载中…';
  var view = document.getElementById('view');
  view.onload = function(){
    var st = document.getElementById('status');
    try { st.textContent = '已加载：' + (view.contentWindow.location.href || u); }
    catch(e){ st.textContent = '已加载'; }
  };
  view.src = target;
}
document.getElementById('url').addEventListener('keydown', function(e){
  if(e.key === 'Enter') go();
});
</script>
</body>
</html>`;

/* ---------- 代理核心 ---------- */

async function handleProxy(request) {
  const reqUrl = new URL(request.url);
  const targetRaw = reqUrl.searchParams.get('url');
  if (!targetRaw) {
    return new Response('缺少 url 参数，例如 /proxy?url=https://example.com', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  let target;
  try {
    target = new URL(targetRaw);
  } catch (e) {
    return new Response('无效的 URL: ' + targetRaw, { status: 400 });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return new Response('仅支持 http/https 协议', { status: 400 });
  }

  // 1) 读取本 Worker 已保存的 Cookie（按目标域名隔离）
  const jar = parseWorkerCookies(request.headers.get('Cookie'));
  const key = hostKey(target.host);
  const cookies = jar[key] || {};

  // 2) 合并用户自定义 Cookie（来自 Web UI 的 &c=）
  const customCookie = reqUrl.searchParams.get('c');
  if (customCookie) {
    for (const part of customCookie.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const n = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (n) cookies[n] = v;
    }
  }

  // 3) 构造转发给上游的请求头
  const init = {
    method: request.method,
    redirect: 'follow', // 自动跟随重定向，并在每一跳累积 Cookie
    headers: {},
  };
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'cookie' ||
      lk === 'connection' ||
      lk === 'content-length' ||
      lk === 'accept-encoding' ||
      lk.startsWith('cf-') ||
      lk.startsWith('x-forwarded-')
    ) {
      continue;
    }
    init.headers[k] = v;
  }
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
  if (cookieHeader) init.headers['Cookie'] = cookieHeader;

  // 非 GET/HEAD 且存在请求体时，原样转发
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ct = request.headers.get('Content-Type') || '';
    if (!/multipart\/form-data/i.test(ct)) {
      init.body = request.body;
    } else {
      // multipart 不能直接 stream（需重新封装），这里读取后转发
      init.body = await request.arrayBuffer();
    }
  }

  // 4) 发起上游请求
  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (e) {
    return new Response('代理请求失败: ' + e.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 5) 处理上游 Set-Cookie，累积到该域名的 jar
  const updatedJar = { ...cookies };
  const setCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get('set-cookie')].filter(Boolean);
  for (const sc of setCookies) applySetCookie(sc, updatedJar);

  // 6) 构造返回给浏览器的响应头
  const outHeaders = new Headers();
  const passHeaders = ['content-type', 'content-encoding', 'content-language', 'last-modified', 'etag', 'cache-control', 'expires', 'server', 'access-control-allow-origin'];
  for (const h of passHeaders) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  outHeaders.set('Access-Control-Allow-Origin', '*');

  // 把更新后的 Cookie 写回 Worker 自身域名（浏览器会持久化，下次请求自动带上）
  const jarValue = encodeURIComponent(JSON.stringify(updatedJar));
  outHeaders.append(
    'Set-Cookie',
    cookieNameForHost(target.host) + '=' + jarValue + '; Path=/; Max-Age=86400; SameSite=Lax'
  );

  const contentType = upstream.headers.get('content-type') || '';

  // 7) HTML 改写后返回；其余类型原样流式返回
  if (isHtml(contentType)) {
    let text = await upstream.text();
    text = rewriteHtml(text, upstream.url || target.toString());
    outHeaders.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 首页 / Web UI
    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
      return new Response(WEBUI, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 代理端点
    if (url.pathname === PROXY_PATH) {
      return handleProxy(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
