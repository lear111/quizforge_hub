# Java 本地维护

维护命令只供拥有服务器／数据目录权限的操作者使用，不是公开HTTP接口。执行时不开HTTP服务、不运行定时审核邮件、不自动选择旧数据目录。

2026-10-27 正式站 Java 数据目录为 `/var/lib/quizforge-hub-java`，运行 JAR 为 `/opt/quizforge-hub/current/quizforge-hub.jar`。`/var/lib/quizforge-hub` 是停用的原 Node 数据，不再接收正式新写入；维护时必须明确选择 Java 目录，不要把旧目录当作当前库。独立练习数据仍在 `/var/lib/quizforge-hub-practice`。发布后若有新写入，不得直接用旧 Node 库覆盖 Java 库，见[正式发布与回退边界](../deploy/production-20261027.md)。

需要先构建当前Java JAR，JDK21+：

```powershell
mvn -f java-hub/pom.xml package
.\scripts\Admin-Java-Hub.ps1 -DataDir 'D:\QuizForgeData' promote 'admin@example.test'
```

数据目录必须已经有数据库，且由Java创建或具有完整停写迁移副本标记。不会直接采用未标记的旧Node库，也不自动关闭任何正在运行的服务。迁移完整旧库仍按[副本说明](../java-hub/README.md)安排停写和备份。

## 命令

将下表命令及参数放在 `-DataDir <目录>` 后：

| 命令 | 参数及作用 |
| --- | --- |
| `promote` / `demote` | 邮箱或手机号；更改已有账号角色，保留账号ID并记录本地操作审计 |
| `invite-create` | 管理员账号、数量（默认1）、有效天数（默认30）；生成的邀请码只在此次输出完整值 |
| `invite-list` | 管理员账号；查询邀请码状态及前缀 |
| `invite-revoke` | 管理员账号、邀请码ID；停用未使用邀请码 |
| `auth-login-recovery` | 管理员账号；仅关闭登录验证码／人机验证，保留注册要求和账号密码 |
| `signup-bonus` | 可选金额，单位元；不填查询，填0–100设置，内部仍用10000整数单位表示1元 |
| `download-publish` | windows/android、源安装包、版本、可选说明；流式计算SHA并替换对应平台清单 |
| `download-remove` | windows/android；从下载清单移除对应安装包 |

示例：

```powershell
.\scripts\Admin-Java-Hub.ps1 -DataDir 'D:\QuizForgeData' invite-create 'admin@example.test' 2 7
.\scripts\Admin-Java-Hub.ps1 -DataDir 'D:\QuizForgeData' signup-bonus 1
.\scripts\Admin-Java-Hub.ps1 -DataDir 'D:\QuizForgeData' download-publish windows 'D:\Build\QuizForge.exe' 0.1.0-preview.4 预览版
```

原命令拼写 `node scripts/admin.mjs ...` 继续可用，但它只启动同一个Java维护入口，不包含Node业务逻辑。用 `--data-dir=<目录>`，或明确设置 `HUB_JAVA_DATA_DIR` / `DATA_DIR`；命令失败返回非零。旧JAR缺少维护类时直接失败，不会误启动网站。

## 存储与失败处理

邀请码、角色和赠送配置使用现有SQLite格式与事务。角色更改仍绑定稳定账号ID；邀请码等管理命令要求已有有效管理员。

安装包保存于数据目录的 `downloads/`，清单采用原schemaVersion1和文件命名。发布只修改对应平台，计算实际SHA-256，原包在新清单保存后才清理；同版本替换时，清单写入失败会恢复原二进制。拒绝越界文件名、符号链接目标和无效平台。不要把用户数据、密钥或真实兑换码输出提交到Git。

维护命令不代替更新部署、服务重启、备份或生产切换授权。本次只更新本地源码；测试站／生产原发布保持。
