# Windows 使用说明

这个文件夹里放着**你要动手操作的全部东西**，一共三样：

| 文件 / 文件夹 | 是什么 | 你需要做什么 |
|---------------|--------|--------------|
| `start-watchdog.vbs` | 开机启动器（双击它 = 开后台看门狗，不会弹黑窗） | 给它建**快捷方式**放进启动文件夹 |
| `plugin\` | 浏览器扩展 | 加载到浏览器里（一次性） |
| `README.md` | 你正在看的这份说明 | — |

> 上一级目录还有一个 `watchdog.py`（后台判断掉线的程序）和 `config.json`（配置）。**这两个不用你碰**，启动器会自动找到它们。

---

## 第一步：让看门狗开机自动运行

1. 在 `start-watchdog.vbs` 上**右键 → 显示更多选项 → 创建快捷方式**。
   （Windows 11 需要点「显示更多选项」才能看到"创建快捷方式"；Windows 10 直接就有。）
2. 按 `Win + R`，输入 `shell:startup`，回车 —— 会打开"启动"文件夹。
3. 把刚建好的**快捷方式**拖进这个"启动"文件夹。完成。

> ### ⚠️ 千万不要把 `start-watchdog.vbs` 本身复制过去
>
> 启动器是按**自己所在的文件夹**去找上一级的 `watchdog.py` 的。单独复制到启动文件夹后，它就找不到脚本，会**直接退出、不报任何错**——表现就是"双击了但什么都没发生"。
>
> 用**快捷方式**就没这个问题：Windows 会把快捷方式解析回项目里的真实位置。

> ### 也别把项目文件夹挪走或删掉
>
> 快捷方式指向的是这个项目文件夹，把它挪走快捷方式就失效了。想换位置，请先把快捷方式删掉，挪完再重建一个。

**想立刻测试**：直接双击项目里的 `start-watchdog.vbs`，然后浏览器打开 <http://127.0.0.1:5180/status>，能看到一段 JSON 就说明跑起来了。

---

## 第二步：把浏览器扩展装上（只需做一次）

1. 打开浏览器，地址栏输入 `chrome://extensions` 回车。
   （Edge 用 `edge://extensions`，国产 Chromium 内核浏览器一般是 `chrome://extensions`。）
2. 打开右上角的**「开发者模式」**开关。
3. 点左上角**「加载已解压的扩展程序」**。
4. 选中**本文件夹里的 `plugin` 文件夹**，确定。

装好后列表里会出现「北交校园网自动登录助手」。

> ⚠️ 加载时选的是 **`plugin` 文件夹本身**，不是里面某个 `.js` 文件。

---

## 用起来是什么样

- **开机**：看门狗自动跑起来，插件读状态；如果没登录，会自动开登录页、等浏览器填好密码、点「登录」。
- **用着用着掉线**：看门狗发现掉线（约 30 秒判定一次）并替你打开登录页，插件随后自动点「登录」。你不用管。
- **不在校园网**（比如挂手机热点）：看门狗直接休眠，不检测、不弹窗、不误报。

> 登录页是**看门狗**用系统方式打开的（等价于你双击桌面上的登录页快捷方式），不是插件自己开新标签——这样浏览器里只会多出你想看到的那一枚页面。这一步在 `config.json` 里可以用 `auto_open_login_page` 关掉。

---

## 怎么确认它在正常工作

| 检查什么 | 怎么看 |
|----------|--------|
| 看门狗活着吗 | 浏览器打开 <http://127.0.0.1:5180/status>，有 JSON 即正常 |
| 插件读到状态了吗 | `chrome://extensions` → 本扩展 → 点「Service Worker」→ 控制台有 `[BJTU-bg] status {...}` |
| 完整记录（推荐） | `Win + R` 输入 `%TEMP%`，打开 `bjtu-net-autologin.log`。带 `[plugin]` 前缀的行是浏览器扩展写的，**这才是能事后回看的那份**——扩展的后台控制台一休眠就清空了 |

---

## 不想要了怎么关掉

1. 打开 `Win + R` → `shell:startup`，删掉里面的**快捷方式**；
2. 打开 `chrome://extensions`，移除本扩展；
3. 任务管理器里结束带 `watchdog.py` 参数的 `pythonw.exe`（不结束它的话这次开机内还会继续跑）。

项目文件夹可以直接留着，删掉也不影响系统。

---

## 常见问题

| 现象 | 原因 / 怎么办 |
|------|----------------|
| 双击启动器毫无反应 | 多半是它被复制出了项目目录，重新用**快捷方式**的方式做一遍 |
| 插件控制台提示 `watchdog status unavailable` | 看门狗没在跑，双击 `windows\start-watchdog.vbs` 或重启电脑 |
| 打开了登录页但不点「登录」 | 日志里搜 `[plugin] cs:`：`form never appeared` = 登录表单没渲染出来（页面迟迟拿不到密码框）；`login button NOT FOUND` = 按钮没认出来，把后面 `candidates: [...]` 一并附在 Issue 里；`still in the background after 6000ms -> not clicking` = 这次加载一直待在后台标签里，插件**故意不点**（后台加载等不到自动填充，点下去只会白记一次失败登录），把该标签切到前台即可；`autofill not ready after 5000ms -> NOT clicking` = 浏览器**始终没自动填充**，插件选择刷新而不空点（根因是浏览器没保存该站点密码） |
| 页面弹「请输入账号！」但框里明明有账号 | 当前版本**不再出现**：这句是门户 `checkForm()` 在 `input[name=DDDDD]` 为空时弹的，插件现已改为"填充后才点"。若在老版本看到，那是**过期的提示**（点击那一刻框还空着，浏览器随后才填上），同一 `[Lxxxx]` 的日志行能还原先后顺序 |
| 日志里 `login tabs found: N - keeping the newest (id ...), closing N-1 stale one(s)` | 浏览器里同时开着多枚登录页，插件只留最新的一枚、关掉其余（多枚并存时每个都在跑自己的刷新回路，只会空转刷屏）。正常工作，无需处理 |
| 日志里 `still in the background after 6000ms -> not clicking` / `no login yet, but the tab is in the background -> no refresh` | 后台标签里插件不点击、也不刷新。这是有意的：全日志里没有一次后台加载被自动填充过，点击只会换来网关的「请输入账号」和一次失败登录。把标签切到前台，插件会从那一刻重新起算 3 秒再点 |
| 点了「注销」后一直不自动登录 | 先看 `/status` 的 `need_login` 是否为 `true`：是 → 往下游查，日志里看门狗应有 `opened login page in the default browser`、插件应有 `trigger login` / `focused window` / `sent ENSURE_LOGIN`；始终 `false` → 是判定问题，附上 `reason` 原文 |
| 刚改过扩展的源码，行为没变化 | 扩展必须**重新加载**才生效：`chrome://extensions` → 本扩展 → 点「重新加载」（↻） |
| 没看到日志里 `autofill ready -> clicking 登录` | 浏览器没自动填密码（或填得太晚）：确认已保存北交校园网的账号密码（手动双击登录页快捷方式能自动填上就说明有）。内容脚本持有"等填充 → 点击 → 1 秒查状态 → 没登录就刷新"的回路，最多 6 次；每次刷新都是一次新的加载，最可能被填充的就是 reload 这次。那行还会带 `anchor_delay_ms`：大于 0 说明这次加载先待在后台、被提到前台后才起算 3 秒 |
| 日志里没有 `kept it in front` 也没有 `no login yet -> refresh & retry n / 6` | 跑的是**旧版脚本**。`content.js` 每次页面加载都从磁盘重读，`background.js` 却要手动重载才会换，所以会出现"新内容脚本 + 旧后台"的混合态。按 `chrome://extensions` 点「重新加载」（↻）即可。重载后日志里应能看到内容脚本的 `no login yet -> refresh & retry n / 6` 与后台的 `kept it in front` |
| 掉线时浏览器没自动弹出登录页 | `/status` 看 `auto_open_count` / `last_auto_open` 有没有涨；日志搜 `opened login page` 或 `auto-open failed` |
| 掉线时反复弹登录页标签 | 把 `config.json` 的 `login_open_interval_sec` 调大（默认 180 秒）；每次掉线最多开 3 次（`login_open_max_per_outage`），到上限后不再弹 |
| 明明没登录，却显示"在线"、于是不点登录 | 请确认用的是最新版本（新版会嗅探网页内容，不会被"回你一个登录页"的假在线骗过） |
| 老是误判掉线 | 把 `config.json` 里的 `poll_interval_sec` 调大（比如 60），或调大 `unknown_streak_limit` |
| 登录页打开了、也点了「登录」，但联不上网 | 登录链接里的设备号（MAC）选错了网卡。先看日志里 `mac picked` 那行；用 `getmac /v` 找到你上网那张网卡的 MAC，填进 `config.json` 的 `usermac` |
| 提示"缺少语句"（`800A0400`） | 启动器被编辑器改乱编码了，重新从仓库下载一份纯 ASCII 的原文件 |
