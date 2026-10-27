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

已在 Web 独立分支 `fix/hub-client-tls-framework` 将该声明加入 `core/desktop/windows/AssemblyInfo.cs`，修复提交 `a8ee52de63c15d7e43b6b724b54177fa7132e6bb`；本地 `main` 与原会话工作区保持原样。不固定为 TLS 1.2、不关闭证书验证、不改系统注册表。微软对目标框架及系统 TLS 默认行为的说明见 [TLS 最佳实践](https://learn.microsoft.com/en-us/dotnet/framework/network-programming/tls)。

带此一行修正的独立原生测试 EXE 已完成：官方 HTTPS 清单 → 原始 `.qbank` 下载与 SHA-256 校验 → 隔离本地 `/api/library/import` → 47 本题库出现在目录。未覆盖或重启用户正在运行的 QuizForge，也未修改用户题库、源码、安装包或正式协议注册。

已补充编译后运行时目标框架与 TLS 兼容开关检查，Hub 专项 7/7 通过。Windows 托盘 12 项通过；冷启动重复导入用例曾因两个启动进程争抢所有权而超时，补上控制查询等待后该项重跑通过。首次隔离运行暴露的 `.temp` 父目录缺失也已修正。没有把初次失败记录成通过。

修复源码编译的原生下载器再次从正式 HTTPS Hub 下载并在独立目录导入 47 本题库，未使用临时 TLS 配置或额外目标框架注入。

已生成 `quizforge_web/dist/QuizForge-0.1.0-next.2-tlsfix.1-win-x64-setup.exe`，25,172,306 字节，SHA-256 为 `423fd058ff8abe686969911eefbe56404fdcbd26c1f2aa4d8423882e534e2776`；安装包内 RELEASE.json 记录上述 Web 修复提交和启动器摘要。用户需先保存作答、退出托盘，再覆盖升级；尚未替用户更新正在使用的安装版。

已对该安装包同一 payload 执行隔离安装器验收并通过：安装、真实文件导入、运行时升级拦截、覆盖升级保留题库/设置/答案/冻结历史、卸载保留数据、协议冲突与清理边界。使用独立 AppId 和测试 scheme，没有修改用户正式 `.qbank` 或 `quizforge` 注册项。报告位于任务根目录 `.temp/web-hub-tls-fix/.temp/installer-acceptance-box0iN/report.json`。

## 当前交付边界

Hub 新按钮已经上线；用户刷新详情页后可见“下载到本地”和“下载 .qbank 文件”。安装修正版之前，旧客户端的 HTTPS 下载仍可能失败，文件下载与本地导入继续可用。

针对用户继续询问如何修复，本会话已将这一处兼容补丁与回归检查在独立 Web 分支完成并打包，未改其他会话的 checkout。主线合并与后续正式发布仍需按既有协作流程处理。浏览器工具仍报告被 Work 设置禁用，不能把 HTTP 与隔离原生验证当作真实浏览器/系统唤醒验收。
