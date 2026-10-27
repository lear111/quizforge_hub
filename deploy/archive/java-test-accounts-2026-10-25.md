# Java Hub 第二阶段测试部署：账号与授权

2026-10-25 UTC，按既定分阶段迁移及测试环境验证继续更新。只更新独立Java测试服务，没有切换正式站、改Web／Android或发布安装包。

后续同日已按用户选择迁入旧Node测试站完整数据；本文保留账号阶段刚部署时的公开演示库、策略和PID记录，当前数据／策略／PID见[测试数据迁移记录](./java-test-data-migration-2026-10-25.md)。

之后补齐原型用户中心布局并保留已迁入数据，当前运行发布及PID见[用户中心更新记录](./java-test-profile-ui-2026-10-25.md)。

## 运行版本

- 入口：<https://quizforge-test.treenewbee.cloud/#login>，健康接口阶段为 `accounts-and-devices`。
- 服务器：`work-codex-seoul` / `43.131.254.125`，Java21，仍只监听回环4338。
- 发布目录：`/opt/quizforge-hub-java-test/releases/20261025-090734-accounts-e4af7fe`，current已切至此处。
- JAR：39,404,490字节，SHA-256 `5d51a1a90735d51bfa4b852173a5074206c40bca98a40a791c9f617e2704a8ff`，本机／服务器一致。
- 分支：`feat/hub-java-migration-20261024`，基线 `e4af7fe9e7124ccaf7f36e8bbe6205175f32d3d4`，包含未提交改动。运行源码摘要见发布目录 `source-manifest.json`，不是纯基线提交产物。
- Java服务PID `1802568`，自动重启数0；验收后内存约159MiB，限制512MiB。此值不代表30用户容量验收。

## 数据与切换

只短暂停止 `quizforge-hub-java-test`，将其现有数据完整复制并校验，再切换发布链接和启动新服务。备份在 `/var/backups/quizforge-hub-java-test/before-20261025-090734-accounts-e4af7fe/data`，旧unit在同目录 `service.before`。

数据仍为第一阶段的公开预览副本，保留其1份题库、图片、软件文件和累计测试下载计数。新增账号／验证码表及策略是增量初始化，没有导入正式站账号、密码、会话、手机号或供应商密钥，没有覆盖旧Node或云端练习数据。

测试Cookie继续使用独立的 `qfh_java_test`，增加准确的 `PUBLIC_ORIGIN` 与 `COOKIE_SECURE=1`。可选私有配置文件 `/etc/quizforge-hub-java-test/auth.env` 当前不存在；没有自动复制生产邮件、短信、AI配置。注册默认仍要求验证码与人机验证，因此测试站当前注册／发码暂不可用。设备入口默认仍关闭；已实现的设备协议由本地合成测试完整验证，AI网关与兑换尚待迁移。

原Node Hub PID `1226431`、练习PID `1226941`、Caddy PID `12260` 保持。Caddy配置摘要仍为 `288b5e39579f61074777e396f450cebbb0cead4666b25772db3bc7e03b4e6bd0`，本次没有修改代理路由。正式站HTTPS更新前后均200。

补充修正：首次停止旧Java服务时，JVM已完成优雅退出，但systemd将正常SIGTERM退出码143记为失败；补上 `SuccessExitStatus=143` 并daemon-reload，当前Java进程保持。服务状态为success、0自动重启；该条历史日志不是新服务崩溃。原部署清单保留为 `source-manifest.before-exit-status.json`，更新清单记录该配置差异，JAR未变化。

## 验证

- 最终本地 `Verify-Java-Hub.ps1`：Java24项、Node模板／真实HTTP对照及账号互认21项全部通过，0失败／跳过。包括16种登录／注册验证组合、密码／Cookie／旧验证码／旧设备互认、补绑保留ID和余额、策略变化、验证码错误次数、邀请码争用、审计回滚、PKCE失败消费与并发单次交换、撤销和闲置期限。
- 签名样例与原Node的腾讯SES／阿里PNVS结果一致；只有合成数据，没有真实供应商投递或模型调用。
- 公网原有浏览下载9组通过，新增账号9组通过。新增验收以服务用户创建一个仅用于本次检查的随机临时合成账号，实际执行HTTPS登录、检查Secure／HttpOnly／SameSite和哈希会话、读取本人资料、退出、旧会话失效、拒绝跨域、未配置发码拒绝、私有数据404；finally清除临时账号及会话，原账号数恢复。
- 本机另行直连测试服务器核对HTTPS证书与新阶段健康标识，正式站保持200。
- 浏览器预览仍返回 `Local browser use is disabled in Work settings`；没有浏览器点击、手机实际收码或Android系统回调验收。
- 本地临时验证Java／Node进程均已退出；测试服务器Java服务继续运行供查看。

工具：`deploy/upgrade-java-test.sh` 只更新指定的已安装测试服务，先检查当前JAR、备份数据，再切换。失败自动恢复旧JAR和服务配置，保留数据，禁止自动拿旧备份覆盖后来写入。运行时需使用部署锁，防止两个更新并行。

测试账号验收脚本 `scripts/verify-java-test-accounts.py` 只支持指定测试域名和数据路径；以 `quizforge-java-test` 用户执行，不打印随机密码、Cookie或令牌，不发送真实验证消息。不要对生产库执行。

## 后续

第三阶段迁移发布、管理和审核；第四阶段迁移AI／兑换及练习内部接口。真实验证通道配置、账号数据完整副本演练、浏览器／设备及生产切换尚未验收。旧Node后端继续作为对照保留，不将本阶段冒充全部Hub改造完成。
