# Java 测试站题库详情补齐

2026-10-25，响应用户指出题库详情仍缺少原型内容。补齐页头／侧栏、真实包目录、单本／部分下载、评论及举报；这是第三阶段详情子模块，发布编辑、下架与审核管理尚未全部迁移。

## 运行

- 测试站：<https://quizforge-test.treenewbee.cloud/>，刷新后打开题库详情。
- 发布目录：`/opt/quizforge-hub-java-test/releases/20261025-pack-detail-e4af7fe`。
- JAR：39,433,820字节，SHA-256 `4ee1995ac65408c2dee33bb5f7d929c979fc44921572bd48db195d7adca37a14`。
- 55项实际源码／配置摘要，来源清单SHA-256 `781b7ec6abb42f6cb7f1fd1855645d99e29b035d7891ed62442034710bc45974`。基线e4af7fe及未提交改动明确记录，另记录9份测试入口／测试源码摘要。
- 使用既有升级脚本与部署锁，仅停止／升级Java测试服务；完整数据和unit备份在`/var/backups/quizforge-hub-java-test/before-20261025-pack-detail-e4af7fe/`。
- 当前Java PID1826279，active、0自动重启；验收后内存约142MiB，不作为容量压测结果。
- 原Node Hub1810627、练习1226941和Caddy12260保持；Caddy配置摘要仍为`288b5e39579f61074777e396f450cebbb0cead4666b25772db3bc7e03b4e6bd0`，正式站HTTPS200。

## 验证与数据

- 完整`Verify-Java-Hub.ps1`：Java34项、Node25项通过，0失败／跳过。见`.temp/java-migration-evidence-20261025/.temp-java-detail-final-verification.log`；新增详情HTTP10项和模板3项，既有账号／Cookie／设备、来源、文件及配额检查保持。
- 公网5份资源与源码摘要一致、`no-store`和模块MIME正常；能力接口明确新增目录、选择下载、评论和举报，发布／审核／练习内部接口仍列为pending。
- 更新前备份与启动后39张表、5个文件完整比较一致，6个既有账号身份与题库归属检查通过，临时会话全部清理。
- 实际英语包目录为47本，拓展示例未计入。一次匿名同源单本下载生成305,393字节包，SHA-256 `8e3f2d0414f28bad10010ffa3e74412d5e59a856d5fdf248d3d3a329bb3c06b7`。所选题库、资源和原拓展分组全部文件与源包逐字节相同；格式3清单正确使用`scope: bank`。
- 该下载按正常流程增加下载／流量计数；验收后其余原表及题库非计数字段保持一致，原文件保持，临时选择包清理。没有向真实题库写入测试评论／举报，没有调用真实发码或模型。
- 生成的公开单本包通过现有Web `LibraryArchive.importPackage`的结构与资源流程：1本、8个配套拓展、8张题卡；题库ID、题目ID、题目数据及大纲一致。使用资源注册回调，不运行规则JS；临时安装目录已清理，Web源码／原数据未改动。

发布目录保存`detail-validation.json`、`host-import-validation.json`、`deployment-receipt.json`、`validation-sources.json`及对应验收脚本；`acceptance-single.qbank`是已公开源包的测试导出，不含账号数据。本机证据位于`.temp/java-detail-deploy-20261025/`，未下载私有数据库。

## 限制与恢复

浏览器工具此前返回Work设置禁用，本次没有真实浏览器／手机视觉、点击或评分验收。HTTP、模板和导入结构结果不能替代这些验收。

云端练习导入、客户端一键导入、题库编辑与下架暂未开放；侧栏按当前能力显示。配套拓展暂整组保留，不做依赖裁剪。新增接口与边界见[详情说明](../../docs/JAVA_PACK_DETAILS.md)。

旧Java发布及完整数据备份保留。需要回退时先停止新写入并另存当前数据，按既有升级约定回退二进制／unit，不用旧备份覆盖后来产生的评论或其他记录。

未提交、推送、合并、发布安装包或修改正式站。独立Node练习服务及历史不变。
