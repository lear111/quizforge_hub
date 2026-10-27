# 基础拓展目录平铺

2026-10-14，将四个基础拓展从 `extensions/基础题型/` 移到 `extensions/` 根目录：

```text
extensions/
  single-choice-richtext/
  short-answer-richtext/
  multiple-choice-richtext/
  true-false-richtext/
  README.md
```

“基础题型”在拓展列表中保留为逻辑分组，成员路径写入 `.state/extension-groups.json`。旧物理分组已从工作目录移出，说明文件可在 `.temp/basic-types-flat-layout-20261014/retired-physical-group/` 恢复。题库分组仍按现行文档保留 `question-banks/基础题型/.group.json` 和物理目录；考研英语拓展的目录本次不迁移。

已同步展示库的 10 处拓展路径、工作区 README 和技能中的基础题型引用。四个拓展的 ID、版本及 48 个文件内容保持不变，包括样例、规则、Schema、页面、编辑器和资源。题库 ID、版本、正文、大纲和功能开关保持不变。题目及小题指纹、集合状态键和当前练习状态一致，冻结历史不重写。

迁移前停机并备份整个产品数据目录（排除 `.git` 和备份所在 `.temp`），6,959 个文件、212,674,773 字节逐文件 SHA-256 校验通过。备份、迁移清单和校验记录位于 `.temp/basic-types-flat-layout-20261014/`。

验证：展示库完整 validator 无错误或警告，仍为 10 题、38 分；23 次隔离宿主 HTTP 请求通过，覆盖四个样例、逻辑分类、题库及编辑器、旧历史、图片、现有格式 2 包重新导入、保存作答和考试交卷。隔离测试未调用外部 AI。实际目录迁移后再次对比指纹和已保存状态通过，服务恢复到 `http://127.0.0.1:8787/`。

实际目录审计通过：5,748 个原有文件保持一致（移动文件按新路径比较），58 份个人练习/历史状态文件及 816 个考试、AI 任务、编辑草稿等附属文件保持一致；全部 `core` 文件保持一致。服务恢复后，两个展示库与四个拓展示例均可读取。

## 待处理问题

1. 按用户要求，本次不修改 `core` 测试。`core/test/development/basic-type-references.test.mjs` 和 `core/test/extensions/bank-builder-validator.test.mjs` 仍使用旧物理分组路径，迁移后相关检查不能定位基础拓展。选择第一份文件中的一个测试实际复测，结果为 1 个失败，错误 `ENOENT` 指向已移出的 `extensions/基础题型/single-choice-richtext/manifest.json`；记录为 `.temp/basic-types-flat-layout-20261014/core-test-path-check.log`。仅修改两处路径的建议补丁保存在 `.temp/basic-types-flat-layout-20261014/core-test-paths.patch`，尚未应用。
2. 题库分组中另有 `basic-types-showcase-v2` 旧字符串 ID 的展示库副本，与 UUID 展示库显示同名。该分组因包含旧 ID 回退到包格式 1；格式 1 无法导出另一份展示库的 `{id,path}` 引用，报 `INVALID_REQUEST: Invalid version`。已在移动前的隔离副本与移动后的副本分别复现，属于本次平铺前已有问题。本次没有删除该副本或改其身份。此前交付的格式 2 `.qbank` 独立导入仍通过。
3. 规范说明仍混有旧目录示意：`skills/quizforge-bank-builder/references/extension-development.md` 的“分组与绑定”部分仍展示拓展物理分组；宿主文档明确要求包内拓展平铺，同时兼容旧本地目录。此次仅同步技能中的基础拓展引用路径，没有重写这些规则。后续需统一说明“新布局平铺”和“旧目录兼容”的适用范围，避免继续按旧示意新建物理分组。

Node 目录重命名被 Windows 拒绝后，使用 PowerShell 原生移动完成。包含删除空目录的组合命令被自动审批策略拒绝，工具未提供具体原因；改为归档旧目录，没有执行该删除命令。

## 2026-10-14｜宿主跟进结果

上述待处理项保留迁移当时的观察，当前跟进如下：

1. 两份 core 测试的基础拓展引用已改为 extensions/<拓展目录>，基础引用测试和两项制作校验器预览复测通过。
2. 修复兼容格式 1 导出不识别 {id,path} 的问题。混合旧字符串 ID 与 UUID 的分组仍使用兼容格式 1，但在暂存副本转换路径引用，源题库身份和内容不变；未删除同名旧副本。隔离复制当前分组后，2 本题库、4 个拓展导出再导入通过，原 bank.json 字节校验一致。
3. 技能入口和参考文档已统一拓展平铺、本地逻辑分组表与旧物理目录只兼容读取的边界；不再按旧示意新建物理分组。宿主包文档补充格式 1 和格式 2 的适用范围，技能结构校验通过。

验证记录：.temp/flat-layout-host-fixes.log（27/27）、.temp/flat-layout-validator-check.log（2/2）、.temp/flat-layout-actual-group-check.log。未修改题库 JSON、拓展代码、作答、历史或逻辑分组表；仅补充本说明。当前实际服务未重启，运行中的旧进程需重启后才加载宿主导出修复。
