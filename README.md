# QuizForge 题库广场

QuizForge 的题库分享、统一账号和云端练习产品。Hub 后端采用 Java / Spring Boot，云端练习保留独立 Node 服务；生产站暂未切换，仍运行旧版本。

- 题库广场：<https://quizforge.treenewbee.cloud/>；云端练习：<https://practice.treenewbee.cloud/>。
- Java 测试站：<https://quizforge-test.treenewbee.cloud/>；练习测试站：<https://practice-test.treenewbee.cloud/>。
- 源码：<https://github.com/lear111/quizforge_hub>。仓库不包含真实账号、数据库、附件或密钥。

## 结构

| 目录 | 职责 |
| --- | --- |
| `java-hub/` | Spring Boot Hub：账号、题库、上传、审核、管理员、AI 余额与网关、客户端导入 |
| `practice/`、`cloud/`、`admin/` | 独立 Node 练习服务、固定 Web 运行时适配和私有审核桥 |
| `public/` | 练习服务使用的浏览器资源；Hub 页面在 Java 静态资源目录 |
| `vendor/` | 经审阅的基础题型及固定内容覆盖 |
| `scripts/`、`deploy/` | 构建、迁移副本、维护和测试部署 |
| `test/fixtures/`、`test/helpers/` | 合成旧格式数据、固定接口样本和临时 Java 测试宿主 |

题型执行与练习存储继续使用独立 Node 服务，保留现有 Web、Android、Extension API 和格式 3 `.qbank` 契约。Java Hub 不执行未经审核的拓展。

Java Hub 可独立构建。完整云端练习还需从指定 Web 源码构建运行快照，并随部署包交付；运行快照不进入本仓库 Git。服务器无需保留完整 Web 仓库，Web 后续修改也不会自动更新已部署的练习空间。构建方法见[工作区同步说明](docs/WEB_WORKSPACE_SYNC.md)。

## 开发启动

需要 JDK 21+、Maven 3.6.3+；完整联调与练习服务需要 Node.js 24.13+ 的 24.x。Hub 本身不需要 npm 依赖。

```powershell
.\Verify-Java-Hub.ps1
.\Start-Java-Hub.ps1 -SkipBuild
```

默认打开 `http://127.0.0.1:4338/`，数据在 `java-hub/data-java/`，使用独立开发 Cookie；全新目录为空，不生成假账号或演示内容。启动在前台运行，Ctrl+C 关闭。构建后也可 `npm start`，该命令现在启动 Java，不再启动旧 Node Hub。

完整环境、独立练习服务、原数据副本和验证范围见 [Java 开发说明](java-hub/README.md)。不要直接把生产数据库交给开发进程。

## 功能与文档

原生迁移范围已覆盖题库浏览、搜索、格式 3 包目录、单本／部分导出、上传编辑、删除分享、评论举报、注册登录、验证策略、设备授权、管理员审核、不可变审核包、拓展白名单、活动和流量统计、公开联系方式、审核邮件队列、免费 AI 余额／兑换／上游管理和网关。充值仅保留按钮，不接支付。

- [迁移进度与验收边界](docs/JAVA_MIGRATION.md)
- [账号、验证码与设备兼容](docs/JAVA_ACCOUNTS.md)
- [详情目录与部分下载](docs/JAVA_PACK_DETAILS.md)、[上传编辑](docs/JAVA_PUBLISHING.md)
- [管理、AI 和独立练习衔接](docs/JAVA_ADMIN_AI_PRACTICE.md)
- [固定 Web 运行时构建与来源](docs/WEB_WORKSPACE_SYNC.md)

旧 Node Hub、旧页面及预览入口已从源码移除。旧格式兼容通过固定样本、Node 标准加密库和 Java／练习联调验证；不再保留可运行的旧 Hub。`Admin-Java-Hub.ps1` 提供 Java 本地维护命令，`scripts/admin.mjs` 仅转发相同命令到 Java。维护时必须明确指定数据目录，不启动网页或定时邮件任务。见[维护说明](docs/JAVA_MAINTENANCE.md)。既有 `deploy/` 记录描述其各自发布时点，不能据此推断本地改动已上线。

真实浏览器／手机、真实邮件短信／模型和生产切换仍须联合验收；自动用例通过不等于这些验收完成。源码不自动部署或发布安装包。
