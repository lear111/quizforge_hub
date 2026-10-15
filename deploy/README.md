# 自有服务器部署

2026-10-10 已通过 `work-codex-seoul` 部署至腾讯云首尔 Ubuntu 24.04 服务器。实际使用独立 Node 24.21.0、systemd 和已有 Caddy，域名为 `quizforge.treenewbee.cloud`。服务与目录记录见 `seoul-deployment.md`。下面的步骤用于维护或迁移；`nginx.conf` 仍是未启用的参考模板。

1. 上传 `server.mjs`、`mail.mjs`、`email-codes.mjs`、`review-notifications.mjs`、`package.json`、`public/` 和 `scripts/admin.mjs` 到 `/opt/quizforge-hub/releases/<发布编号>`，`/opt/quizforge-hub/current` 指向当前发布。当前没有 npm 依赖，不需上传 `node_modules`、本地 `data/`、`.sites-runtime/`、`.openai/` 或测试数据。
2. 创建专用系统用户 `quizforge`，创建其可写目录 `/var/lib/quizforge-hub`。代码目录只需可读。不要覆盖服务器已有站点目录。
3. `quizforge-hub.service` 使用 `/opt/quizforge-node/bin/node`、专用用户、生产 HTTPS origin、Secure Cookie、150 GB 月度附件预算及 384 MiB 内存上限。将文件安装为 systemd 服务并启用开机启动。Node 4318 只监听回环地址。
4. DNSPod 的 `quizforge` A 记录指向首尔 IP；将 `Caddyfile.quizforge` 合并到既有配置，验证后 reload。Caddy 自动申请与续期 HTTPS 证书，覆盖客户端传入的 `X-Real-IP`，限制请求体 39 MiB，不缓存附件。首尔现有其他网站继续使用原配置。
5. 安全组仅开放所需的 HTTP / HTTPS 和受限的管理端口。只在反向代理覆盖 `X-Real-IP` 且后端不可公网访问时使用 `TRUST_PROXY=1`。
6. 配置腾讯云流量与费用告警，检查 200 GB 套餐当月已使用量。应用下载预算只统计站内附件，不能限制服务器的全部出网流量，也不保证阻止攻击导致的费用。
7. 先小范围试用；完成扫描 / 审核、身份核验等运营要求和恢复演练后再决定公开范围。

生产管理员操作时，需要与服务使用相同的 `DATA_DIR`，例如：

```sh
sudo -u quizforge env DATA_DIR=/var/lib/quizforge-hub /opt/quizforge-node/bin/node /opt/quizforge-hub/current/scripts/admin.mjs promote admin@example.com
```

这会授予该已注册账号内容管理权限，请使用实际管理员的邮箱。配置模板不会自动创建账号、修改现有防火墙或部署任何服务。

邮件配置使用 `/etc/quizforge-hub/mail.env`，从 `mail.env.example` 填写真实配置，文件归 root 所有并设置权限 600，systemd 在启动服务前读取。先保持 `TENCENT_SES_ENABLED=0`；配置真实 Turnstile 站点键和服务端密钥，允许实际网站 hostname，然后执行指定收件邮箱的测试。确认投递及人机验证后启用邮件并重启服务。源码打包必须包含 `mail.mjs` 和 `email-codes.mjs`，不得包含真实密钥文件。

审核版本升级前先一致性备份 SQLite 和附件，保留旧发布目录。新版本首次启动会将旧题库转为待审；旧版本没有访问限制，迁移后不得直接回退旧版本继续公开服务。设置 `REVIEW_EMAIL` 和已审核的 `TENCENT_SES_REVIEW_TEMPLATE_ID` 后重启，再检查管理员页的提醒状态。

临时下载页：在私有环境文件配置 `DOWNLOAD_NOTICE_ENABLED=1`、`DOWNLOAD_NOTICE_URL` 和 `DOWNLOAD_NOTICE_CODE` 后重启。原社区入口为 `/manage/`，审核入口为 `/manage/#reviews`，后台权限规则保持原样。恢复原首页时关闭 `DOWNLOAD_NOTICE_ENABLED`。切换首页不停止后端 API，也不取代完整数据备份。
