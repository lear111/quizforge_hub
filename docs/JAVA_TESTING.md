# 当前验证入口与旧测试整理

`Verify-Java-Hub.ps1` 执行Java构建及全部Node测试，Node并发限制为4。开发需JDK21+、Maven及Node24；练习用例需经审阅、适合本机系统的固定Web快照。

```powershell
.\Verify-Java-Hub.ps1 -PracticeRuntime '<固定运行时目录>'
```

已有当前JAR且只改Node／测试时可 `-SkipBuild`。`npm test` 只执行Node侧，未设置 `HUB_JAVA_JAR` 会跳过Java联调，不能因此声称完整通过。外观DOM测试还需要 `QFH_TEST_UI_PACKAGE` 指向能解析jsdom的包；缺少时如实记为跳过。

## 旧实现删除后的覆盖

| 原测试对象 | 当前验证 |
| --- | --- |
| Node Hub账号、验证码／手机号、邀请码、设备 | Java AccountHttpTest、AccountCompatibilityTest，Node java-account-interop固定旧格式数据／标准scrypt及HMAC |
| Node Hub题库、上传、编辑删除、评论、举报、文件／预算 | Java CatalogRules、PackDetail、Publishing、LocalImport测试；25份固定JSON及3份交付样本、并发预算检查 |
| Node Hub管理、AI、邮件队列 | Java AdminHttp、AiHttp、ReviewNotifications；真实Java与Node审核／AES／身份／资源联调 |
| 维护脚本依赖旧模块 | Java HubMaintenance／InstallerMaintenance及实际CLI进程测试，包含同版本发布失败恢复 |
| 旧Hub页面、合成角色预览及公开预览 | 页面／入口已移除，旧专属用例退役；当前Java模板／静态资源和实际HTTP用例保留 |
| Node练习核心 | 基础作答队列、library、AI、vault、配额、工作区合并、冻结历史、默认题库、固定来源导入、SSO、手机号身份及联系方式读取测试保留 |

旧Node后端专属测试已经合并到Java验证，不再启动旧服务器或保留旧业务模块。源代码与用例数量减少不表示用旧测试数量计算当前通过率；按当前实际命令与日志记录。

`test/fixtures/` 只保存合成结构／响应。管理员向首次访问的手机号账号投递题库仍经实际Java资料接口和Node私有桥验证，确认不虚构邮箱、不改变账号归属。

自动验证使用临时数据库、随机回环端口和合成模型；结束停止所创建的服务。真实浏览器／手机、验证码供应商、模型费用、生产数据和容量／回退仍需另行验收，不能用HTTP／DOM模拟代替。
