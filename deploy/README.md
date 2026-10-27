# 部署工具

应用开发入口见[仓库说明](../README.md)。这里存放当前服务模板、部署脚本及配置示例，脚本不会因提交或合并代码而自动执行。

2026-10-27 正式站已完成 Java Hub 与新版独立练习的协调发布，当前目录、数据、停写备份及回退边界见[正式发布记录](production-20261027.md)。下面的 `*-test` 脚本仍仅适用于测试主机，不能直接拿来更新正式站。

| 文件 | 用途 |
| --- | --- |
| `quizforge-hub-java-test.service` | Java 测试服务模板 |
| `quizforge-hub-practice.service` | 独立 Node 练习服务模板 |
| `install-java-test.sh` | 测试站首次安装 |
| `upgrade-java-test.sh` | Java 测试服务更新、备份与代码回退 |
| `upgrade-java-practice-test.sh` | Java 与练习测试服务协调更新 |
| `shared-media-test.caddy`、`install-shared-media-test.py` | 测试域名公共音频静态分发；只 reload Caddy，不重启应用 |
| `publish-shared-audio.py` | SSH 管理员发布器，校验并原子保存音频，不覆盖同名内容 |
| `mail.env.example`、`sms.env.example`、`review-email-template.html` | 验证与审核通知的配置示例 |

从仓库根目录执行 `node scripts/prepare-java-release.mjs .temp/<新目录> <发布编号>` 生成 Java JAR、练习源码包和逐文件清单；完整运行时须另行准备。练习包使用 `practice/server/` 和 `practice/public/` 布局，启动入口仍为 `scripts/cloud-practice-site.mjs`，已有数据目录与 `CLOUD_RUNTIME_DIR` 保持原位。

升级脚本限定当前测试主机、路径及旧版本摘要，生产不能直接套用。备份与服务更新可能中断连接，应按当前任务授权安排；代码回退不会自动用旧数据库覆盖最新数据。

完整测试发布记录见[历史报告](archive/java-test-complete-2026-10-25.md)，参数说明见[Java 管理、AI 与练习衔接](../docs/JAVA_ADMIN_AI_PRACTICE.md)。旧 Node 生产部署说明、旧配置和历次部署证据统一放在 [archive/](archive/README.md)。Web 来源锁定清单在 `practice/vendor/locks/`。

公共音频上传工具为 `scripts/upload-shared-audio.mjs`，返回可写入题库的内容固定地址；步骤及限制见[公共音频静态库](../docs/SHARED_MEDIA.md)。资源独立于应用发布目录，不随题库或版本更新删除。
