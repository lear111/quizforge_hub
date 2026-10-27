# 首尔部署记录

2026-10-10（北京时间）。线上地址：https://quizforge.treenewbee.cloud/

- SSH：`work-codex-seoul`，腾讯云首尔，Ubuntu 24.04.4 / x86_64。
- 运行时：官方 Node 24.21.0，下载后通过官方 SHA-256 校验，安装在 `/opt/quizforge-node`，没有替换其他服务的 Node 22。
- 当前代码：`/opt/quizforge-hub/releases/20261015-cloud-download`；`/opt/quizforge-hub/current` 为发布软链接。此前发布 `/opt/quizforge-hub/releases/20261010-221247` 保留。新版使用提供的 QuizForge PNG 图标、浅紫背景与紫色主按钮，线上静态资源的 SHA-256 与本机一致。
- 服务：`quizforge-hub.service`，开机自启，专用系统用户 `quizforge`，监听 `127.0.0.1:4318`，内存上限 384 MiB。
- 数据：`/var/lib/quizforge-hub`，权限 700，部署时为空库。本机账号和数据没有迁移。
- 邮件配置：`/etc/quizforge-hub/mail.env`，root 所有，权限 600，由 systemd 读取。真实密钥通过 SSH 传输，不在代码发布包中。
- HTTPS：已有 Caddy 增加独立域名，自动证书，覆盖 `X-Real-IP`，39 MiB 请求体限制；原有 Message Hub、MCP、Token Monitor、Pelican 和中秋页面路由保留。
- 流量：月度附件预算 150 GB、单 IP 每日 1000 MiB。应用预算不包含服务器其他服务和协议开销，云侧套餐总流量告警未在本次配置。

验收：服务器上 17 项测试全部通过。公网首页和 JS/CSS 返回 200，HTTP 跳转 HTTPS，私有配置 / 数据库 / 服务源码路径返回 404，跨源写入返回 403。公网真实 Turnstile 控件通过；经临时隔离验证页正常提交 token，首尔服务器校验 hostname / action / token 成功。验证页没有发送邮件或创建账号，完成后临时路由返回 404、4320 监听与测试服务均已停止。正式服务重启后继续正常，开机自启已启用。

本次没有重复发送测试邮件，也没有进行生产并发负载测试。真实 SES 邮件投递已在此前本机测试中由用户确认收到。

紫色主题发布：先修改本地并检查首页、上传表单和 375px 窄屏，再上传独立发布目录。服务器 17 项测试全部通过后，原子切换 `current` 并重启服务；账号、题库、附件和邮件配置目录保持原位置。旧 `/favicon.svg` 地址兼容返回同一 PNG 图标，新的 favicon 与站内 logo 使用 `/quizforge-icon.png`。

## 常用维护

```sh
ssh work-codex-seoul
sudo systemctl status quizforge-hub --no-pager
sudo journalctl -u quizforge-hub -n 30 --no-pager
sudo systemctl restart quizforge-hub
```

管理员需要在网站注册后另行明确授予，部署没有自动创建管理员。命令见 `README.md`。

Caddy 原配置备份：`/etc/caddy/Caddyfile.before-quizforge-20261010-221651`。这是添加题库站点之前的配置，恢复它会取消题库域名路由；维护时先检查后续其他站点变更再决定是否恢复。当前数据库与附件应作为整体一致性备份，并私密保管邮件配置；当前尚未配置定时异机备份。

## 2026-10-14 审核发布

升级前创建 root 私有 SQLite 在线备份；停服务切换发布前再次备份。新版本保留所有账号、附件、评论和配额，将既有 1 份题库转为待审核。用户明确指定的 `wgs` 账号已授予管理员权限，已核对其注册邮箱。审核提醒收件地址仅写入 root 的私有环境文件。

服务器上 20 项测试全通过；公网列表未展示待审题库，匿名访问该题库详情、下载、下载检查和截图均返回 404，审核接口匿名返回 401。本地与线上核心源文件哈希一致。375px 审核页面验证无横向溢出。

腾讯云控制台登录过期：专用审核提醒模板正文已准备在 `deploy/review-email-template.html`，尚未提交和取得已审核模板 ID。当前网站内审核可用，邮件队列持久保存；提醒邮件尚未启用、未进行真实投递验证。需在控制台提交模板，通过后设置 `TENCENT_SES_REVIEW_TEMPLATE_ID` 并重启。注册验证码模板保持原配置。

## 2026-10-15 临时网盘下载页

网站首页改为“网站仍在完善中”提示页，提供用户指定的夸克分享链接、提取码及复制按钮。私有环境文件增加 `DOWNLOAD_NOTICE_ENABLED` / `DOWNLOAD_NOTICE_URL` / `DOWNLOAD_NOTICE_CODE`。原社区页面入口保留在 `/manage/`，审核入口 `/manage/#reviews`，后端鉴权规则和数据保持原样。关闭提示页开关并重启即可恢复原首页；切换首页不等同于停用已有后端 API。

服务器新发布通过 22 项测试，正式站点首页已验证。原有数据库、附件、账号和审核状态保留。切换前停服务制作一致性完整数据包 `/var/backups/quizforge-hub/data-before-cloud-download-20261015-161054.tar.gz`，并通过 SSH 下载至本机 `.codex/backups/quizforge-hub`，没有放入 OneDrive、源码或公开网盘。包的 SHA-256 为 `7c6739798e1daaea8161fd9b9de16993e2ac50809ed175c72b5014d63f9d4d24`；解包后 SQLite 完整性检查 ok，2 个账号 / 2 份题库 / 4 个附件的大小及 SHA-256 全部核对通过。此备份不包含邮件密钥文件；私有配置仍在服务器保存，本次不是定时异机备份配置。

375px 页面验证无横向溢出，提取码复制成功；自动化浏览器能打开夸克 QuizForge 目录，用户另在自己的浏览器确认能正常下载。
