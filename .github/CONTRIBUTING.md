# 贡献指南（Contributing）

感谢你愿意为本项目做贡献！提交之前请先阅读以下约定。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 如何贡献

### 报告 Bug

请在 Issues 中新建，使用 **Bug 报告** 模板，并尽量提供：

- 复现步骤（能稳定复现的最小步骤）
- 期望行为 vs 实际行为
- 运行环境（Windows 版本、Python 版本、浏览器与版本）
- 看门狗日志（`%TEMP%\bjtu-net-autologin.log`）或扩展控制台日志

### 提出新功能

使用 **功能建议** 模板。请说明使用场景与期望行为。

请注意本项目的支持范围：**仅北京交通大学校园网、仅 Windows**。其它学校或其它平台（Linux / macOS）的适配不属于本项目目标，这类 Issue 会被关闭。

### 提交代码

1. Fork 本仓库并 clone 到本地。
2. 从 `main` 切出新分支：`feat/简短描述`、`fix/简短描述`、`docs/简短描述`。
3. 完成改动，确保本地语法检查通过（见下）。
4. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
   ```
   feat: 状态接口新增 need_login 字段
   fix: 修复后台标签未切到前台导致不点击
   docs: 更新 Windows 安装步骤
   ```
5. 推送分支并创建 Pull Request，填写 PR 模板。

## 本地检查

```bash
python -m py_compile watchdog.py
node --check windows/plugin/background.js
node --check windows/plugin/content.js
python -c "import json; json.load(open('config.json',encoding='utf-8')); json.load(open('windows/plugin/manifest.json',encoding='utf-8'))"
```

## 提交前自检

- [ ] 代码能通过上面的检查
- [ ] 未提交任何个人敏感信息（自己的 IP / MAC / 登录链接 / 本机路径）
- [ ] 已同步更新 README 或 config 说明
- [ ] 提交信息符合规范

感谢你的贡献！
