# 公共音频静态库（管理员维护）

当前方案只供我们自己的题库制作流程使用，不提供网页上传按钮、公开上传接口、资源列表或资源数据库。音频独立于程序发布目录，由 Caddy 直接读取，Java Hub 和练习服务不转发音频字节。

2026-10-27 正式库已随[正式发布](../deploy/production-20261027.md)建立：域名 `https://quizforge.treenewbee.cloud`，目录 `/var/lib/quizforge-shared-media/audio/`，SSH发布器 `/usr/local/lib/quizforge-shared-media/publish.py`，服务器别名 `QuizForge`。正式库与测试库独立，既有测试URL没有自动迁移或改写。下文原Node上传工具仍明确用于测试库，不要误认为改变SSH别名就能上传正式库。

正式发布器接收标准输入音频字节及 `--sha256 <完整摘要> --extension <mp3|wav|ogg|m4a> --size <字节数>`，须经 `ssh QuizForge sudo -n python3 /usr/local/lib/quizforge-shared-media/publish.py ...` 调用并使用实际JSON回执。通过二进制流工具传输，不要用会转成文字的PowerShell管道发送音频；没有正式上传回执时不得只改域名拼接地址。正式库当前只有合成验证资源，后续实际素材须显式上传。

## 地址与目录

- 测试域名：`https://quizforge-test.treenewbee.cloud`
- 公共地址：`/shared-media/audio/<SHA-256>.<mp3|wav|ogg|m4a>`
- 独立数据目录：`/var/lib/quizforge-shared-media-test/audio/`
- 私有上传暂存目录：`/var/lib/quizforge-shared-media-test/.incoming/`
- SSH 发布器：`/usr/local/lib/quizforge-shared-media-test/publish.py`
- Caddy 路由：`/etc/caddy/quizforge-shared-media-test.caddy`，只在测试 Hub 站点导入。

资源是公开、匿名可读的音频，不要上传个人录音、私有文件或密钥。普通网页请求仅允许 GET、HEAD 和 OPTIONS，写入通过现有 SSH 运维权限完成。文件不跟随题库或应用升级删除。

文件名由内容 SHA-256 自动生成：相同内容和相同音频扩展名复用地址；内容改变生成新地址。哈希只用于标识文件字节，不能证明素材来源、授权或听音质量。不同资源不覆盖旧文件，已有同名资源字节不符时上传失败，须人工检查。暂不提供清理旧资源的操作。

## 给题库制作会话的操作顺序

前提：本机可运行 Node.js 24；现有 SSH 别名 `work-codex-seoul` 可通过密钥连接，且已有无交互 sudo 运维权限。上传工具不索取、保存或打印密码、私钥、应用令牌。未配置 SSH 的环境应交给维护者执行，不复制这些凭据到题库制作材料。

从 `quizforge_hub` 仓库根目录执行：

```powershell
# 可先校验、生成预计地址；此命令不会上传文件。
node scripts/upload-shared-audio.mjs --dry-run "C:\素材\听力.mp3"

# 上传一段或多段音频，输出实际地址，并保存本机回执。清单文件名必须不存在。
node scripts/upload-shared-audio.mjs "C:\素材\听力.mp3" --output ".temp/audio-upload-result.json"
```

上传按文件依次进行。每个文件单独原子发布，后续文件失败不删除已经成功上传的文件；成功回执逐项输出，可据此重试。`--dry-run` 的地址只是预计地址，不能当作上传成功凭据。

1. 保留原始音频。上传当前题库需要的完整听力段，支持 MP3、WAV、OGG、M4A；每段不超过 **64 MiB**。工具检查文件类型头和字节身份，不做转码或真实解码验收。
2. 使用上传成功回执中的 `url`。再次上传同一份素材会返回 `reused`；不要手工拼接、猜测地址。
3. 在题库材料声明中用 `url` 替换 `file`，二者只能保留一个。材料 ID、题目绑定和现有拓展不用改变：

```json
{
  "listening": {
    "materials": [
      {
        "id": "exam-audio",
        "title": "整卷听力",
        "url": "这里填写上传回执里的完整HTTPS地址"
      }
    ],
    "examMaterialId": "exam-audio"
  }
}
```

4. 在已支持网络听力的本地 Web 中实际播放、切材料和跳转，核对题目与音频对应关系；Hub 练习空间和 Android 必须先同步网络听力能力，静态库上线不代表各端播放器已经更新。
5. 生成网络版交付副本时，确认网络引用有效，再从该副本剔除已外置的音频文件并重新导出 `.qbank`。导出器会复制题库目录，**只改成 URL 而保留音频文件，并不会自动减小包体积**。保留原始素材和完整离线版本，不批量删除正式题库或历史目录中的资源。
6. 明确标注需要联网；网络链接不等于持久离线包。考试只冻结 URL，远程字节不冻结。内容修订上传新文件后更新题库 URL，旧资源继续保留。

上述Node工具当前生成的是测试地址；正式库虽已上线，测试地址不会自动变成正式资源。实际将同一字节发布到正式库后使用正式回执，资源路径可保持不变，但题库URL仍须显式改写。

## 分发与读取

- 支持 HTTPS、正确的音频 Content-Type、匿名 CORS（`Access-Control-Allow-Origin: *`，无凭据），可供本地 HTTP/LAN Web 读取。
- 完整文件和普通缓存条件读取使用 `public, max-age=31536000, immutable`；ETag 支持条件请求。Range、If-Match、If-Unmodified-Since 请求保留 `no-store`，包括 412／416 错误，避免在当前 Caddy 2.6 上误缓存错误响应。
- 支持 HTTP Range/206。当前本地 Web 仍先完整缓存当前一段后播放，不因服务器支持 Range 自动变成流式播放器。
- 不提供目录浏览；目录、隐藏文件、非音频路径和不存在文件返回404，失败不会设置长期 immutable 缓存。静态音频不经账号认证，不在该路径存放任何账号或作答数据。
- 本轮未接 CDN、对象存储或带宽保障。30个合成小文件并发请求只验证正确性，不证明真实听力峰值容量。

## 运维与检查

部署时使用 `deploy/install-shared-media-test.py`：先比对预期 Caddy 配置摘要、校验候选配置，再只给测试站增加导入并平滑 reload。备份旧配置，核对 Hub／练习／Caddy PID 不变；不重启应用或切换生产域名。

安装器仅用于首次配置，发现已有路由或非空目录会停止，避免覆盖现有资源。后续维护先核对当时运行的配置与文件摘要，不能通过删除资源目录来重跑安装器。本次部署记录见 [2026-10-26 测试静态库](../deploy/shared-media-20261026.md)。

上传后可独立核验：

```powershell
node scripts/verify-shared-media.mjs "上传回执里的url" "上传回执里的sha256" "上传回执里的bytes"
```

检查实际字节摘要、MIME、缓存、CORS、HEAD、Range、ETag、禁止写入和禁止目录列表。测试工具不携带账号凭据，不打印音频内容。有关 Caddy 静态文件和无停机配置加载，参见[文件服务文档](https://caddyserver.com/docs/caddyfile/directives/file_server)和[reload 文档](https://caddyserver.com/docs/command-line#caddy-reload)。

本地自动检查：

```powershell
node --test test/shared-media.test.mjs
python -B test/shared_media_publisher_test.py
```

Linux 上可额外执行 `python3 -B test/shared_media_caddy_test.py`；它启动临时回环 Caddy、执行协议验证后退出，不修改系统 Caddy 或已有用户数据。测试证据与实际部署记录另行保存。
