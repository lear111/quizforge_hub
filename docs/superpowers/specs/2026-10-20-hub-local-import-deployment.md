# Hub 本地导入部署与客户端 HTTPS 对接

日期：2026-10-20。

## Hub 已部署

- 正式地址：`https://quizforge.treenewbee.cloud/manage/#library`。
- 功能提交：`d4b7f4dc5679f2e7720020f554462d2fd67aa988`；发布目录：`/opt/quizforge-hub/releases/20261020-local-import-d4b7f4d`。
- 发布包 SHA-256：`193384eb04bf45f320edb4508d1cc34d366634a5ec3f9c4588b5fae6bb7f0ad6`。
- 发布前备份：`/opt/quizforge-hub/backups/20261020-local-import-d4b7f4d/data`，包含数据库、WAL（若存在）与全部附件。
- `quizforge-hub` 已启用 `LOCAL_IMPORT_ENABLED=1`；保留旧下载接口与文件备用入口。没有发布混合工作区里的其他云端功能。
- HTTPS `/api/config`、管理入口、新 JS 模块、公开题库清单和版本错误码已检查；登录路由与 `quizforge-hub-practice` 正常。
- 部署脚本在任务根目录 `.temp/deploy-hub-local-import.sh`；公网检查结果在 `.temp/deploy-hub-local-import-public-qa.json`。没有执行回退或恢复用户数据。

## 客户端实际问题与已验证补丁

本机已安装的启动器注册了 `quizforge` 协议，指向当前用户安装目录。源码和独立测试 EXE 均没有声明 .NET 目标框架。公网实测使用 `SecurityProtocolType.SystemDefault` 时，.NET 抛出 ReceiveFailure，内部异常为 SslProtocolType 枚举值无效；不会得到 Hub HTTP 响应。这个失败不能由 Hub 返回错误码解决。

在独立诊断程序中保持系统证书校验、SystemDefault 与固定官方 origin，仅增加以下程序集声明，HTTPS 即恢复 200：

```csharp
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
```

建议由本地维护会话把该声明加入 `core/desktop/windows/AssemblyInfo.cs`，再通过既有脚本重建启动器和安装包。不固定为 TLS 1.2、不关闭证书验证、不改系统注册表。微软对目标框架及系统 TLS 默认行为的说明见 [TLS 最佳实践](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls)。

带此一行修正的独立原生测试 EXE 已完成：官方 HTTPS 清单 → 原始 `.qbank` 下载与 SHA-256 校验 → 隔离本地 `/api/library/import` → 47 本题库出现在目录。未覆盖或重启用户正在运行的 QuizForge，也未修改用户题库、源码、安装包或正式协议注册。

本地应补充目标框架元数据回归，防止构建或测试入口再次丢失此声明；再执行现有 Hub 导入和 Windows 启动器测试，最后验证安装包升级及浏览器真实点击。测试证据与程序均留在任务根目录 `.temp`，没有将生产数据或个人凭据放入 Git。

## 当前交付边界

Hub 新按钮已经上线；用户刷新详情页后可见“下载到本地”和“下载 .qbank 文件”。安装版未补齐目标框架前，直接唤醒后的 HTTPS 下载仍可能失败，文件下载与本地导入继续可用。

本会话遵循之前“本地交给其他会话负责”的分工，已向用户询问由谁合入这一处修复。浏览器工具仍报告被 Work 设置禁用，不能把 HTTP 与隔离原生验证当作真实浏览器/系统唤醒验收。
