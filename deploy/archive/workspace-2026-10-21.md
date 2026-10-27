# Web 工作区同步部署

用户在候选提交后明确授权尝试部署。代码版本为 `1dd0078def6108a9dba52fba5da83715037a400c`，分支 `feat/hub-web-workspace-sync`；没有修改或部署 Web/Android 主项目，没有推送 GitHub 或合并 PR。

公网检查完成于 2026-10-22 03:09 UTC（洛杉矶 10 月 21 日晚，北京 10 月 22 日上午）。

- 题库广场：<https://quizforge.treenewbee.cloud/>
- 云端练习：<https://practice.treenewbee.cloud/>
- 两个服务发布目录分别为 `/opt/quizforge-hub/releases/20261021-web-workspace-1dd0078` 和 `/opt/quizforge-hub-practice/releases/20261021-web-workspace-1dd0078`。
- 两个 `current` 已原子切换，服务均为 active/running。既有 systemd 用户、端口、私有配置与 Caddy 路由保留。
- 邀请码验证仍开启，本地一键导入入口开启，普通文件后备保留。首页现为题库广场，`/manage/` 返回相同内容。

## 来源与运行时

源码归档 SHA-256：`ef156a2b964d4904eacdd6bdeaa3ebd4a615d686ba48d8cdf67a705a57d43db7`。

Linux x64/glibc 运行时在首尔隔离目录构建，使用 Web lock 的 `@napi-rs/canvas` 1.0.12 和对应原生模块。794 个文件通过校验；其中 236 个源码/基础内容文件与 `deploy/web-workspace-20261021.json` 一致。

部署后的 `.runtime/web-current/snapshot.json` SHA-256：`b256804c7b836cdfa90fc474284b24c18592f14eff83f232a5a55b4e2a21e327`。文件清单来源摘要：`65930ed4daf187deabbaf2d64dafacfa5d70139ef76295bf15d8d33846cffaff`。没有把 Windows 原生模块复制到 Linux。

只安装 `fonts-noto-cjk`（`1:20230817+repack1-3`）与 `fontconfig`（`2.15.0-1.1ubuntu2`），没有升级其他系统包。原生字体枚举识别 Noto CJK 集合，练习服务账号成功生成中文、英文和数字的合成检查图，人工查看中文可读。该检查不使用任何用户答案。

## 备份与切换

切换前先停止练习服务并等待请求完成，再停止 Hub，复制各自完整数据目录到 root 私有备份：

- `/opt/quizforge-hub/backups/20261021-web-workspace-1dd0078-r2/data`
- `/opt/quizforge-hub-practice/backups/20261021-web-workspace-1dd0078-r2/data`

备份目录中保留旧发布指向及切换前后数据库汇总。此前旧发布目录仍保留。没有把备份下载到 OneDrive 或放入源码。

在备份的独立副本上运行升级演练：现有 2 个账号、2 个工作区、2 本题库，两个已保存题库状态文件的字节摘要保持一致。每个账号目前只有一个空间，因此生产副本没有跨空间合并需求；多空间冲突/合并及扩展示例作答保留由先前 Windows 回归覆盖。演练副本没有替换生产数据，正式合并按用户访问延迟执行。

最终切换前后 SQLite quick_check 均为 ok；Hub 原有 23 张表、练习原有 34 张表的记录数一致。没有清空题库、作答、历史或账号，也没有覆盖上线后写入的数据。

首次切换时，新服务已正常启动，但部署检查使用 fetch，没有正确传递练习站要求的 Host，误判为未就绪。脚本自动恢复旧发布链接，保留当时数据。改用原生 HTTP 并明确指定 Host 后，第二次发布全部健康检查通过。第一次备份另存于不带 `-r2` 的同名目录。

## 公网与权限验证

- `/`、`/manage/` 均为 200，内容相同；临时网盘首页已移除。
- 练习站匿名访问 `/` 返回 303 到 `/auth/hub`；沿用 Hub 登录系统。
- 公网 `app.js`、`local-import.js`、`cloud/library.js` 和 `cloud/import.js` 的字节摘要与发布源码一致。
- Hub 管理接口匿名返回 401，练习用量接口匿名返回 401，练习公网管理接口返回 404；两站 `server.mjs` 返回 404。
- 服务账号已通过运行时逐文件、目标平台、源码锁定和字体合成校验。发布前 Linux 回归 66 通过/1 跳过，旧版迁移另在 Windows 通过；最后路由检查 9/9 通过。

本轮没有使用生产登录凭据、读取 API Key、创建生产测试账号或自动审核题库/拓展。没有完成登录后的真实浏览器交互、手机手写/拍照、客户端系统唤起或真实付费模型验收。自动检查、上线成功与这些交互验收分别记录。

后续回退前须评估是否已有工作区合并或用户新写入，保留当前数据与恢复副本，不能直接恢复旧数据库覆盖用户记录。新答题区包不能靠旧运行时渲染，出现问题应先诊断并修复对应版本。
