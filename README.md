# campus-net-autologin

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/myxahz/campus-net-autologin/actions/workflows/ci.yml/badge.svg)](https://github.com/myxahz/campus-net-autologin/actions/workflows/ci.yml)

> 北交校园网自动登录 + 掉线自动重连。用**浏览器插件 + 本机看门狗**的方案，复用你浏览器里已保存的密码自动点「登录」，掉线后自己重新连上。**脚本与插件都不接触你的明文密码。**

**仓库名说明**：仓库地址是 `campus-net-autologin`（一个偏通用的名字），但**本项目只做北京交通大学的适配**，不打算支持其它学校，也不接受「适配 XX 学校」的改动。仓库名保持通用只是沿用最初的命名，不代表适用范围——适用范围以下面这行为准。

适用范围：**仅北京交通大学校园网**（`login.bjtu.edu.cn`），**仅 Windows 10 / 11**。本项目不做其它学校的适配，也不提供 Linux / macOS 版本。

## 为什么用插件而不是脚本直发请求

常见的校园网自动登录脚本都靠**自己拼 HTTP 请求**登录，因此必须把账号密码写在脚本或配置文件里。本项目换了个思路：

- **登录动作交给浏览器插件**——用你浏览器已保存的密码自动填充，再点「登录」。密码永远只存在于浏览器的密码管理器里。
- **判断掉线交给本机看门狗**——一个常驻后台的 Python 小程序，只负责探测"现在还在不在登录态"。
- 两者通过本机回环地址（`127.0.0.1`）通信，互不越权。

好处：不需要在代码或配置里存密码，也不用把密码交给任何第三方。

## 工作原理

```
开机
 ├─ windows\start-watchdog.vbs（无黑窗启动器）──→ pythonw watchdog.py（后台常驻）
 │        ├─ 在校园网吗？本机 IP 是否落在 campus_subnet 内      → 否：休眠，不干预
 │        ├─ 掉线了吗？探测外网信标：被劫持（回登录页 / 204 哨兵被改写）= 掉线
 │        ├─ 掉线时用 os.startfile() 打开登录页（＝双击桌面快捷方式那种打开方式）
 │        └─ 结果发布到 http://127.0.0.1:5180/status
 └─ 浏览器插件（windows\plugin\）
          background.js 定时读 /status → 若 need_login 为真
               → 上报"浏览器里有几枚登录页"到 POST /tabs（看门狗据此不再叠开）
               → 只留最新的一枚登录页，多余的关掉（避免多个刷新回路互相空转）
               → 把登录页所在窗口 + 标签页提到最前
          content.js 持有"点击 / 刷新重试"回路：
               开页 → 等到"页面来到前台"后 +3 秒（最早点击时刻）
               → 再等浏览器把账号框与密码框都填上 → 点一次「登录」
               → 1 秒后查登录状态 → 没登录就刷新，回到起点重来（最多 MAX_RELOAD 次）
               ↓ **填充后才点击**：门户 checkForm() 会读 input[name=DDDDD]，
                 为空即弹「请输入账号！」并原地返回（一个字节都不发给后端）；
                 所以空框点击必然失败、还会被记一次失败登录。等满 FILL_GRACE_MS
                 （5 秒）仍未填充，就只刷新、不点击。
               ↓ "第 3 秒"从**页面来到前台**那一刻起算；一直待在后台的页面
                 既不点击也不刷新（后台加载从未被填充过），等它被提到前台再走一遍
```

三个部件职责清晰：**看门狗负责判断与把登录页放进浏览器，插件负责"让那次加载发生在前台"并点击，谁都不碰密码。**
`POST /tabs` 是唯一的反向通道：只有浏览器看得见标签页，看门狗靠它避免把登录页开成一排。

### 自动填充：已知的与未知的（2026-10-01 两度修正后重写）

**已经确证的：**

- 密码永远只由浏览器自己填，本工具不读也不写密码。**等到账号框与密码框都已被填充后才点「登录」**（2026-10-10 修正：旧版第 3 秒无条件点击，空框一击会被门户 `checkForm()` 判为空账号、弹「请输入账号！」并原地返回——既登录不了，又在网关记一次失败登录）。
- 一次页面加载要么在 **1–5 秒内被填充，要么这次加载就永远不会填**——是"这一次加载"的性质，不是"再等等就有了"。
- **在前台重新导航该标签页，确实能产生一次被填充的加载**：两次成功登录（12:52:33、13:09:29）都紧跟一次这样的重载，随后点击一次通过。

**尚未确认的（曾两次写错，现如实标注）：**

- ❌ "扩展打开的页面一律不填、只有系统 shell 打开才填"——被否证：12:25:05 那次是**扩展自己**导航的，自动填充立刻就来了。
- ❌ "在后台标签页里加载完的页面不会被填"——作为**绝对说法**不成立：13:07–13:09 那轮**每一次失败**都是 `hidden_at_load=false | visible=visible | focused=true`，而且失败页面的表单结构与成功时**逐字节相同**。（也就是说"前台"不是充分条件；见下面的补充。）
- 所以真正的判据是**某次加载身上的某个性质**。现在每一次页面加载都会带一个 id（`[Lxxxx]`），启动行会报 `nav=reload|navigate`、`referrer` 和一段密码框审计（有几个密码框、选中了哪个、是否可见）。

**补充证据（2026-10-01 16:40–16:42，另一侧的数据）：**

- 16:40:34 看门狗放进浏览器的那枚页面**在前台加载**（`nav=navigate`、`hidden_at_load=false`），3 秒内即被填充 → 点击 → 16:40:40 `logged in -> done`，**一次通过、零重试**。
- 16:41 再次掉线时浏览器里同时开着 **4 枚登录页**。此后 70 秒内共 **45 次加载，点击时刻没有一次被填充**（全部 `autofill ready: false`），两枚标签页刷满 6 次后放弃；这些加载大多显示 `hidden_at_load=true`。
- 全日志统计：**12 次"点击时已填好"的加载全部是前台加载**，没有一次后台加载被填充过。

所以现在的说法是：可见性**不是充分条件，但看着像必要条件**（这只是从日志里数出来的相关性，不是机制结论）。据此，内容脚本把 3 秒计时锚在"页面来到前台"，并且不再点击/刷新一直待在后台的页面；扩展则只保留一枚登录页。

**第一条可分的线索（2026-10-01 13:24–13:27，n=1，是假设不是结论）：**

归因数据到手后，同一个标签页、同一个 URL 的 **8 次加载**第一次被区分开了：

| 加载 | `nav.type` | 启动行的密码框审计 | 是否被填充 |
|---|---|---|---|
| 7 次 | `navigate` | `pwdfields=1 visible_idx=[0] picked#0 picked_visible=true picked_name=upass picked_autocomplete=off` | ❌ 全部不填 |
| **1 次** | **`reload`** | **与上面逐字节相同** | ✅ 3 秒内填充，点击一次通过 |

可见性、谁发起导航、referrer、表单结构、`autocomplete=off` 全部相同——**唯一不同的是 `nav.type`**。成功后侧只有 1 个样本，所以这只是假设；但它便宜可测，而且 `reload` 本身就是更安全的动作（不会把标签页上已经带着的新 `userip` 导航掉），因此自动重试现在**优先整页 `reload`**，只有标签页的 `userip` 真的过期（换了 DHCP 地址）才改用真正的导航。

所以现在的分工是：**看门狗**在掉线时用 `os.startfile` 把登录页放进浏览器（也负责在没有登录页时凭空造一枚）；**扩展**先 `chrome.windows.update({focused:true})` + `tabs.update({active:true})` 把窗口和标签提到最前，再加载，并保证**同时只有一枚登录页**（多余的关掉：4 枚并存时每个都在跑自己的刷新回路，而后台加载永远等不到填充，只会刷出一屏「请输入账号」）；**内容脚本自己持有"点击 / 刷新重试"回路**（开页 → 第 3 秒点「登录」一次 → 1 秒后查登录状态 → 没登录就刷新 → 刷新后第 3 秒再点，上限 `MAX_RELOAD=6`），其中"第 3 秒"从**页面来到前台**起算，一直没被提到前台的页面既不点击也不刷新。后台只把窗口提到最前、不再自行 `reload`，以免和内容脚本的刷新抢跑；刷新走的正是 `reload`（那次最可能被填充的加载），所以回路形状本身就对。

顺带的好处：`os.startfile` 而非 `cmd /c start`，绕开了 `cmd` 会把 URL 里的 `%2d`、`%2e` 当环境变量展开的坑。

## 特性

- 复用浏览器已保存的密码，代码里不存明文
- 掉线自动重连：不需要手动再点一次
- **动态 IP 自动重建登录链接**：校园网 IP 随 DHCP 变化时不会失效
- 开机自启，无黑窗
- 探测请求**绕过系统代理**，避免被本机代理干扰导致误判
- 三态判定（在线 / 掉线 / 不确定）：**不只看状态码**，还嗅探响应内容并校验 204 哨兵点，因此"连上校园网但没登录"不会被误判成在线；拿不准时保留上一次状态，连续拿不准才按掉线处理
- 只监听 `127.0.0.1` 本机回环，不对局域网暴露
- 登录页由看门狗用 `os.startfile()` 打开（等价于双击快捷方式）；插件不自己开页，只负责把窗口提到最前、必要时重载该页，并点「登录」
- 第 3 秒**无条件点击**「登录」：即用户要求的字面"无脑点击"，点击时刻密码框仍为空也照点（空密码会被网关记一次失败登录，但用户接受）
- 3 秒计时锚在**"页面来到前台"**那一刻；一直待在后台标签里的加载既不点击也不刷新（后台加载从未被观察到最后被填充，点了只会白记一次失败登录），等它被切到前台再走一遍
- 同时只保留**一枚**登录页：掉线时多余的直接关掉，避免几枚页面并排跑各自的刷新回路、互相空转

## 环境要求

- **Windows 10 / 11**（本项目仅支持 Windows）
- Python 3.8+（需要 `pythonw.exe`，官方安装包默认自带）
- 基于 Chromium 的浏览器（Chrome / Edge / 其它 Chromium 内核浏览器）
- 已在浏览器中保存好北交校园网的账号密码（这样才会自动填充）

## 目录结构

```
campus-net-autologin/
├─ README.md  LICENSE  .gitignore  .gitattributes  .editorconfig
├─ config.json          看门狗配置——要改就改这个
├─ watchdog.py          本机看门狗（Python）
├─ windows/             Windows 专属（你要操作的东西全在这里）
│  ├─ README.md            安装与使用说明（先看这个）
│  ├─ start-watchdog.vbs   开机启动器（无黑窗）
│  └─ plugin/              浏览器扩展——加载的就是这个文件夹
└─ .github/             Issue / PR 模板与 CI
```

## 快速开始

见 **[windows/README.md](windows/README.md)**。

一句话版本：给 `windows\start-watchdog.vbs` **建个快捷方式**放进启动文件夹；再把 `windows\plugin` 文件夹加载进浏览器。

## 配置

全部配置在 `config.json`：

| 字段 | 说明 |
|------|------|
| `host` | 校园网登录页域名，用于判定"被跳回登录页 = 掉线" |
| `login_url_template` | 登录链接模板，`{userip}` / `{usermac}` / `{nas_ip_encoded}` 会被自动填充 |
| `login_url_static` | 备用固定链接（留空即可，不推荐写死） |
| `usermac` | 设备 MAC，**留空则自动探测**：优先选「已连接的物理网卡」，自动排除蓝牙 / Wi-Fi Direct / VPN 等虚拟网卡（推荐留空）；若自动选错，用 `getmac /v` 查出你上网那张网卡的 MAC 填进来 |
| `nas_ip_encoded` | 认证设备参数 |
| `campus_subnet` | 校园网网段，本机 IP 落在此范围内才启用检测 |
| `probe_urls` | 探测用的外网地址。每项可写成 `{"url": "...", "expect_204": true}`，其中 `expect_204` 表示"这个点必须回一个真正的空 204"，是最硬的在线证据 |
| `hijack_keywords` | 出现即判定"被网关劫持 = 掉线"的关键词（默认是北交登录页特征） |
| `unknown_streak_limit` | 连续几次"拿不准"后按掉线处理，默认 3 |
| `poll_interval_sec` | 探测间隔（秒），默认 30 |
| `auto_open_login_page` | 掉线时是否由看门狗自动打开登录页，默认 `true`（关掉后只由插件点击，不主动开页） |
| `login_open_interval_sec` | 掉线期间两次自动开页的最小间隔（秒），默认 180，下限 30；一旦恢复联网立刻归零 |
| `login_open_max_per_outage` | 一次掉线期间最多自动开几次登录页，默认 3（防止长时间断网把浏览器塞满标签页），恢复联网后重置 |
| `login_tabs_ttl_sec` | 插件上报的「浏览器里还有几个登录页」这个事实的保鲜期（秒），默认 300，下限 60。在这段时间内看门狗不会再叠开新页；超时视作插件已停摆，恢复自动开页 |
| `local_port` | 状态接口端口，默认 5180（**若改动，须同步改 `windows/plugin/background.js` 里的 `STATUS_URL`**） |

### 北交登录页或校园网网段变了怎么办

1. 改 `config.json` 的 `host`、`login_url_template`、`campus_subnet`、`nas_ip_encoded`；
2. 改 `windows/plugin/manifest.json` 里 `host_permissions` 与 `content_scripts.matches` 的域名；
3. 改 `windows/plugin/background.js` 里的 `LOGIN_HOST`。

## 验证

- 看门狗是否在跑：浏览器打开 <http://127.0.0.1:5180/status>，应返回一段 JSON。
- 插件是否读到状态：`chrome://extensions` → 本扩展 → 点「Service Worker」→ 控制台应出现 `[BJTU-bg] status {...}`。
- 插件到底做了什么：插件会把日志 `POST` 到 `http://127.0.0.1:5180/log`，看门狗落地成带 `[plugin]` 前缀的行（服务线程的控制台一休眠就清空，文件日志才是可回溯的那份）。见下方「日志文件」。
- 真测重连：先正常联网，再打开校园网注销页点「注销」模拟掉线，约 1 分钟内应自动重新登录。
- 开机场景：重启后看门狗自动接管，配合插件自动点登录。

## 排错

| 现象 | 排查 |
|------|------|
| 插件控制台提示 `watchdog status unavailable` | 看门狗没在跑，双击 `windows\start-watchdog.vbs` 或重启 |
| 打开登录页但不点「登录」 | 打开日志文件搜 `[plugin] cs:`，看它停在哪一步：`form never appeared` 表示登录表单没渲染出来；`login button NOT FOUND` 表示按钮没被识别（附该按钮的 HTML 提 Issue）；`still in the background after 6000ms -> not clicking` 表示这次加载一直待在后台（切到前台即可）；`autofill not ready after 5000ms -> NOT clicking` 表示浏览器始终没自动填充，插件选择刷新而不空点——根因是**浏览器没保存该站点密码**，不是插件不点 |
| 没看到日志里 `autofill ready -> clicking 登录` | 浏览器没有自动填充（或填得太晚）。先确认浏览器里确实保存了该站点账号密码（手动双击登录页快捷方式能自动填上就说明有），再看开页方式：只有"正常打开"的页面才会被填充，看门狗用 `os.startfile` 打开的正是这种——这正是本项目把开页交给看门狗的原因 |
| 掉线了但浏览器没自动弹出登录页 | 看 `/status` 里的 `auto_open_count` / `last_auto_open` 有没有在涨；再看日志里 `opened login page ...` 或 `auto-open failed`。若用户手动关了 `auto_open_login_page`，看门狗当然不会开页。另外若 `/status` 的 `login_tabs` 是个新鲜的正数，说明浏览器里已经有一枚登录页了，看门狗**故意不再开**（日志记 `auto-open skipped`） |
| 掉线时反复弹登录页标签 | `login_open_interval_sec` 调大（默认 180 秒；恢复联网会立刻重置）；`login_open_max_per_outage` 调小（默认每次掉线最多开 3 次，到上限后日志记 `auto-open paused`）。插件运行正常时看门狗会自动让路（日志记 `auto-open skipped: the browser already has N login tab(s)`），无需手改配置 |
| 明明没登录却显示"在线"、于是不点登录 | 这是旧版缺陷：只看网址判定，会被"HTTP 200 + 登录页 HTML"这种不改网址的劫持骗过。请确认用的是当前版本（会嗅探响应内容 + 校验 204 哨兵）。仍能复现，请附日志里 `reason` 那行的原始响应 |
| 点了「注销」后一直不自动登录 | 先看 `/status`：若 `need_login` 已是 `true`，判定没问题，问题在下游，搜日志里 `[plugin] bg:` 看它有没有 `trigger login` / `focused window` / `sent ENSURE_LOGIN` / `kept it in front (content script owns the refresh/retry loop)`（看门狗那一侧还应有 `opened login page in the default browser`）。若 `need_login` 始终为 `false`，才是判定问题 |
| 一直看到 `no login yet -> refresh & retry n / 6`，最后 `gave up after 6 refreshes` | 每次点击后 1 秒仍没登录。分两种：日志是 `autofill not ready ... -> NOT clicking` 说明浏览器**根本没自动填充**（先确认浏览器为 `login.bjtu.edu.cn` 保存过密码）；是 `autofill ready -> clicking 登录` 却仍失败，说明填了但登录没过（多半密码错误）。`anchor_delay_ms` 大于 0 表示这次加载先待在后台、被提到前台后才起算 3 秒。最多 6 次后记 `gave up after 6 refreshes`，此时请手动点一次确认 |
| 日志里 `still in the background after 6000ms -> not clicking` | 这次加载一直待在后台标签里，插件故意不点、也不刷新：后台加载从未被观察到最后被填充，点下去只会换来网关的「请输入账号」和一次失败登录记录。把该标签切到前台即可，插件会在你切过去的瞬间重新起算 3 秒并点击 |
| 日志里 `login tabs found: N - keeping the newest (id ...), closing N-1 stale one(s)` | 浏览器里同时开着多枚登录页，插件只留最新的一枚、关掉其余（多枚并存时每个都在跑自己的刷新回路，而后台加载等不到填充，只会空转刷屏）。属正常清理，无需处理 |
| 页面弹「请输入账号！」但框里明明有账号 | 当前版本**不再出现**：这句正是门户 `a40.js` 的 `checkForm()` 在 `input[name=DDDDD]` 为空时弹的，所以插件现已改为"填充后才点"（旧版第 3 秒无条件点击时会撞上）。若在老版本看到它，那是**过期的提示**——点击那一刻框还空着，浏览器随后才填上，提示框不会自己消失 |
| 日志里出现 `[Lxxxx]` 这样的前缀 | 这是**这一次页面加载**的 id。把同一次加载的所有行串起来看，才能回答"哪一次加载被填充了"——这正是排查自动填充问题唯一有效的方法 |
| 想一次性拿到完整诊断 | 复现一次后把 `%TEMP%\bjtu-net-autologin.log` 发出来，重点看 `boot | nav=...`、`audit:`、`autofill ready -> clicking 登录` / `autofill not ready ... -> NOT clicking`、`no login yet -> refresh & retry n / 6` 这几类行 |
| 判定频繁误报 | 检查 `probe_urls` 是否在本网络下可访问；`poll_interval_sec` 可调大 |
| 登录页打开了、也点了「登录」，但就是联不上网 | 多半是登录链接里的 `usermac` 选错了网卡（笔记本常有蓝牙 / Wi-Fi Direct / VPN 虚拟网卡）。先看日志里 `mac picked ...` 那行选中的是哪张网卡；用 `getmac /v` 找到你实际上网那张网卡的 MAC，填进 `config.json` 的 `usermac` |
| 双击启动器后毫无反应 | 多半是启动器被复制出了项目目录，见 [windows/README.md](windows/README.md) 的说明 |
| 想强制重来 | 关掉看门狗进程，重启 `windows\start-watchdog.vbs` |

日志文件：`%TEMP%\bjtu-net-autologin.log`（`Win+R` 粘贴 `%TEMP%` 打开）。带 `[plugin]` 前缀的行来自浏览器扩展，没有前缀的来自看门狗本体；文件超过 4 MB 会在下次启动时改名为 `.log.1`。

## 卸载

1. 删掉启动文件夹里的那个快捷方式（不是项目里的启动器本体）；
2. 在 `chrome://extensions` 里移除本扩展；
3. 结束已在运行的 `pythonw.exe` 看门狗进程（任务管理器里找带 `watchdog.py` 参数的）。

## 免责声明

非官方项目，与北京交通大学无关，仅供在校同学自用。请遵守学校的网络使用规定。

## 许可证

[MIT](LICENSE)
