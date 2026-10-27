# 云端练习空间

本目录集中维护独立 Node 练习服务。Java Hub 负责账号、题库广场、审核决策与 AI 账本；本服务通过固定内部接口衔接，并保存隔离的用户练习工作区。

正式站已于 2026-10-27 更新到 `20261027-java-network-concurrency-r2`，包括网络听力和按账号隔离的接口队列。测试站保持自己的发布版本，本次未切换测试站；见[正式发布记录](../deploy/production-20261027.md)。

练习 API 按账号排队，不同账号可并发；同账号的保存、工作区合并及管理操作保留顺序。会话缓存有界，活动会话不会被其他账号回收。限制、AI 网关的区别及验证范围见[用户并发说明](../docs/PRACTICE_CONCURRENCY.md)。

| 目录 | 内容 |
| --- | --- |
| `server/app.mjs` | 练习 HTTP 服务、鉴权边界与静态资源交付 |
| `server/cloud/` | 云端题库、练习状态、配额、AI 与 Hub 身份适配 |
| `server/admin/` | 私有审核桥、冻结审核包与活动记录 |
| `server/accounts.mjs`、`server/admin-contact.mjs` | 账号同步及联系方式格式处理 |
| `public/` | 练习页面、脚本与样式 |
| `vendor/locks/` | 指定 Web 版本、逐文件摘要与冻结覆盖清单 |
| `vendor/web-basic-20261023/` | 清单对应的原始覆盖文件，保留原始字节 |
| `vendor/web-sync-20261027/` | 新 Web 功能的冻结覆盖，配套 20261027 来源锁定清单 |

启动入口是仓库的 `scripts/cloud-practice-site.mjs`，也可在仓库根目录运行 `npm run start:practice`。需要明确的 `DATA_DIR`、`CLOUD_RUNTIME_DIR` 与 Hub 接入参数，见 [Java 与练习衔接](../docs/JAVA_ADMIN_AI_PRACTICE.md)。服务部署模板见 [deploy](../deploy/README.md)。

题目渲染、草稿、答题区及拓展运行使用固定 Web 核心快照；快照仍由 `CLOUD_RUNTIME_DIR` 指向，目录整理不移动已有快照或用户数据。公共答题功能在 Web 修改后，按[同步说明](../docs/WEB_WORKSPACE_SYNC.md)重新构建并验收。

当前测试发布 `20261027-web-sync` 已包含听力悬浮播放器、题库加载缓存优化、收起分组／空白启动、基础拓展人工评分即时反馈，以及答题区与草稿横线纸面。既有题库／拓展代码及历史不被默认样例覆盖。来源、验证与部署见 [Web 同步说明](../docs/WEB_WORKSPACE_SYNC.md)及[测试部署记录](../deploy/web-sync-20261027.md)。

源码路径与网址独立：`/cloud/`、`/api/cloud/` 和 `/internal/admin/` 等接口保持原样。Java 页面仍在 `java-hub/src/main/resources/static/`；跨服务测试集中在仓库 `test/`。

## AI 评分偏好

当前浏览器尚未保存该账号偏好时，默认开启 AI 评分、自动评分和免费额度；自定义模型默认不选。已有偏好及旧版自定义配置优先，不覆盖用户选择。初始化完成后才向普通题卡发送评分偏好，避免首次进入题库使用错误开关。

提交响应包含已经排队的任务显示状态，题卡首次读取无需额外网络往返即可显示评分中；后续查询、任务去重、答案确认与计费保持原流程。排队显示不表示模型已经返回结果。此默认值仅适用于 Hub 云端练习，不改变本地 Web 或 Android。

## 安装到桌面或主屏幕

普通练习站（`practiceHome: true`）在 `/cloud/pwa/manifest.webmanifest` 提供固定、匿名可读的安装清单，图标仅开放 `/cloud/pwa/icons/` 下的白名单文件。它们来自已校验的 Web 运行快照，不包含用户 ID、令牌或私人目录；GET/HEAD 不依赖 Hub 登录服务，不写账号、题库或会话。其余练习资源和 API 继续验证账号与所有权。

页面的安装清单、站点图标及主屏幕图标均引用上述固定地址。应用 ID、启动地址和 scope 保持 `/`，独立窗口使用 `standalone`；启动后沿用现有登录跳转，进入当前账号自己的练习空间。HTTPS 由现有部署入口提供。是否出现安装入口及最终安装形式仍受浏览器、系统和安装服务影响；添加普通快捷方式不等同于完成独立应用安装验收。

回归检查：`node --test test/practice-pwa.test.mjs test/cloud-practice-site.test.mjs`；可用 `QFH_TEST_RUNTIME` 显式选择已校验的兼容快照。测试覆盖匿名/过期凭据、身份服务失败、GET/HEAD、图标真实尺寸和字节、Host 检查、非白名单路径拒绝及私人资源仍需登录。真实 Chrome/Edge 安装、独立窗口重启与跨站登录回跳需在部署后单独验收。
## 最新候选：网络听力引用

新增网络听力已从 Web 冻结同步，来源清单为 `vendor/locks/web-workspace-20261027-network.json`，本机候选 `.runtime/web-sync-20261027-network`（路径相对仓库根目录）。题库可声明HTTPS材料URL，浏览器匿名读取完整音轨；Hub服务端不提供任意URL代理。宿主页面允许HTTPS连接与Blob媒体，题型iframe网络权限保持关闭。旧用户题库、拓展、笔迹和历史不被默认内容覆盖。

构建、范围和上线状态以 [Web同步说明](../docs/WEB_WORKSPACE_SYNC.md) 及 [本轮记录](../deploy/web-sync-20261027-network.md) 为准，源码更新不会自动切换服务器运行版本。
