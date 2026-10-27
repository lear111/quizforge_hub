# Java 管理、AI 与练习衔接

2026-10-25。本文描述当前分支源码；生产仍使用原发布，部署状态以 `deploy/` 中对应记录为准。

## 管理与审核

`ADMIN_ENABLED=1` 后，管理员账号登录访问 `/admin/`；匿名跳到登录，普通用户 403。不会自动将第一个注册账号变成管理员。本地维护命令由 Java 执行，使用 `scripts/Admin-Java-Hub.ps1`，原 `node scripts/admin.mjs ...` 仅作转发入口；必须显式指定 Java 数据目录，不能误改未迁移的旧库。见[维护说明](./JAVA_MAINTENANCE.md)。

原生接口包括联系方式（revision 冲突 409）、邀请码生成／停用、账号封禁／解封、资料、访问与流量统计、举报、审计、分享审核和下架。封禁撤销会话及设备授权；管理写操作复查管理员身份，保留来源校验。

`.qbank` 审核先按当前 revision 和 SHA 验证实际文件，再送入 Node 不可变审核包目录。通过需要明确 `codeReviewed: true`，并确认检查时的文件与版本未变化；Node 维护完整内容摘要白名单。检查不执行未审拓展。撤销摘要同步使关联公开包的云端许可失效，已导入的练习由原运行时继续按白名单约束。非 qbank 附件可审核为普通下载，不伪造云端可执行许可。

审核提醒沿用持久化合并队列、失败重试与发送额度，不配置供应商就不投递。`REVIEW_EMAIL` 是专用提醒地址，`TENCENT_SES_REVIEW_TEMPLATE_ID` 是专用模板；其余腾讯 SES 配置和验证码 pepper 保持稳定并私密管理，不写入源码。真实邮件投递单独验收。

管理员本人上传／更新题库无需重复进入后台审核。服务端重新核实角色和所有权，已批准的拓展摘要直接复用；新摘要仍需本人明确确认检查代码，可在上传页完成。发布沿用不可变快照、revision／SHA核对、白名单登记及审计；失败保留已保存的待审条目，同页可以重试。普通用户审核与权限不变，见[上传协议](./JAVA_PUBLISHING.md)。

## AI 与余额

`OFFICIAL_AI_MASTER_KEY` 为原 32 字节 Base64 主密钥；更换会使旧配置不可读。AES-GCM 格式及旧 AAD 保持兼容。上游 Key 只写，管理响应不返回密文或明文 Key；新增上游需管理员密码确认，地址仅 HTTPS，不跟随重定向。

- 余额与单价使用原整数单位，10000 单位为 1 元；保留原余额、兑换、注册赠送和账本。
- `/api/ai/v1/chat/completions` 只接受设备 Bearer。账号 Cookie 不能冒充设备令牌。
- `/internal/ai/me`、`redeem`、`chat/completions` 只供准确 Host 的回环请求及真实会话；写操作检查 Origin。
- 每用户最多 2 路，全站默认 2 路，`AI_SITE_CONCURRENCY` 可设 1–8；最多顺序尝试 3 个可用上游。
- 成功响应后在同一事务计入用户余额、上游成本、token 与每日使用；失败不扣，余额不为负数。遵循旧版成功后计费语义，不另加预扣／退款流程。
- 只接受文本或内嵌 PNG／JPEG／WebP data URL；不抓取调用方提供的远程图片，不保存题目、提示或模型回答。非流式请求沿用现有错误结构。
- 用户中心显示真实余额、兑换入口和流水；充值按钮仍为占位。

本轮只验证合成模型响应及 Node／Java 双向密文互认，真实供应商、费用和并发容量另验。

## 独立 Node 练习

当前启动入口为 `scripts/cloud-practice-site.mjs` → `practice/server/app.mjs`。它保留固定 Web 快照、云端工作区、隔离历史、配额、格式 3 包及拓展审核运行时；不再导入旧 Node Hub 的 `server.mjs`。`practice/public/` 保留练习资源，Hub 页面由 Java JAR 提供。

| 配置 | 用途 |
| --- | --- |
| Java `PRACTICE_BRIDGE_ENABLED=1` | 启用固定私有审核／工作区桥 |
| Java `PRACTICE_ADMIN_PORT=4324` | 仅回环，不允许调用方指定目标 |
| Java `PRACTICE_ORIGIN` | 准确练习 Origin；与账号配额开关分别控制 |
| Node `HUB_AUTH_PORT` | 默认 Java 4338；可显式配置回环端口 |
| Node `HUB_SESSION_COOKIE` | 默认旧 qfh_session；测试设 qfh_java_test |
| Node `HUB_ORIGIN` / `PRACTICE_ORIGIN` | 正确 HTTPS 来源与 SSO 返回域名 |
| Node `DATA_DIR` / `CLOUD_RUNTIME_DIR` | 独立练习数据及适合目标系统的固定运行时 |

Node 向 Java 查询身份、活动、AI、联系方式和管理资料；SSO state 和一次性 code 按原机制核对。私有桥内部协议名不变，但向 Hub 转发时使用指定的真实 Cookie 名。重启练习进程后需重新登录，持久化练习和历史不清空。

云端练习当前浏览器中没有该账号AI偏好时，默认开启AI评分、自动评分及免费额度，默认不启用自定义模型。已有保存的选择和旧版自定义配置保留；不修改本地Web／Android默认值。提交响应带回已创建任务的状态，题卡首次查询可立即读取该状态并显示评分中；后续仍查询真实任务，评分请求、计费及去重规则不变。此改动缩短状态反馈等待，不承诺模型立即返回。

Java 的 `CLOUD_ENABLED` 仍控制 Hub 附件的账户配额，不要仅为显示练习入口而误开启旧数据库中未配置的配额；桥与准确练习 Origin 可以独立显示入口。Node 自己的工作区与流量配额继续生效。

## 固定版本导入

`LOCAL_IMPORT_ENABLED=1` 开启 `/api/packs/:id/local-import?revision=...` 与匿名固定版本下载 `download?revision=...&sha256=...`。只交付公开已审 qbank，版本变化 409，保留 `LOCAL_IMPORT_*` 错误、64 MiB 上限和实际字节校验；清单不扣流量，下载按原站点／IP预算预留。

云端导入使用配置中的固定 HTTPS Hub 来源。Windows／Android 的系统协议仍使用客户端固定 Hub 来源，不能让测试站按钮悄悄去正式站取同 ID。Java 测试配置保留清单与云端导入，但用 `HUB_LOCAL_CLIENT_IMPORT_ENABLED=false` 隐藏系统客户端导入按钮；生产按原客户端来源启用。系统双击、Android 回调与真实云端浏览器操作须单独验收。

## 清理与回退

旧 Hub 后端、旧页面、合成预览和公开预览入口已删除，旧格式互认改用合成 SQL／JSON 样本及标准加密格式检查。维护命令已迁 Java，不依赖旧实现。共享浏览器 JS、Node 练习／规则和固定快照继续保留。旧生产与测试发布及停写备份保留供回退，不删除数据目录或上线历史。

部署先核对源码／二进制摘要，停写备份后更新 Java 与练习的匹配配置。失败回退二进制与服务配置，保留更新后的数据，不能自动用旧库覆盖新写入。
