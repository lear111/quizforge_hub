# 2026-10-27 正式发布：Java Hub、Web 练习同步与用户并发修复

状态：正式站已切换并恢复访问。发布目录 `20261027-java-network-concurrency-r2`，构建清单的候选编号为 `20261027-java-network-concurrency`，二者使用相同的已核对业务字节。此次没有更新测试站、发布 Windows 安装包或同步 Android。

## 目标与内容

- 正式服务器：SSH 别名 `QuizForge`，`43.133.246.93` / `VM-4-16-ubuntu`，与首尔测试服务器分离。
- 题库广场：<https://quizforge.treenewbee.cloud/>；云端练习：<https://practice.treenewbee.cloud/>。
- Hub 从旧 Node 切换到 Java / Spring Boot，保留回环 4318、原 Cookie 名 `qfh_session`、账号及设备格式和现有服务名。
- 练习继续使用独立 Node 服务，回环 4323、私有管理桥 4324；显式使用正式 Hub 4318、正式域名及 Cookie，未套用测试站 4338 / 测试 Cookie。
- 练习同步听力悬浮窗、HTTPS 网络音频、人工评分即时反馈、横线纸面、导入缓存、收起分组与空白启动，以及[按账号隔离的接口并发](../docs/PRACTICE_CONCURRENCY.md)。同账号仍顺序执行；AI 网关原全站默认 2 并发及每账号 2 并发不变。
- 原有用户题库和拓展文件不被默认样例覆盖。基础内容升级只用于新工作区或显式导入，不自动重写旧拓展和历史。

## 当前目录与维护边界

| 内容 | 正式路径 |
| --- | --- |
| Hub 发布链接 | `/opt/quizforge-hub/current` |
| Hub 当前 JAR | `/opt/quizforge-hub/releases/20261027-java-network-concurrency-r2/quizforge-hub.jar` |
| Java 当前数据 | `/var/lib/quizforge-hub-java` |
| 练习发布链接 | `/opt/quizforge-hub-practice/current` |
| 练习当前发布 | `/opt/quizforge-hub-practice/releases/20261027-java-network-concurrency-r2` |
| 练习数据 | `/var/lib/quizforge-hub-practice`，保持原目录 |
| 原 Node Hub 数据 | `/var/lib/quizforge-hub`，已停用且保留，不接收正式新写入 |
| 最终停写备份 | `/var/backups/quizforge-production/20261027-java-network-concurrency-r2`，0700 |
| Hub 服务覆盖配置 | `/etc/systemd/system/quizforge-hub.service.d/90-java-production.conf` |
| 练习服务覆盖配置 | `/etc/systemd/system/quizforge-hub-practice.service.d/90-java-production.conf` |

安装了系统 OpenJDK 21 JRE；应用仍由各自的非 root 服务用户运行。原服务器私有环境文件继续提供邮件、短信、验证码 pepper 和 AI 主密钥，没有把实际凭据下载到源码或打印到日志。Java 服务仅允许写 Java 数据目录，JVM 堆上限192 MiB、服务内存上限512 MiB；练习原内存上限768 MiB保留。

## 数据、切换和回退

先在生产在线备份得到的隔离副本上演练，不让 Java 打开正在使用的 Node 数据目录。核对所有旧表、原列值及附件，验证原 AI 密钥可解密、验证码配置被识别、管理桥和 SSO。最终切换时重新停写、备份两套完整数据，再用 `snapshot-hub-for-java.mjs --source-stopped` 生成独立 Java 数据，未使用较早的演练副本替代最新数据。

首次切换在公开恢复前因部署脚本错误要求未登录 `/admin/` 返回200而自动回退；实际应303跳转登录。旧二进制和配置已恢复，未用旧备份覆盖数据；失败的 Java 数据副本另外保存在首次备份中。修正检查，并在隔离副本验证未登录跳转、已登录管理页及完整 SSO/桥接后重试。

第二次停写窗口约 **6.518 秒**。公开恢复前核对 Hub **38 张旧表、15 份原有非数据库文件**，练习 **49 张旧表、4,618 份文件**；全部旧记录和文件摘要保留。原22条拓展审核决定保持原样，新运行时在首次启动登记2条固定基础拓展摘要；第二次备份已含这2条，因此第二次比较新增数为0。没有覆盖既有批准或撤销决定。部署验证临时会话已从 Java 数据库移除，不生成演示账号，不发送验证码或执行真实模型评分。

两个旧发布目录、原 Node Hub 数据和停写备份均保留。公开恢复后可能已经有新的账号、上传、余额或练习写入：**不能直接恢复旧 Node 数据或用备份覆盖当前库**。若需回退，先维护停写并备份当前数据，再评估兼容导回或修复前进；本次自动回退只适用于公开恢复前。

## 固定构建与检查

- 本地工作区：`refactor/hub-layout-20261025`，基线 `83d6dfdc5497013b7b4811f8a9c960eab6b503b6`，包含未提交改动，发布清单明确标记。部署不代表 Git 已提交或合并。
- Java JAR SHA-256：`654a9ffde4e53771ea6eea374584f5ae0e5324b11cbb0537ac87e0b0c130cda0`。
- Web 固定来源：`4522bb81c2126a699fcf72ce61d074dbc1264161` 加31份冻结覆盖；253项业务输入，`includesWorkingTree:true`。
- Web 来源锁 SHA-256：`3bef5089b6081ec749a5126cafcec3940b17090328228c0b074e960259e8f889`；Linux运行时811项文件，练习服务41项源码逐项核对。未部署 Windows 原生依赖。
- 当前源码清单 SHA-256：`c638d1b155cd8027b075746d249050b40221a9bef7c14a5390c82498364212a1`；练习源码清单 SHA-256：`afd26afbcf72351e9b34d3fee4f8659fdf7966ba21feb1f159436e6b2443b29c`。
- 本轮重新构建：Java **78/78**，Node **106/106**，0失败／0跳过。正式服务器隔离候选的网络听力及并发检查 **5/5**，未使用真实用户作答测试。
- 切换检查包含数据保留、Java健康、题库目录、管理登录边界、私有接口拒绝、原管理员临时会话、AI密钥解密与账号查询、原验证配置、Java/Node管理桥、SSO、练习匿名拒绝及PWA清单。
- 发布后从本机直连正式IP，使用正式域名SNI及系统证书验证，**21组公网检查通过**：页面／目录／管理登录边界、内部API和数据库路径拒绝、Java健康标识、standalone PWA清单及PNG图标，以及正式音频的精确字节、MIME、匿名CORS、HEAD、Range206、写入405、禁用目录与412/416不设immutable。没有关闭TLS验证。
- 发布后 PID：Hub `1399383`，练习 `1399384`；Caddy仍 `1070`，仅平滑reload。Caddy最终SHA-256为 `7ef4869cb4fb84173939c7859d51a5a602ea4bb27a0bb44eea59651fdb0c7990`。

本机证据位于 `.temp/production-20261027-release/`（含production-report、public-validation、service-validation及review-preservation）、`.temp/production-20261027-maven.log` 和 `.temp/production-20261027-node.tap`。服务器副本、配置和本次运维脚本备份仅留在受保护目录，不随 Git 或公开附件交付。HTTP验证不代替真实浏览器PWA安装、手机书写、真实短信/邮件/模型、30用户容量或灾难恢复验收。

## 正式公共音频

正式地址已建立为 `https://quizforge.treenewbee.cloud/shared-media/audio/<sha256>.<扩展名>`；目录 `/var/lib/quizforge-shared-media/audio`，发布器 `/usr/local/lib/quizforge-shared-media/publish.py`，Caddy片段 `/etc/caddy/quizforge-shared-media.caddy`。沿用测试库的匿名CORS、类型头/大小/摘要校验、原子不覆盖发布、Range、长期缓存及禁用目录/网页写入规则。资源不跟随应用升级删除。

部署仅放入一段3244字节合成静音WAV用于协议检查，没有自动迁移或改写题库中的测试URL。现有 `scripts/upload-shared-audio.mjs` 仍明确指向测试库；正式素材使用服务器上的正式发布器，不能只把测试回执的域名改成正式域名。操作说明见[静态库文档](../docs/SHARED_MEDIA.md)。
