# 2026-10-26 公共音频静态库测试部署

本轮仅新增测试域名 `quizforge-test.treenewbee.cloud/shared-media/`。未修改正式站路由、应用代码、数据库、题库、作答或历史。服务端备份文件名使用服务器 UTC 时间，因此文件名为20261027；本报告按用户当地日期记录。

## 已部署

- 数据：`/var/lib/quizforge-shared-media-test/audio/`，与 Java／练习发布目录分开。
- 暂存：同根 `.incoming/`，仅管理员可读取；最终核对为空。
- SSH 发布器：`/usr/local/lib/quizforge-shared-media-test/publish.py`。
- Caddy：`/etc/caddy/quizforge-shared-media-test.caddy`，仅在原测试 Hub 站点增加一行 import。
- 上传工具：仓库 `scripts/upload-shared-audio.mjs`，单段上限64MiB，返回固定内容地址，不覆盖同名文件。
- 验证工具：`scripts/verify-shared-media.mjs`。操作流程见 [SHARED_MEDIA.md](../docs/SHARED_MEDIA.md)。

最终 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| 修改前主 Caddyfile | `288b5e39579f61074777e396f450cebbb0cead4666b25772db3bc7e03b4e6bd0` |
| 修改后主 Caddyfile | `2667bdd1f38ac558a3c85c6ded362e22cd855d064cd4e1dbde1f19591a106ef2` |
| 最终静态路由 | `f82295f06f22cfae86becee1857ad2e1e94c8716ddac6add0ca8d584a5abe1b8` |
| SSH 发布器 | `2aec471d047f3ce34a5cdbb9092ec6ddd2544d7168c9c173ee64b1ff7b548fc5` |

## 验证

- 本机 Node 上传工具测试3/3通过。
- Python 发布器 Linux 测试7/7通过，包含并发去重、不覆盖、坏摘要、超限、截断流和符号链接拒绝。Windows为6通过、1项Linux符号链接检查跳过。
- 使用实际 Caddy 2.6.2 启动隔离回环服务，11组检查通过，包括 Range、ETag、CORS、禁止写入／目录浏览、404/412/416缓存规则及其他路由保留。30个合成小文件并发读取字节正确；不将此结果当作真实音频容量验收。
- 实际SSH上传合成静音 WAV（3244字节）成功，第二次返回 `reused`，地址与摘要相同。最终静态库只包含这一份合成音频。
- 公网系统TLS验证9组检查通过；不携带账号凭据。新Web源码的 `readNetworkAudio` 实际读取同一HTTPS资源，MIME和摘要一致；这是Node执行该函数的检查，不等于浏览器实际播放或浏览器CORS执行验收。
- 安装、补充412防缓存规则前后，Java测试PID2377746、旧Node Hub PID1810627、练习PID2377797、Caddy PID12260均保持 active且未变化。仅对Caddy进行平滑reload，未停止或重启应用服务。
- 当前未进行真实听力、手机/平板、安装包、30人真实峰值或CDN验收。未同步Hub/Android网络播放器，未提交、推送或发布产品安装包。

## 证据与回退

本机 `.temp/shared-media-20261026/` 保存上传回执、协议结果、Web读取结果和部署记录；服务器 `/tmp/quizforge-shared-media-20261026/` 保存部署与隔离验证证据。

主配置备份：`/etc/caddy/Caddyfile.before-shared-media-test-20261027-055848`。初版静态路由备份：`/etc/caddy/quizforge-shared-media-test.caddy.before-preconditions-20261027-060237`。这些备份只有root可读。

若需撤回入口，先确认主配置、路由与本报告摘要仍一致；校验移除本次一行import后的候选配置，再reload。若已发生其他部署变更，不能整份覆盖旧Caddyfile。回退入口不删除音频，不回退应用或数据库，也不自动删除上传记录。
