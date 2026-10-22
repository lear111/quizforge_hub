# Hub 账号连接与官方 AI 评分协议 v1（草案）

日期：2026-10-22。状态：**草案，待用户确认后实现**。本文是 Hub、Web、Android 三端共用的契约：Hub 先实现并部署（默认关闭），Web 接入后再在下一批同步中接入 Android。各端实现时记录所依据的本文提交。

## 1. 目标与范围

大部分用户不会也不想自己配置模型 API。本协议让用户把 **Hub 账号连接到本地 Web 或 Android 应用**，用官方提供的 AI 评分试用，次数计入该 Hub 账号的额度。

- 本地不另建账号。“登录”指把这台设备连接到一个 Hub 账号，连接只授予“使用官方 AI 评分”这一项权限。
- 用户自己配置模型 API 的功能完整保留，与官方 AI 二选一。
- 官方模型的 API Key 只存在 Hub 服务器上，不进入任何客户端、安装包、仓库或网页。
- 账号注册沿用 Hub 现有流程（邮箱验证码 + 邀请码），本协议不改变注册门槛。

不在 v1 范围：跨设备同步或备份、题库下载与账号关联、Hub 云端练习使用官方 AI、付费购买额度。

## 2. 名词

| 名词 | 含义 |
| --- | --- |
| 官方 origin | `https://quizforge.treenewbee.cloud`，客户端写死，不从链接、配置或服务器响应中读取 |
| 设备连接 | 一台本地 Web 安装或一台 Android 设备与一个 Hub 账号之间的授权关系 |
| 设备令牌 | 设备连接的凭据，形如 `qfd_` + 43 位 base64url，只能调用本文第 5、6 节的接口 |
| 客户端类型 | `web` 或 `android` |

## 3. 授权流程（授权码 + PKCE）

采用面向原生应用的 OAuth 2.0 授权码流程（RFC 8252）和 PKCE（RFC 7636，只允许 `S256`）。客户端全程不接触 Hub 密码。

### 3.1 发起

客户端生成：

- `code_verifier`：43–128 位，字符集 `[A-Za-z0-9-._~]`；
- `code_challenge` = base64url(SHA-256(`code_verifier`))，无填充；
- `state`：至少 128 位随机数，base64url。

然后在**系统浏览器**中打开（Android 可用 Custom Tabs，不可用 App 内 WebView）：

```text
https://quizforge.treenewbee.cloud/connect/authorize?v=1&client=web&redirect_uri=<编码后的回调>&state=<state>&code_challenge=<challenge>&code_challenge_method=S256&device_name=<编码后的名称>
```

参数校验（任一不符合时显示错误页，不重定向）：

- `v` 必须为 `1`；`client` 为 `web` 或 `android`；每个参数恰好出现一次，不接受未知参数。
- `device_name`：1–40 个字符，去除控制字符后显示，用户可在授权页看到并在账号页修改；默认由客户端填写，例如电脑名或设备型号。
- `redirect_uri` 必须与 `client` 匹配：
  - `web`：`http://127.0.0.1:<端口>/hub/connect/callback` 或 `http://localhost:<端口>/hub/connect/callback`，端口 1024–65535，不带其他路径、查询或片段（RFC 8252 回环地址，端口可变）；
  - `android`：恰好为 `quizforge://hub/connect`（与已有的 `quizforge://hub/import` 同一协议）。

### 3.2 授权页

- 未登录时跳转到 Hub 现有登录页，登录后回到授权页；注册仍需要邀请码。
- 账号被封禁时显示无法授权，不签发授权码。
- 页面显示：设备名称、客户端类型、权限说明“允许这台设备使用官方 AI 评分，次数计入你的账号额度”、当前每日额度。按钮为“允许”和“拒绝”。
- “允许”和“拒绝”都通过同源 POST 提交，校验 Origin 与登录会话（防 CSRF）。

结果以 302 重定向回 `redirect_uri`：

- 允许：`?code=<授权码>&state=<原样返回>`。授权码 32 字节随机数，120 秒有效，只能使用一次，绑定用户、`client`、`redirect_uri`、`code_challenge`。
- 拒绝：`?error=access_denied&state=<原样返回>`。

### 3.3 换取设备令牌

```http
POST /api/connect/token
Content-Type: application/json

{"v":1,"client":"web","code":"…","code_verifier":"…","redirect_uri":"…"}
```

- 校验授权码未过期、未使用，`client`、`redirect_uri` 与签发时一致，SHA-256(`code_verifier`) 与 `code_challenge` 一致。任一失败返回 400 `INVALID_GRANT`，同时作废该授权码。
- 同一 IP 每分钟最多 20 次请求。
- 成功：

```json
{"token":"qfd_…","device":{"id":"…","name":"…","client":"web","created":"…"},"user":{"name":"…"}}
```

设备令牌不过期；连续 180 天未使用自动失效。服务器只保存令牌的 SHA-256。同一账号最多 10 个有效设备连接，超出时最早未使用的连接失效。

## 4. 客户端回调处理

- **Web**：回调由本机服务的 `GET /hub/connect/callback` 接收。只接受回环地址访问（`127.0.0.1`、`localhost`、`::1`），校验 `state` 与本机发起的一致（10 分钟有效、一次性），然后由服务端调用 3.3 换取令牌。成功后显示“已连接，可以关闭此页面”。通过局域网、IPv6 或 Tailscale 访问的远程设备不能发起或完成连接，与其他设置一致。
- **Android**：`MainActivity` 接收 `quizforge://hub/connect`，校验 `state` 后由原生代码换取令牌。远程网页内容不能触发该流程。
- 回调中出现 `error` 或 `state` 不匹配时，丢弃本次流程，提示用户重试，不保存任何内容。

## 5. 设备接口

以下接口都需要请求头 `Authorization: Bearer qfd_…`。令牌无效、已撤销或账号被封禁时返回 401 `DEVICE_TOKEN_INVALID`，客户端应清除本地令牌并显示“需要重新登录”。

- `GET /api/connect/me`：

```json
{"user":{"name":"…"},"device":{"id":"…","name":"…","client":"web"},
 "ai":{"enabled":true,"model":"通义千问（视觉）","vision":true,"dailyLimit":20,"usedToday":3,"resetAt":"2026-10-23T00:00:00+08:00"}}
```

- `POST /api/connect/logout`：撤销当前设备连接，返回 204。客户端无论成功与否都删除本地令牌。

Hub 网页的账号页新增“已连接设备”列表（名称、类型、连接时间、最后使用时间），可以改名和撤销；使用登录会话与现有 CSRF 校验。管理员封禁账号时，该账号所有设备连接立即失效。

## 6. 官方 AI 网关

```http
POST /api/ai/v1/chat/completions
Authorization: Bearer qfd_…
Content-Type: application/json
```

接口为 OpenAI Chat Completions 兼容格式，Web 和 Android 现有的模型调用代码只需把服务地址换成 `https://quizforge.treenewbee.cloud/api/ai/v1`、模型名换成 `quizforge-official`、Key 换成设备令牌。

服务器端约束：

- `model` 必须为 `quizforge-official`，实际模型由服务器配置决定（v1 为通义千问视觉模型，具体型号见第 8 节）。
- 只接受 `messages`、`max_tokens`、`response_format`、`temperature`。拒绝 `stream`、`tools`、`functions`、`n>1` 及其他字段，返回 400 `AI_REQUEST_UNSUPPORTED`。
- `max_tokens` 上限 8192，缺省为 8192。
- 图片只接受 `image_url` 中的 `data:image/(png|jpeg|webp);base64,…`，不接受外部 URL。单张不超过 4 MiB，一次请求总大小不超过 12 MiB。
- 每个账号同时最多 2 个进行中的请求，超出返回 429 `AI_BUSY`。

额度与费用：

- 每个账号每天的调用次数（上海时间 0 点重置）由服务器配置 `OFFICIAL_AI_DAILY_LIMIT` 决定。请求开始时预扣 1 次；上游超时、网络错误或 5xx 时退回，模型正常返回（包括评分格式不合规）时计入。
- 全站按上游返回的 `usage.total_tokens` 累计每月用量，超过 `OFFICIAL_AI_MONTHLY_TOKENS` 后本月暂停官方 AI，返回 503 `AI_BUDGET_EXHAUSTED`。
- 只记录用户、日期、次数和 token 数，**不记录题目、答案、图片或模型输出内容**，日志也不得包含这些内容。

响应：成功时原样返回上游 JSON 中的 `choices` 与 `usage`，去掉上游的请求 ID 等标识。错误返回：

```json
{"error":{"code":"AI_DAILY_LIMIT","message":"今天的官方 AI 评分次数已用完，明天 0 点恢复，也可以在 AI 设置中改用自己的模型。","resetAt":"…"}}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `AI_REQUEST_UNSUPPORTED` | 字段、模型名或图片不符合要求 |
| 401 | `DEVICE_TOKEN_INVALID` | 令牌无效、已撤销或账号被封禁 |
| 413 | `AI_REQUEST_TOO_LARGE` | 请求超过大小上限 |
| 429 | `AI_DAILY_LIMIT` / `AI_BUSY` | 今日额度用完 / 并发过多 |
| 502 | `AI_UPSTREAM_FAILED` | 上游模型出错或超时（已退回额度） |
| 503 | `AI_DISABLED` / `AI_BUDGET_EXHAUSTED` | 官方 AI 未开启 / 本月预算用完 |

`GET /api/config` 增加 `{"officialAi":{"enabled":true,"protocolVersion":1}}`，关闭时 `enabled:false`，此时第 3、5、6 节接口返回 404 `OFFICIAL_AI_DISABLED`。

## 7. 客户端行为

### 7.1 Web

- 设置 → **AI 评分** 增加“评分方式”：**官方 AI**（需登录）或 **自定义模型**（现有功能，原样保留）。
- 选择官方 AI 时显示“登录 QuizForge 账号”按钮；登录后显示账号名、设备名、今日剩余次数和“退出登录”。只能在运行 QuizForge 的电脑本机操作。
- 设备令牌保存在数据目录 `.state/hub/connection.json`，使用与现有 AI Key 相同的文件访问保护；不进入题库包导出、日志或任何发给拓展页面的数据。
- 官方 AI 评分时，服务端以 `baseUrl=https://quizforge.treenewbee.cloud/api/ai/v1`、`model=quizforge-official`、视觉开启、`outputMode=json` 调用现有评分流程。题卡、手动／自动评分、多目标、重试、人工改分的行为与自定义模型一致。
- 手机等远程设备通过局域网或 Tailscale 访问时，评分在电脑上进行，使用电脑的连接和额度。
- 收到 401 时清除令牌并提示重新登录；收到 429、503 时显示服务器给出的说明，不自动重试。

### 7.2 Android

- 界面直接沿用 Web 的 AI 设置，不新增菜单。
- 用 Custom Tabs 打开授权页，`client=android`，回调 `quizforge://hub/connect`；设备令牌用 Android Keystore 加密保存。
- 官方 AI 请求由原生 `AiGateway` 发出，规则与 7.1 相同。

## 8. 服务器配置

全部通过环境变量配置，密钥放在 `EnvironmentFile` 中，不进入仓库：

| 变量 | 说明 | 暂定值 |
| --- | --- | --- |
| `OFFICIAL_AI_ENABLED` | 总开关，默认关闭 | `0` |
| `OFFICIAL_AI_BASE_URL` | 上游 OpenAI 兼容地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `OFFICIAL_AI_MODEL` | 上游模型名 | 通义千问视觉模型，具体型号待定 |
| `OFFICIAL_AI_KEY` | 上游 API Key，放在 `/etc/quizforge-hub/official-ai.env` | — |
| `OFFICIAL_AI_DAILY_LIMIT` | 每个账号每天的调用次数 | 待定 |
| `OFFICIAL_AI_MONTHLY_TOKENS` | 全站每月 token 预算 | 待定 |

## 9. 安全要点

- 必须使用 PKCE，并校验 `state`；授权码一次性、短时有效，并绑定回调地址。
- Web 只接受回环地址回调；Android 只接受固定的 `quizforge://hub/connect`。
- 设备令牌只发送给官方 origin 的 HTTPS 接口，不发送给自定义模型地址或拓展页面。
- 服务器只保存令牌哈希；用户和管理员都可以撤销。
- 官方 Key 只在 Hub 服务器上，上游请求禁止重定向。

## 10. 发布顺序

1. Hub：实现第 3、5、6 节和账号页设备列表，部署后保持 `OFFICIAL_AI_ENABLED=0`，在测试账号上验证后再开启。
2. Web：实现第 7.1 节，发布新预览版。
3. Android：在下一批同步中按第 7.2 节接入。

## 11. 待确认

- 通义千问视觉模型的具体型号（影响效果和费用）。
- `OFFICIAL_AI_DAILY_LIMIT` 和 `OFFICIAL_AI_MONTHLY_TOKENS` 的数值。
- 面向公众提供生成式 AI 服务是否需要办理相关备案，由运营者自行确认。
