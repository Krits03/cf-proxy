# Cloudflare Worker 代理

一个部署在 Cloudflare Workers 上的轻量反向代理，内置 Web UI，支持 **Cookie 透传/存储**、**重定向自动跟随**，并自动改写页面资源地址，让代理页面内的链接与图片仍走本代理。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| Web UI 起始输入框 | 访问 Worker 域名即看到带 URL 输入框的页面，支持 GET/POST 与自定义 Cookie |
| Cookie 支持 | 自动解析上游 `Set-Cookie`，按**目标域名隔离**存到 Worker 自身域名 Cookie（浏览器持久化、零 KV 依赖），并支持手动填写自定义 Cookie |
| 重定向支持 | `fetch` 使用 `redirect: 'follow'` 自动跟随 3xx，并在每一跳累积上游 Cookie |
| 页面改写 | 自动改写 HTML 中的 `href/src/action/data-src/poster`、`url()` 样式、`meta refresh`，使资源继续走代理 |

## 目录结构

```
.
├── worker.js                    # 代理主程序（Cloudflare Workers 入口）
├── wrangler.toml                # Cloudflare 部署配置
├── package.json                 # wrangler 依赖与脚本
├── .github/workflows/deploy.yml # 备用：GitHub Actions 自动部署
├── .gitignore
└── README.md
```

## 代理端点

```
GET/POST  /proxy?url=<目标地址>&c=<可选自定义Cookie>
```

- `url`：要代理的目标地址（必填，仅支持 `http` / `https`）
- `c`：自定义 Cookie 字符串，例如 `name1=v1; name2=v2`
- 支持转发 POST 请求体（含 `multipart/form-data` 会读取后重发）
- 响应携带 `Access-Control-Allow-Origin: *`，便于前端调用

## 部署方式

### 方式一：Cloudflare 原生 Git 集成（推荐）

代码托管在 GitHub，由 Cloudflare 主动拉取并在每次 push 时自动部署，无需本地安装 wrangler。

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → 选 **Worker** → **Connect to Git**
2. 授权 GitHub，选择本仓库
3. **Build command** 留空（纯 Worker 无需构建），CF 会自动读取 `wrangler.toml`（`main = "worker.js"`）
4. 点击 **Deploy**

之后每次 `git push` 到 `main`，Cloudflare 都会自动重新部署。

### 方式二：GitHub Actions 自动部署（备用）

使用仓库内置的 `.github/workflows/deploy.yml`：

1. 在 Cloudflare 控制台 **My Profile → API Tokens** 创建一个具备 **Edit Cloudflare Workers** 权限的 Token
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加名为 `CF_API_TOKEN` 的 secret（值为上面的 Token）
3. 推送代码到 `main`，GitHub Actions 会自动执行 `wrangler deploy`

> 方式一和方式二二选一即可。若已使用方式一，可删除 `.github/` 目录。

### 本地调试

```bash
npm install
npx wrangler dev
```

## 使用说明

1. 部署完成后，打开分配的 `*.workers.dev` 域名（或绑定的自定义域名）
2. 在顶部输入框填入目标网址（例如 `https://example.com`），点击「访问」或按回车
3. 页面会在下方 iframe 中加载；页面内的链接、图片、表单提交都会继续走本代理
4. 需要携带登录态等 Cookie 时，展开「高级」填写自定义 Cookie（格式 `name=value; name2=value2`）

## 注意事项

- **安全**：该代理会透传请求与 Cookie，请勿在公开不可信环境无防护地部署。建议增加访问密码或来源域名白名单。
- **Cookie 持久化**：当前借助浏览器在 Worker 域名下的 Cookie 存储实现跨请求保持，受单条 Cookie 大小（约 4KB）限制；超大 Cookie 集合建议改用 KV 存储。
- **大文件上传**：`multipart/form-data` 采用读取后重发策略，超大文件场景建议改用流式/分块上传或 R2 中转。

## 许可证

MIT
