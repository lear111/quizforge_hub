# Java Hub 完整业务迁移：测试站更新

2026-10-25。补齐管理审核、AI 与练习衔接后，按用户确认更新 Java 测试站和练习测试站。生产未切换，代码未提交、推送或合并；浏览器和真实供应商验收另做。

## 当前发布

- Hub：<https://quizforge-test.treenewbee.cloud/>；练习：<https://practice-test.treenewbee.cloud/>。
- 发布名 `20261025-java-complete-e4af7fe`；Java PID `1863816`，练习 PID `1863957`，检查时两者 active、NRestarts=0。
- JAR 39,582,808 字节，SHA-256 `2a403a9e43a07e1fe370f536646724a67a959fc3cf3eef40c599ce462e28fbc1`。
- 120 项构建／配置输入的来源清单 SHA-256 `fdb81b159b90c14d5570025886b8790405c906ea5b3941767b8b5e829540b636`；基线 `e4af7fe`，明确包含未提交改动。
- 练习源包仅 39 个文件，不含旧 Hub `server.mjs`、旧 AI 网关或测试参考目录；保留并逐文件校验原 Linux 固定运行时 800 个文件。
- Java 回环 4338、Cookie `qfh_java_test`；Node 通过 `HUB_AUTH_PORT=4338`、`HUB_SESSION_COOKIE=qfh_java_test` 接身份、AI、活动、联系方式与管理资料。
- 原 Node 测试 Hub PID `1810627` 和 Caddy PID `12260` 未变；Caddy 配置 SHA-256 仍为 `288b5e39579f61074777e396f450cebbb0cead4666b25772db3bc7e03b4e6bd0`。正式站 HTTPS 200。

## 实现范围

- Java 原生管理后台、角色、封禁／会话撤销、邀请码、联系方式、举报、活动和流量、审计。
- 当前 revision／SHA 对应的不可变审核包、显式代码检查、公开审核／驳回／下架、拓展摘要白名单与撤销联动；保留 Node 审核运行时，不执行未审代码。
- 持久化审核提醒队列、限额与失败重试；未配置真实供应商时不发邮件。
- AI 旧 AES-GCM 配置与兑换码、整数余额和账本、上游增改停用／排序／探测、设备网关及练习内部调用。成功后事务记账、失败不扣款、余额不为负数；充值仍为占位。
- 真实练习 SSO／统一退出、固定版本匿名清单与下载、云端题库来源衔接。测试站隐藏固定指向生产的系统协议按钮，但保留测试来源的清单和云端接口。
- 默认开发启动改为 Java；旧 Hub 后端、旧页面和合成预览入口归档至 `test/node-reference/` 作回归。独立 Node 练习及本地兼容维护工具保留。

## 验证与数据

- `Verify-Java-Hub.ps1`：Java 65 项、Node 迁移联调 44 项，全部通过、0跳过。证据 `.temp/java-migration-evidence-20261025/.temp-java-native-migration-final.log`。
- 全部 Node 回归 180 项：178 通过、0失败、2跳过。一个未配置外观 DOM 测试所需的 UI 包，另一个是 Windows 软链接权限；两项不计入已验收。证据 `.temp/java-migration-evidence-20261025/.temp-node-all-final.log`。
- 公网 HTTP：9份页面／JS／CSS摘要与源码一致；匿名／普通账号／管理员／内部路由边界；真实HTTPS SSO、一次性回调、固定快照工作区与中心退出；合成待审上传、不可变检查、拒绝省略代码确认、驳回及删除；固定 revision 清单和过期版本409。临时用例不批准或改写任何现有白名单。
- 6个原账号身份、题库归属和真实AI余额核对；另有9组公网账号检查，通过Linux旧格式密码登录、Secure／HttpOnly／SameSite Cookie、哈希会话和退出；未打印真实账号凭据或联系方式。
- 更新前后39张原Hub表、49张练习表与原文件逐项核对。两轮完整公网合成上传正常令审核队列 generation 合计增加2，其余原记录及附件／练习文件保留；新schema为兼容累加。数据库完整性／外键检查通过。
- 临时账号、会话、题库、审核目录和练习工作区已清理；没有向原英语题库写入测试评论或评分，没有改既有拓展白名单。
- 最后检查 Java 约159 MiB、练习约141 MiB，近10分钟没有 error 级服务日志。这是功能检查时的观察值，不是30人容量测试。

最初部署语法检查发现旧升级脚本CRLF，停服务前即终止；规范为LF后重新通过。旧代码归档后的三份测试路径已修正，随后全量Node回归0失败。公网验收工具也去掉旧阶段“AI必须关闭”的过期断言，改为核对真实配置；这些问题不通过改动用户数据绕过。

## 备份与回退

Java停写快照：`/var/backups/quizforge-hub-java-test/before-20261025-java-complete-e4af7fe/`。

练习停写快照：`/var/backups/quizforge-hub-practice/before-20261025-java-complete-e4af7fe/`。

协调脚本 `deploy/upgrade-java-practice-test.sh` 核对主机、固定目录、旧二进制摘要，分别停写备份后更新；失败回退旧二进制与配置，保留当时最新数据，不自动覆盖数据库。旧发布保留供回退，生产没有任何切换。

发布目录保留来源清单、`complete-validation.json`、验证源码清单与部署凭据；本机证据在 `.temp/java-native-complete-deploy-20261025-v2/`。数据库和私有配置不上传仓库。

## 尚待验收

- 真实浏览器／手机、文件选择和系统客户端回调；Work浏览器工具禁用，HTTP／模板与模拟会话不替代这些验收。
- 邮件、短信、Turnstile及真实模型；测试未复制供应商私密配置或模型主密钥，余额查询通过不表示免费模型已可真实使用。
- 生产完整数据副本、并发容量、故障和恢复演练，再决定生产切换。暂不发布Web安装包或Android APK。
