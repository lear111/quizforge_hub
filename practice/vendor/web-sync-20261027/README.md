# 固定 Web 覆盖

此目录保存 `practice/vendor/locks/web-workspace-20261027.json` 声明的 27 份工作区原始文件。基线为 Web `4522bb81c2126a699fcf72ce61d074dbc1264161`；保留原换行与逐文件 SHA-256，不能直接编辑覆盖文件后沿用旧清单。

构建通过 `scripts/stage-web-workspace.mjs` 从该提交重建原件，再核对基线摘要、应用冻结覆盖、验证全部运行输入。Linux 和 Windows 分别使用匹配平台依赖。说明见 `docs/WEB_WORKSPACE_SYNC.md`。
