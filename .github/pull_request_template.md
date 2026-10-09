## 改动说明

<!-- 这个 PR 做了什么？为什么这么做？ -->

## 关联 Issue

<!-- 如 Closes #123，无则写"无" -->

## 改动类型

- [ ] 新功能（feat）
- [ ] 缺陷修复（fix）
- [ ] 文档（docs）
- [ ] 重构（refactor）

## 如何验证

<!-- 说明验证步骤或命令，便于评审者复现 -->

## 自查清单

- [ ] `python -m py_compile watchdog.py` 通过
- [ ] `node --check windows/plugin/background.js`、`node --check windows/plugin/content.js` 通过
- [ ] `config.json` 与 `windows/plugin/manifest.json` 为合法 JSON
- [ ] `windows/start-watchdog.vbs` 仍为纯 ASCII（非 ASCII 会触发 VBScript `800A0400`）
- [ ] 未提交任何个人敏感信息（自己的 IP / MAC / 登录链接 / 本机路径）
- [ ] 提交信息符合 Conventional Commits
- [ ] 已阅读并同意遵守贡献指南与行为准则
