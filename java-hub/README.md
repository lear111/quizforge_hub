# QuizForge Hub Java 迁移预览

Java 原生 Hub 已补齐账号、题库发布管理、审核、AI 与练习内部接口的代码迁移。独立 Node 练习与规则运行时继续保留。旧 Node Hub 后端、页面和过时预览入口已删除；兼容验证只保留合成旧数据、固定接口样本及真实 Java／练习联调。

生产站未切换。完整进度见[迁移清单](../docs/JAVA_MIGRATION.md)，账号兼容见[账号说明](../docs/JAVA_ACCOUNTS.md)，管理／AI／练习配置见[衔接说明](../docs/JAVA_ADMIN_AI_PRACTICE.md)。

## 开发与启动

需要 JDK 21 或以上、Maven 3.6.3 或以上。当前固定 Spring Boot 4.1.2，JDBC 使用 SQLite，沿用现有数据格式；未另引入 MySQL/Redis。系统要求见 [Spring Boot 官方说明](https://docs.spring.io/spring-boot/system-requirements.html)。JDK、Maven 只属于开发环境，尚未制作新的安装包。

在仓库根目录执行：

```powershell
.\Verify-Java-Hub.ps1
.\Start-Java-Hub.ps1 -SkipBuild
```

启动脚本默认监听 `http://127.0.0.1:4338/`，只供本机开发，不抢占现有 4318／4323／8787／8788 端口。默认数据目录为本工作区 `java-hub/data-java/`；全新目录没有演示账号、假题库或线上数据。脚本默认Cookie为独立的 `qfh_java_preview`，不会覆盖同时运行的Node网页会话；需要演练原Cookie时指定 `-CookieName qfh_session`。按 Ctrl+C 关闭，脚本不会另留后台服务。

也可以在 `java-hub/` 目录运行：

```text
mvn package
java -jar target/quizforge-hub-0.1.0-java-preview.jar
```

## 使用数据副本演练

Java 不允许直接打开未标记的现有 Node 数据库。先停止源 Hub 的写入，使用脚本创建完整的新副本；目标目录必须不存在且不能与源目录重叠：

```text
node scripts/snapshot-hub-for-java.mjs <已停止写入的Hub数据目录> <新的副本目录> --source-stopped
```

脚本通过 SQLite 在线备份 API 复制数据库，再复制 `files/`、`downloads/`，检查数据库完整性及外键，记录资源摘要；不读取 `.env`，不执行 `.qbank` 内拓展。拒绝链接和覆盖已有目标。失败时保留副本供检查，不把部分副本标记为可用。**这个命令不自动停止任何服务；运行者必须先安排停写。**

```powershell
.\Start-Java-Hub.ps1 -SkipBuild -DataDir '<新的副本目录>'
```

数据库包含账号、会话和余额等私有信息，副本不能提交 Git 或上传公开附件。练习空间数据由原 Node 服务管理，不在本阶段转换或覆盖。自动用例使用合成数据；2026-10-25另将旧Node测试站完整副本迁入Java测试站并校验，未对当前生产数据执行迁移演练。

## 配置

| 环境变量 | 用途／默认值 |
| --- | --- |
| `HUB_JAVA_BIND` / `HUB_JAVA_PORT` | 默认 `127.0.0.1` / `4338` |
| `HUB_JAVA_DATA_DIR` | 默认 `./data-java`，启动脚本使用工作区绝对路径 |
| `HUB_COOKIE_NAME` | 原有会话 Cookie 名，默认 `qfh_session` |
| `PUBLIC_ORIGIN` / `COOKIE_SECURE` | HTTPS代理部署填写准确Origin及`1`；未配置Origin时账号写操作仅接受loopback |
| 邮件／短信／Turnstile配置 | 沿用原环境变量，见[账号说明](../docs/JAVA_ACCOUNTS.md)，不会自动读取生产私有文件 |
| `HUB_DEVICE_CONNECT_ENABLED` | 独立开启迁移测试的设备授权，默认关闭；原AI开关已开时保留设备入口，AI 开关与上游配置有效时提供网关 |
| `HUB_MONTHLY_BUDGET_BYTES` | 站点月附件预算，默认 150000000000 字节 |
| `HUB_IP_DAILY_BUDGET_BYTES` | IP 日预算，默认 1048576000 字节 |
| `BILLING_TIMEZONE` | 默认 `Asia/Shanghai`；沿用原 IP 日预算的 UTC 日期规则 |
| `CLOUD_ENABLED` | 默认 `false`；副本原先开启云端账户配额时设为 `true` |
| `TRUST_PROXY` | 默认 `false`；只能在可信代理隔离直连请求后开启 |
| `PRACTICE_ORIGIN` | 既有练习服务 HTTPS Origin，留空时不生成云端导入链接 |
| `HUB_LEGACY_ORIGIN` | 保留的原 Hub 参考入口；只导航，不代理或转发凭据 |
| `LOCAL_IMPORT_ENABLED` | 默认 `false`；提供匿名固定版本清单与下载；需与客户端固定 Hub 来源一致 |

不要把 Node 的 GB/MB 单位参数原样填到 Java 的字节参数中。`HUB_LEGACY_ORIGIN` 仅用于正常导航到现有站点，不授权跨域凭据读取，也不承诺在两个独立数据副本之间同步新登录。

## 当前真实能力

- Java 原生提供 `/api/packs`（搜索、12条分页、热门排序、我的分享）、详情、旧会话读取、附件／截图下载、下载预检、公开管理员联系方式、软件发布清单及安装包交付。
- 对未审核题库沿用所有者／管理员可见性；会话仍读取 SHA-256 后的旧 token，过期、停用账号及未验证联系方式标识保持有效。
- 站点、IP 和已启用的账户配额在一个 SQLite 写事务里预留，题库下载计数同事务更新；失败回滚，下载中断的预留不返还。安装包 HEAD 请求不扣流量。
- 已采用用户确认的简洁版样式和既有手机断点，不追加此前未采纳的手机底栏设计。演示脚本、假账号、虚构年份题库、伪下载、外部字体均不进入运行页。
- 页面中的题库、截图、评论和软件版本来自实际接口；长文本按纯文本转义。联系管理员复用已核验的弹窗交互。
- Java原生提供注册登录／退出、邮箱及手机验证码、独立验证策略、邀请码消费、补绑及用户中心；保留旧scrypt密码、Cookie、验证码HMAC、用户ID和注册赠送流水。策略更新、验证码／邀请码消费与账号写入保持事务边界。
- 设备授权支持原回调白名单、S256、单次授权码、原令牌格式、改名／撤销、180天闲置失效与最多10台设备。仍保持Cookie与Bearer权限隔离。
- 详情页原生读取格式3包目录，支持单本／部分题库下载及评论／举报；保留原题库、图片与拓展字节，按实际生成大小计流量。接口与限制见[详情说明](../docs/JAVA_PACK_DETAILS.md)。

- 分享页原生上传题库、填写介绍／标签／截图；本人编辑使用revision冲突检查，提交后待审、编辑后暂停公开。“我的分享”按状态分页查询；配额、文件引用和通知队列同事务，失败清理本次对象。见[分享说明](../docs/JAVA_PUBLISHING.md)。

## 管理、AI 与练习

管理后台复用原有管理界面，新增举报入口；原生 Java 管理账号权限、邀请码、联系方式、统计、审核版本和操作审计。审核包、代码白名单和账户工作区仍通过固定回环端口的私有 Node 桥操作，不提供通用代理。

AI 接通原 AES-256-GCM 配置、兑换码、余额、账本、设备网关和练习内部调用；成功才记账，上游失败不扣款，余额不为负数。保留原成本及错误协议，没有新增支付、外部图片抓取或提示词存储。真实模型供应商尚未验收。

`PRACTICE_BRIDGE_ENABLED=true`、准确的 `PRACTICE_ORIGIN` 与 Node 服务的 `HUB_AUTH_PORT` / `HUB_SESSION_COOKIE` 必须一致。不要让 Java 与 Node 同时写同一个 Hub 数据目录。细节及默认值见[衔接说明](../docs/JAVA_ADMIN_AI_PRACTICE.md)。

仍须完成真实浏览器／手机、真实验证码与邮件／模型、生产完整数据副本、容量和切换恢复演练；未提交、推送、合并或切换生产。浏览器工具受 Work 设置限制时，HTTP 检查不能代替视觉与设备验收。

本轮测试站完整部署、数据核对与回退见[部署记录](../deploy/java-test-complete-2026-10-25.md)。

## 测试

`Verify-Java-Hub.ps1` 先运行 Java 测试和 JAR 构建，再显式给 Node 对照测试设置 `HUB_JAVA_JAR`；测试使用独立临时数据、随机回环端口，结束时停止所创建的 Java／Node 服务。Node 侧需要当前项目原有的 Node.js 24。

清理前的迁移发布通过 Java65 项和 Node迁移联调44项。本轮维护命令迁移后，Java73项通过；当前完整验证以 `Verify-Java-Hub.ps1` 及清理记录为准。AI 使用合成上游和加密样本，不调用真实付费模型；浏览器／手机与供应商验收另记。

完整验证必须提供经审阅的练习运行时：`Verify-Java-Hub.ps1 -PracticeRuntime <目录>`。本机优先使用 `.runtime/web-java-migration-20261025`，否则回退 `.runtime/web-current`；缺少 `basic-demo.qbank` 会直接失败。运行时构建见 `scripts/stage-web-workspace.mjs`，需要 Web 仓库固定来源和依赖。不要把 Windows 运行时部署到 Linux。

`Verify-Java-Hub.ps1` 现在执行完整 Java 构建和全部 Node 练习／页面／协议回归。旧后端专属测试合并到对应 Java 测试；旧格式由 `test/fixtures/` 的固定数据验证，详见[测试映射](../docs/JAVA_TESTING.md)。`npm test` 只运行 Node 侧；未设置 `HUB_JAVA_JAR` 或缺少运行时导致跳过的结果不能算完整迁移通过。

管理员角色、邀请码、登录恢复、赠送额度和安装包清单维护已迁为 Java，见[维护命令](../docs/JAVA_MAINTENANCE.md)。
