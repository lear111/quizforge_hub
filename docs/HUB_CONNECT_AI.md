# Hub 账号连接与免费 AI 评分协议 v1

日期：2026-10-22。状态：**用户已于 2026-10-22 确认，进入实现**。2026-10-22 修订（用户确认）：每日次数改为按金额计费的 **免费 AI 余额**（先做成点数，当天改为人民币），只能用兑换码获取（第 6.1 节）；界面名称“官方 AI”改为“免费 AI 额度”，后台页面改为“AI 服务”。修订时还没有客户端发布过旧字段，因此仍为 v1。本文是 Hub、Web、Android 三端共用的契约：Hub 先实现并部署（默认关闭），Web 接入后再在下一批同步中接入 Android。各端实现时记录所依据的本文提交。

## 1. 目标与范围

大部分用户不会也不想自己配置模型 API。本协议让用户把 **Hub 账号连接到本地 Web 或 Android 应用**，使用免费 AI 评分，消耗该 Hub 账号的 AI 点数。

- 本地不另建账号。“登录”指把这台设备连接到一个 Hub 账号，连接只授予“使用免费 AI 评分、为账号兑换额度”这两项权限。
- 用户自己配置模型 API 的功能完整保留，可以和免费 AI 额度同时开启（第 7.1 节）。
- 官方模型的 API Key 只存在 Hub 服务器上，不进入任何客户端、安装包、仓库或网页。
- 账号注册沿用 Hub 现有流程（邮箱验证码 + 邀请码），本协议不改变注册门槛。

不在 v1 范围：跨设备同步或备份、题库下载与账号关联、Hub 云端练习使用免费 AI、在线支付购买额度。

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
- 页面显示：设备名称、客户端类型、权限说明“允许这台设备使用免费 AI 评分，消耗你账号里的 AI 额度”、当前剩余金额。按钮为“允许”和“拒绝”。
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
 "ai":{"enabled":true,"model":"通义千问 qwen-vl-plus","vision":true,"balance":42000,"pricePerMillion":30000}}
```

- `POST /api/connect/redeem`：请求体 `{"code":"AI-XXXX-XXXX-XXXX-XXXX"}`，成功返回 `{"added":50000,"balance":92000}`（金额单位 0.0001 元）。兑换码不区分大小写，忽略空格和连字符。无效、已使用、已作废或已过期时返回 400 `REDEEM_CODE_INVALID`；同一账号 1 小时内输错 10 次后返回 429 `REDEEM_LOCKED`，1 小时后恢复。
- `POST /api/connect/logout`：撤销当前设备连接，返回 204。客户端无论成功与否都删除本地令牌。

Hub 网页的账号页新增“已连接设备”列表（名称、类型、连接时间、最后使用时间），可以改名和撤销；使用登录会话与现有 CSRF 校验。管理员封禁账号时，该账号所有设备连接立即失效。

## 6. 免费 AI 网关

```http
POST /api/ai/v1/chat/completions
Authorization: Bearer qfd_…
Content-Type: application/json
```

接口为 OpenAI Chat Completions 兼容格式，Web 和 Android 现有的模型调用代码只需把服务地址换成 `https://quizforge.treenewbee.cloud/api/ai/v1`、模型名换成 `quizforge-official`、Key 换成设备令牌。

服务器端约束：

- `model` 必须为 `quizforge-official`，实际模型由服务器配置决定（v1 为 `qwen-vl-plus`，见第 8 节）。
- 只接受 `messages`、`max_tokens`、`response_format`、`temperature`。拒绝 `stream`、`tools`、`functions`、`n>1` 及其他字段，返回 400 `AI_REQUEST_UNSUPPORTED`。
- `max_tokens` 上限 8192，缺省为 8192。
- 图片只接受 `image_url` 中的 `data:image/(png|jpeg|webp);base64,…`，不接受外部 URL。单张不超过 4 MiB，一次请求总大小不超过 12 MiB。
- 每个账号同时最多 2 个进行中的请求，全站同时最多 8 个，超出返回 429 `AI_BUSY`。

额度与费用：

- 每次评分按用量扣账号余额，见 6.1。余额为 0 时返回 402 `AI_BALANCE_EXHAUSTED`，不调用上游。
- 全站按上游返回的 `usage.total_tokens` 累计每月用量，超过 `OFFICIAL_AI_MONTHLY_TOKENS` 后本月暂停免费 AI，返回 503 `AI_BUDGET_EXHAUSTED`。
- 只记录用户、日期、次数、token 数和扣费金额，**不记录题目、答案、图片或模型输出内容**，日志也不得包含这些内容。

### 6.1 免费 AI 余额与兑换码

- 每个账号有一个人民币余额（内部以 0.0001 元为单位存整数）。**新账号为 0 元**；余额只能通过兑换码充值，没有每日赠送。
- 扣费：模型正常返回（包括评分格式不合规）后，按 `ceil(usage.total_tokens × 每百万 token 价格 / 1000000)` 扣费，至少 0.0001 元；上游超时、网络错误或 5xx 不扣。价格由管理员按上游实价或加一点余量设置，默认 3 元 / 百万 token。每天的调用次数、token 数和扣费都会记录，后台显示平均每次花费。
- 余额大于 0 才能发起评分。同一账号的两个评分并发时，后完成的一次最多扣到 0，不会出现负数。
- 兑换码形如 `AI-XXXX-XXXX-XXXX-XXXX`（Crockford base32，80 位随机数），由管理员在后台按批生成，每批指定数量、每码面值（元）、有效期和备注。每个码只能兑换一次；服务器只保存码的 SHA-256 和前缀，完整码只在生成时显示一次。未兑换的码可以作废。
- 每次兑换写入余额流水（账号、增减、来源、时间）。

响应：成功时原样返回上游 JSON 中的 `choices` 与 `usage`，去掉上游的请求 ID 等标识，并附加 `"quizforge":{"cost":60,"balance":41940}`（本次扣费和剩余余额，单位 0.0001 元）。错误返回：

```json
{"error":{"code":"AI_BALANCE_EXHAUSTED","message":"免费 AI 额度已用完，可以在设置 → 用户中心输入兑换码获取额度，也可以改用自己的模型。","balance":0}}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `AI_REQUEST_UNSUPPORTED` | 字段、模型名或图片不符合要求 |
| 401 | `DEVICE_TOKEN_INVALID` | 令牌无效、已撤销或账号被封禁 |
| 402 | `AI_BALANCE_EXHAUSTED` | 余额为 0 |
| 413 | `AI_REQUEST_TOO_LARGE` | 请求超过大小上限 |
| 429 | `AI_BUSY` | 并发过多 |
| 502 | `AI_UPSTREAM_FAILED` | 上游模型出错或超时（不扣费） |
| 503 | `AI_DISABLED` / `AI_BUDGET_EXHAUSTED` | 免费 AI 未配置 Key / 本月全站预算用完 |

`GET /api/config` 增加 `{"officialAi":{"enabled":true,"protocolVersion":1}}`，关闭时 `enabled:false`，此时第 3、5、6 节接口返回 404 `OFFICIAL_AI_DISABLED`。

## 7. 客户端行为

### 7.1 Web

- 设置 → **AI 评分**：“开启 AI 评分”开关打开后，才显示其他选项。评分来源可以多选：**使用免费 AI 额度**（需登录，旁边显示剩余点数）和 **使用自定义模型**（勾选后才显示服务地址、模型名和 Key）。开关打开时至少要选一个来源。
- 两个来源都选时优先使用免费 AI 额度；免费额度不可用（余额用完、本月预算用完、未开启、登录失效、上游出错或超时）时，本次改用自定义模型，并记录实际使用的来源。
- 未登录时勾选“使用免费 AI 额度”，弹出登录窗口并在浏览器打开授权页；授权完成后窗口自动关闭。取消或关闭窗口时撤回勾选。
- 设置新增 **用户中心**：显示账号名、设备名、剩余金额、兑换码输入框和“退出登录”；未登录时显示说明和登录按钮。只能在运行 QuizForge 的电脑本机操作。
- 设备令牌保存在数据目录 `.state/hub/connection.json`，使用与现有 AI Key 相同的文件访问保护；不进入题库包导出、日志或任何发给拓展页面的数据。
- 免费 AI 评分时，服务端以 `baseUrl=https://quizforge.treenewbee.cloud/api/ai/v1`、`model=quizforge-official`、视觉开启、`outputMode=json` 调用现有评分流程。题卡、手动／自动评分、多目标、重试、人工改分的行为与自定义模型一致。
- 手机等远程设备通过局域网或 Tailscale 访问时，评分在电脑上进行，使用电脑的连接和额度。
- 收到 401 时清除令牌并提示重新登录；收到 402、429、503 时显示服务器给出的说明，不自动重试（同时选了自定义模型时按上面的规则改用自定义模型）。

### 7.2 Android

- 界面直接沿用 Web 的 AI 设置，不新增菜单。
- 用 Custom Tabs 打开授权页，`client=android`，回调 `quizforge://hub/connect`；设备令牌用 Android Keystore 加密保存。
- 免费 AI 请求由原生 `AiGateway` 发出，规则与 7.1 相同。

## 8. 服务器配置

全部通过环境变量配置，密钥放在 `EnvironmentFile` 中，不进入仓库：

| 变量 | 说明 | 暂定值 |
| --- | --- | --- |
| `OFFICIAL_AI_ENABLED` | 总开关，默认关闭 | `0` |
| `OFFICIAL_AI_BASE_URL` | 上游 OpenAI 兼容地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `OFFICIAL_AI_MODEL` | 上游模型名 | `qwen-vl-plus` |
| `OFFICIAL_AI_KEY` | 上游 API Key（可选，推荐改在后台设置；文件中填写时优先） | — |
| `OFFICIAL_AI_MASTER_KEY` | 后台保存 Key 用的加密主密钥，32 字节 base64，只放在 root 可读的 env 文件中 | 部署时随机生成 |
| `OFFICIAL_AI_PRICE_PER_MILLION` | 每百万 token 价格（元） | `3` |
| `OFFICIAL_AI_MONTHLY_TOKENS` | 全站每月 token 预算 | `10000000`（1000 万） |

### 8.1 管理后台

管理员可以在后台 **AI 服务** 页面修改开关、模型名、每百万 token 价格、每月 token 预算和 API Key，修改立即生效、无需重启；也在这里生成、导出和作废兑换码（第 6.1 节）。安全约束：

- **加密保存**：API Key 用 AES-256-GCM 加密后存入数据库。主密钥 `OFFICIAL_AI_MASTER_KEY`（32 字节 base64）只放在 root 可读的 `/etc/quizforge-hub/official-ai.env` 里，由 systemd 交给服务。只拿到数据库或数据备份读不出 Key；主密钥丢失后，后台保存的 Key 无法解密，需要重新填写。
- **只写不读**：任何接口都不返回 Key，页面只显示前 3 位和末 4 位。
- **二次确认**：设置、更换或清除 Key 时必须再输入一次管理员密码，并有调用频率限制。
- **上游地址不可在后台修改**：只能通过服务器配置 `OFFICIAL_AI_BASE_URL` 修改，防止被盗用的管理员会话把 Key 发往别处。
- **审计**：每次修改都在操作日志里记录操作者、时间和改动的字段名，不记录 Key。
- **优先级**：服务器配置文件里如果写了 `OFFICIAL_AI_KEY`，以文件为准，后台显示“由服务器配置文件设置”且不能修改，作为应急手段。后台从未保存过设置时，开关、模型和额度也使用配置文件里的值。

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

## 11. 已确认与待办

- 2026-10-22 用户确认：模型 `qwen-vl-plus`，全站每月 1000 万 token。
- 2026-10-22 用户确认：取消每日次数，改为点数；新账号不赠送，只能用兑换码获取；界面显示“免费 AI 额度 · 剩余 N 点”。
- 2026-10-22 用户确认：点数改为人民币金额，按实际 token × 单价扣费，同时记录调用次数。
- 待办：面向公众提供生成式 AI 服务是否需要办理相关备案，由运营者自行确认。
