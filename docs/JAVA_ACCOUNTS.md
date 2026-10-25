# Java 账号与设备授权迁移

2026-10-25，Java 迁移第二阶段。实现位于 `java-hub/src/main/java/cloud/treenewbee/quizforge/hub/account/`，浏览器入口位于 `java-hub/src/main/resources/static/account-ui.mjs`。总体进度见 [迁移计划](JAVA_MIGRATION.md)。

## 用户流程

- 原生 Java 提供邮箱／中国大陆手机号注册、密码登录、退出、补绑另一种联系方式、用户中心、设备授权与管理。
- 用户中心使用已确认原型的账户信息／设备／侧栏布局和既有手机断点，绑定表单按需展开。真实资料与设备接入；余额查询及兑换已接真实账本，充值保留占位。[布局补齐与部署记录](../deploy/java-test-profile-ui-2026-10-25.md)。
- 登录／注册验证码和人机验证沿用独立开关；默认注册仍要求验证码及人机验证，服务缺失时拒绝，不为演示自动关掉。邀请码开关从旧 `registration_policy` 读取，环境变量只给新库设置初值。
- 账号资料使用稳定 `users.id`。补绑不创建第二个账号，不覆盖旧邮箱／手机号，不合并账号；余额、设备与题库引用不变。
- 充值保留禁用按钮；发布、审核、AI 网关／兑换和练习 SSO 属于后续阶段。`/api/connect/redeem` 在有效设备认证后返回 501 `FEATURE_NOT_MIGRATED`，不会假装充值或兑换成功。

## 数据兼容

密码沿用 `32位十六进制salt:128位十六进制digest`，scrypt 参数 `N=16384,r=8,p=1,dkLen=64`；salt 按原来的十六进制文本编码，保留 Node 的 UTF-8 行为。使用 Bouncy Castle `SCrypt`，最多并发两个密码计算，避免请求线程数放大内存需求。账号不存在和密码错误均执行同等参数的计算。

旧会话仍为 64 位十六进制随机 Cookie，数据库只存 SHA-256；有效期30天，停用和过期检查保留。设备令牌保留 `qfd_`＋43位base64url、哈希存储、180天闲置失效和最多10台设备。设备接口不接受网页登录 Cookie 代替 Bearer，不向设备公开邮箱或手机号。

旧 `users.email NOT NULL` 在独立迁移副本中按原六列表结构改为可空，保留账号ID、自建索引、触发器及外键；未知列结构拒绝迁移。新增表采用 `IF NOT EXISTS`，旧验证码表缺少 `captcha_verified` 时补列，旧验证记录默认视为已完成人机验证，与 Node 一致。

邮箱注册继续使用 `email_codes/email_sends`；手机注册、登录和补绑继续使用 `contact_codes/contact_sends`。两套 HMAC 输入保留原格式，所以配置相同摘要密钥后，未过期的旧验证码可继续消费。登录验证码绑定当前用户和密码版本；补绑验证码绑定用户及用途。

验证码六位、10分钟有效、最多5次错误；错误次数提交保存，成功消费与账号写入共用一个 SQLite 事务。邀请码消费、注册赠送余额及流水、账号和新会话同事务；政策在最终写入时重新读取，发码或计算密码后增强要求不会被绕过。发送超时不退发送预留、不自动重试。

## 原生接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/config` | 当前验证要求、可用通道和公开 Turnstile site key；不返回密钥 |
| `POST /api/auth/register` / `login` | 沿用 `identifier` 或 `email` 或 `phone` 三选一与原返回结构 |
| `POST /api/auth/email-code` / `phone-code` | 注册发码；邀请码先检查，已占用联系方式不泄露账号存在性 |
| `POST /api/auth/login-code` | 先校验密码，再发码，不提前创建会话 |
| `POST /api/auth/logout` | 仅撤销当前网页会话并清 Cookie |
| `POST /api/account/contact-code` / `contact` | 当前密码＋验证码＋人机验证补绑 |
| `GET/PUT /api/admin/authentication` | 管理员读取／更新验证要求；revision冲突检查与审计回滚 |
| `GET /connect/authorize` | 严格校验回调、状态和S256；未登录先到 `/manage/#connect-login/<request>` |
| `POST /api/connect/authorize` | 当前网页登录会话授权或拒绝，严格同源 |
| `POST /api/connect/token` | 单次授权码与PKCE换设备令牌；失败也消费该授权码 |
| `GET /api/connect/me` / `POST /api/connect/logout` | 只接受设备Bearer；本阶段AI显示禁用，余额可读不扣费 |
| `GET /api/connect/devices` / `PUT/DELETE .../{id}` | 当前账号列出、改名、撤销自己设备 |

网页写请求要求精确 `Origin`；没有放宽 CORS。原生设备token/logout路径不使用 Cookie，因此不要求浏览器Origin。鉴权接口最多24,000字节JSON，拒绝数组及重复键；设备协议沿用嵌套错误 `{error:{code,message}}`。

## 配置与环境

`AuthSettings` 只读进程环境，不搜索源码、其他项目或生产凭据。服务器应使用专用 root 私有 `EnvironmentFile`；测试服务示例路径 `/etc/quizforge-hub-java-test/auth.env` 为可选，不自动复制生产邮件／短信配置。

- `PUBLIC_ORIGIN`：反向代理部署必须填写准确HTTPS Origin。留空仅允许本机loopback的写操作。
- `COOKIE_SECURE=1`：HTTPS部署启用；`HUB_COOKIE_NAME` 可指定原Cookie名。开发启动脚本默认独立 `qfh_java_preview`，避免覆盖同时运行的Node网页登录；直接运行JAR仍兼容默认 `qfh_session`。完整副本演练需沿用原名称时，脚本显式指定 `-CookieName qfh_session`。
- `INVITATION_REQUIRED`：仅为新库初始化邀请码策略；`ADMIN_ENABLED=1` 才开放管理员策略接口。不会自动创建管理员。
- `TENCENT_SES_ENABLED`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_SES_FROM`、`TENCENT_SES_TEMPLATE_ID`、`TENCENT_SES_REGION`、`EMAIL_CODE_PEPPER`：沿用 Node 邮件配置；region限香港／广州，摘要密钥至少32字符。
- `ALIYUN_SMS_ENABLED`、`ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE`、`SMS_CODE_PEPPER`、`SMS_DAILY_LIMIT`：沿用阿里云PNVS配置；默认每日100次发送预留上限。
- `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`：按hostname及action校验；测试key前缀不视为已配置。页面仅在配置后加载固定Cloudflare脚本，CSP按需允许该固定来源。
- `HUB_DEVICE_CONNECT_ENABLED=1`：可在迁移测试中单独开启设备协议；默认关闭。迁移副本原 `official_ai_config.enabled=1` 时沿用设备入口，AI开关及可用上游配置控制真实调用，见[管理与AI衔接](JAVA_ADMIN_AI_PRACTICE.md)。此开关不授予任意网络、额外账号或管理员权限。

发码只访问固定腾讯SES、阿里PNVS及Cloudflare HTTPS接口，无Cookie、无重定向、无应用重试；总等待期限10秒，响应上限64KiB，保留系统TLS验证。不把供应商诊断、验证码、令牌或私钥写入日志、API或测试证据。

## 验证边界

`Verify-Java-Hub.ps1` 运行Java检查、构建及Node／Java HTTP互认；其中包含旧密码及Cookie、新密码回到Node、迁移前验证码一次消费、旧设备与余额、签名固定样例、验证策略组合、政策并发更新、邀请码争用、设备重放与撤销。供应商用合成数据或模拟投递验证；没有调用真实邮件、短信、Turnstile或付费模型。

2026-10-25按用户选择，将旧Node测试站完整数据复制到Java测试站；39张原表、5个文件及6个账号的身份／题库归属校验通过，旧密码摘要与ID保留。当前测试验证策略继承旧库，发码及摘要密钥未复制；独立Cookie需要重新登录。详见[数据迁移记录](../deploy/java-test-data-migration-2026-10-25.md)。这不是当前正式站的数据迁移。

浏览器工具当前受Work设置限制。模板、HTTP和协议结果不能代替真实浏览器、手机收码或Android系统回调验收。完整练习接口已实现并联调，正式数据副本与生产切换仍待后续。

实现依据：[Bouncy Castle SCrypt](https://downloads.bouncycastle.org/java/docs/bcprov-jdk18on-javadoc/org/bouncycastle/crypto/generators/SCrypt.html)、[JDK21 HttpClient](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html)、原 [登录策略](AUTH_POLICY.md)、[手机号验证](PHONE_AUTH.md)及[设备协议v1](HUB_CONNECT_AI.md)。
