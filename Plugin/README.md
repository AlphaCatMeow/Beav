# Beav Chrome 插件

这个目录提供 Beav 的工程化构建源码，用来把外部网页内容采集到 Beav 桌面端知识库和素材库。

## 当前支持

- 小红书笔记 / 文章详情页保存
- 小红书详情页操作区 DOM 注入按钮
- 全站右侧固定浮动采集面板
- 小红书信息流卡片 DOM 注入采集按钮
- 小红书博主页 DOM 注入博主采集 / 主页笔记采集按钮
- 小红书页面接口响应缓存，用于复用页面自身加载出来的笔记列表
- 小红书图片 / 视频素材下载
- 小红书评论快照采集
- 小红书博主主页笔记批量采集
- 小红书当前页 / 关键词搜索批量采集
- 小红书批量采集随机间隔控制
- 小红书后台统一任务队列和当前任务状态
- 通用采集运行时：页面内滚动追踪、可见节点判断、数量解析、展开按钮点击、基础验证页检测和采集 checkpoint
- 侧边栏执行日志：展示任务开始、保存成功、部分成功和失败原因
- 小红书采集任务历史和 JSON 导出
- 插件设置页：采集间隔、默认采集数量和更新检查配置
- 侧边栏和页面浮动面板平台识别：小红书、抖音、快手、Bilibili、TikTok、Reddit、X、Instagram
- YouTube 视频页 / Shorts 页
- 任意网页链接收藏
- 任意网页选中文字摘录（右键菜单）
- 自动检查插件更新
- AI 浏览器控制：tab/session、DOM snapshot、selector 查询、点击、输入、滚动、截图、CDP、下载状态、页面资产读取
- MCP / native host 控制面：`App AI -> Desktop Bridge -> Beav Native Host -> Chrome extension -> page`

## 加载方式

先构建扩展产物：

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/Plugin
pnpm install
pnpm build
pnpm verify
```

1. 打开 Chrome 或 Edge。
2. 进入扩展管理页：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择当前仓库里的 [Plugin/dist/extension](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/dist/extension) 目录。

源码在 [src](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/src) 目录。`dist/extension` 是构建产物，不要手改。

## AI / MCP 控制面

浏览器控制层是叠加能力，不替换现有结构化采集：

- 现有采集：`pageObserver.js`、`xhsBridge.js`、`captureRuntime.js` 保持 content script 常驻，用于小红书、多平台识别、右键保存和网页浮动面板。
- AI 控制：`browserControlContent.js` 只在 AI 调用浏览器工具时动态注入。
- native host：正式桌面端启动时会把 Chrome / Edge / Brave 的 Native Messaging manifest 对账到当前 Beav 可执行文件。浏览器启动同一签名应用的隐藏 Native Host 模式，Host 通过 Windows Named Pipe 或 Unix Domain Socket 连接 Desktop Bridge，不监听 TCP 端口。`native-host/host.mjs` 和 Node installer 只保留隔离的 legacy 传输测试。
- Knowledge / Accounts：插件的保存、查询和账号导入请求均通过 Native Messaging 交给 Desktop Bridge 的 typed allowlist；Host 不代理 HTTP，也不直接写本地业务数据。
- 自动诊断：普通连接状态变化、App 未启动、短暂重连、用户取消、页面不适用和策略拒绝只保留在本地有界遥测中，不创建反馈工单。原生连接错误持续至少 60 秒且至少观察到 3 次（间隔至少 10 秒）时，插件自动提交连接诊断；不同错误码属于同一未恢复事件，检测摘要和首次错误持久化，MV3 worker 重启可继续计数，恢复连接清除摘要。弹窗/设置中持续主动检查却无法连接 App 时也自动反馈；仅后台 App 未运行不报。初始化异常直接记录并上报。用户操作产生的非预期终态失败，或不可重试的协议、鉴权、数据完整性错误，也由插件直接提交到公开反馈接口；同一安装上的同一业务操作错误 24 小时最多提交一次，task/message 两层按同一语义合并。用于聚合的安装标识只在本地由随机实例 ID 派生为不可逆短哈希，原始 ID 不会上传。网络不可用时进入插件本地有界队列并自动重试，不依赖 Desktop Bridge。仅保留错误码、阶段、版本、浏览器、系统类别、最近 40 条脱敏连接事件和站点 origin 等定位元数据，不上传网页正文、Cookie、Token 或完整 URL。
- App 内置 MCP：桌面端启动时会自动注册 `Beav Browser Control` MCP server，stdio command 指向 Beav App 自身的隐藏兼容 `--redbox-browser-control-mcp` 模式，不要求用户手动导入 MCP 配置。
- App AI 首选入口：模型使用 `browser.connection.status/repair`、`browser.tabs.list`、`browser.tab.open/claim`、`browser.page.inspect/click/type`、`browser.tabs.finalize` 等单一职责 typed action。旧 `browser.control` 只做历史 session 兼容；MCP / Native Host 是后端适配层，不作为普通任务的模型调用面。
- Agent-side JS client：`scripts/browser-client.mjs` 提供 Codex 同款对象 facade；生产型调试使用 `DesktopBridgeBrowserTransport`，旧 `BrowserControlTransport` 只服务隔离的 legacy contract tests。
- 开发 MCP server：`mcp-server.mjs` 保留给插件目录独立调试，负责把 `tools/list` / `tools/call` 转发到当前 Desktop Bridge。

开发态安装 Node fallback native host：

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/Plugin
pnpm install:native-host -- --extension-id <chrome-extension-id> --node /absolute/path/to/node
```

正式安装包不需要这一步。桌面端每次启动都会按 `browser-control.identity.json` 中的官方扩展身份自动对账 Native Host manifest；不传 `--extension-id` 的开发安装器也会优先使用同一官方 ID，并可发现 Chrome / Edge / Brave 中的 unpacked extension。

App 安装包内置 MCP 配置由桌面端自动写入，不需要用户选择目录或手动配置。独立开发调试时可使用：

```json
{
  "command": "node",
  "args": ["/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/mcp-server.mjs"]
}
```

插件根目录也提供 [Plugin/.mcp.json](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/.mcp.json)，用于开发态本地发现或外部 MCP 客户端导入 `browser-control` server；正式 App 运行时优先使用内置 MCP。

调试连接：

```bash
pnpm diagnose:browser-control -- --no-fail
pnpm agent:call -- --method browser.info
pnpm agent:call -- --method tools/list
```

验收边界：

- “打开网页读取内容”不是浏览器控制验收；必须看到 Beav MCP / Native Host 经真实 Chrome 扩展返回 `tools/list`、`tabs.list`、`tab.info`、DOM 查询和至少一个交互动作。
- `pnpm smoke:browser-control` 使用临时 profile / Chromium 做回归，不代表用户真实 Chrome 可用。
- 真实 Chrome 验收必须使用已安装的 Beav 扩展、真实 Chrome Native Messaging manifest、真实 Desktop Bridge，以及真实标签页或受控测试标签页。
- 被 `tab.claim` / `tab.create` 纳入 active browser session 的页面必须显示 `Beav 控制中` 页面内标签；释放、finalize 或 turn 结束后自动移除。
- 不要为 smoke 或调试授权 macOS login keychain / Chrome Safe Storage；如果弹出此类提示，应拒绝并改用隔离 profile。

## 开发命令

```bash
pnpm build
pnpm verify
pnpm check
pnpm install:native-host -- --extension-id <chrome-extension-id>
pnpm diagnose:browser-control
pnpm smoke:browser-control
pnpm mcp:server
pnpm package
```

- `pnpm build`：把 `src` 里的 manifest、HTML、CSS、图片和脚本构建到 `dist/extension`。
- `pnpm verify`：检查 manifest、HTML 引用、动态注入脚本和关键 content script 合同。
- `scripts/browser-client.mjs`：供 agent / 调试脚本按 Codex Browser Use 对象 API 使用 Beav browser-control；配套文档在 [Plugin/docs/browser-runtime.md](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/docs/browser-runtime.md)。
- `pnpm install:native-host`：安装 Chrome native messaging host manifest。
- `pnpm diagnose:browser-control`：检查 Native Host manifest、Desktop Bridge descriptor、鉴权握手和 extension forwarding 状态；需要只取报告时加 `-- --no-fail`。
- `pnpm smoke:browser-control`：在当前运行的 Desktop Bridge 上，用临时 Chrome profile 加载构建后的扩展并临时安装 Native Host manifest，验证握手、tools/list、tab 创建、DOM 读取和 finalize；Host 版本必须与运行中的 App 版本一致。
- `pnpm mcp:server`：启动开发态 Beav browser-control stdio MCP server；正式 App 使用内置 Rust MCP 入口。
- `pnpm package`：先构建，再生成 `dist/Beav-<version>.zip`。

## 使用前提

- Beav 桌面端必须已经启动。
- Desktop Bridge 必须已启动；插件不需要配置 API 地址或本机端口。

### 抖音视频保存

在抖音打开目标作品，播放后使用 Popup 或侧边栏的“保存抖音视频到知识库”。支持视频详情页和精选等列表中的视频弹窗。保存时请停留在该作品；识别不到完整视频或页面已经切换时，会提示重试。

`src/capture/douyinCapture.js` 是 `save-douyin` 共用的 MAIN-world extractor，内部自包含，以便 `chrome.scripting.executeScript` 序列化注入。按 URL / 当前可见播放器的作品 ID 匹配播放器 React props 或 `RENDER_DATA`，标题、作者、封面、统计和媒体均属于该作品。完整 MP4 优先，排除 DASH 独立音视频轨；不再从全页 script / performance 请求中猜媒体地址。无法读取的 MediaSource `blob:` 不会传给桌面下载。详情页支持 `video_<作品 ID>` 容器。保存时在原页面会话内探测该作品的 `playApi`（最多两个完整 MP4 播放入口、共享 8 秒超时、Range 小请求并取消响应体），优先使用返回的新签名视频 URL；其他完整来源通过已有 `assets.videoUrls` 保留。桌面 `knowledge.rs::spawn_note_asset_processing` 在主来源失败后尝试备用来源，所有来源失败后才写失败状态，暂时性失败沿用既有重试次数；`download_note_asset_bytes_once` 继续为抖音 CDN 补来源头并执行公共地址校验、大小限制和原子落盘。

首页信息流保存以当前 `feed-active-video` 作品容器为准，`feed-video` 预加载容器不参与选取；可见详情弹层优先于背后的信息流。多个同级作品同时可见时拒绝猜测。播放数据只从所选播放器的 React props、hook/ref 状态或 `RENDER_DATA` 按完整作品 ID 查找；同 ID 的不完整数据对象不会阻断后续查找。首页的 `RENDER_DATA` 可能只有应用配置，不包含动态加载的作品。异步读取播放地址和封面后重新选择活动播放器，避免首页地址不变、旧 video 节点仍保留时保存上一条。`captureDiagnostics.playerSelection` 和 `dataSource` 记录选取标记及数据来源。

`pnpm test:douyin-capture` 覆盖预加载广告、作品 ID 匹配、两种数据格式、完整视频筛选、签名地址解析与响应体释放、备用来源保留、详情页 ID 及异步解析期间的 SPA 切换。后台控制台的 `[redbox-plugin][douyin] payload` 包含三个作品 ID、数据来源、候选数量、媒体域名与时长，不打印带签名的媒体地址。修改后需构建 `dist/extension` 并重新加载扩展；商店安装版需要更新包才会包含修复；桌面端也需运行包含备用来源修复的版本，单独重载插件不会更新桌面下载器。

## 使用方式

- 新安装时，点击浏览器扩展图标会打开 Beav 快捷弹窗；可在设置页切换为侧边栏工作台。升级用户会保留原有侧边栏打开方式。
- Popup 适合识别并保存当前页面，可直接打开完整侧边栏工作台；批量采集、任务队列和执行日志在侧边栏中使用。
- 可在 Popup 的“设置”、扩展详情页的“扩展程序选项”，或侧边栏顶部的设置按钮中切换打开方式。
- 侧边栏展示当前页面识别、统一任务队列和批量采集入口；详情页采集、下载、导出等轻操作仍通过网页内 DOM 注入按钮触发。
- 在小红书详情页可使用笔记操作区注入按钮：Beav 保存、下载压缩包、下载素材、采集评论。
- 小红书博主页可使用浏览器侧边栏或资料区注入按钮采集主页笔记，采集会优先读取 `user_posted`，失败时滚动主页收集已加载出来的笔记链接。
- 在小红书信息流、搜索页、博主页可点击卡片右上角“采集”按钮保存单条笔记。
- 批量采集默认串行执行；设置页可调整每条笔记之间的随机采集间隔、博主主页默认条数、关键词默认条数和链接批量上限。
- 从多个页面、多个侧边栏或 DOM 注入按钮触发的小红书任务会进入同一个后台队列，避免并发采集互相冲突。
- 博主笔记、链接批量、当前页批量和关键词采集支持在任务队列中暂停、继续或停止；短任务只显示停止。
- 在 YouTube 视频页打开插件，点击“保存 YouTube 视频”
- 在任意网页中选中文字，右键点击“保存选中文字到 Beav”
- 在任意网页点击插件图标，在 Popup 或侧边栏中保存当前页面链接
- 检测到新版本后，点击“打开更新源”会打开 Beav 下载源，下载插件压缩包后重新加载扩展即可完成更新

## 备注

- 插件负责采集、下载、导出、提交结构化数据，以及为桌面端 AI 暴露浏览器控制 MCP 工具；AI 编排和业务决策仍在桌面端完成。
- `captureRuntime.js` 是平台无关的页面采集底座；平台逻辑应只提供根节点、列表项、字段解析和分页策略，不要把滚动等待、DOM 稳定判断、验证页识别重复写进各个平台 extractor。采集 checkpoint 存在 `redboxCaptureCheckpoints`，用于排查页面刷新、断网或站点限流导致的中断。
- 知识整理、漫步、RedClaw 创作仍在桌面端完成。
- 自动更新检查会在插件安装、浏览器启动和后台定时任务中执行；更新源固定为 `https://redbox.ziz.hk/api/updates/plugin`。

连接恢复：`src/background/nativeTransport.js` 对并发连接共用一次握手，并以 Port 身份隔离旧连接回调。Native Host 已启动但 Desktop Bridge 未就绪时，保留健康检查定时器和 MV3 alarm；连接错误码由 background 传到 popup，区分未注册、浏览器拒绝、启动失败、退出和超时。Windows 历史日志显示 2.7.18 时，应核对实际运行版本；Windows 二进制 stdio 修复从桌面 2.7.19 起包含。

### 2.7.16 连接诊断

Windows 支持修复包源码位于 `support/windows-connection-repair/`。`Run-Repair.cmd` 启动 PowerShell，使用当前运行的 Beav 直接测试二进制 ping，备份注册并调用现有 `--install-browser-native-host`，校正当前用户 32/64 位注册视图；失败证据自动通过既有 public-feedback 提交。此工具独立分发，未改 App、插件运行逻辑或服务器。直接启动测试不等价于 Edge 实际恢复；Windows 现场验收待用户运行。

`nativeTransport.js` 记录每次连接的阶段、Port 创建、首消息、ping 发出与响应时间、请求超时及耗时、最早和最近失败。Port 创建只证明浏览器返回了句柄；没有首消息时，不把 Host 进程或 App 版本标为已确认。断开后的健康检查保留 `details.causeCode/causeMessage/causePhase`，防止 `NATIVE_TRANSPORT_DISCONNECTED` 覆盖最初原因。

`diagnostics.js` 自动报告包含：

- 插件版本、扩展 ID、自身安装类型、浏览器版本、系统/架构与可取得的系统版本；本插件实际获得的 Native Messaging 和反馈域权限。
- Host/App 版本与握手时间、桥接错误、注册结果、最近一次连接成功时间、首次失败和最近失败。
- 最多 40 条脱敏连接事件、每次尝试关联号及耗时；仅记录连接相关 RPC 名称，不采集网页内容或业务请求参数。
- 本地 `redboxPluginDiagnosticsDelivery` 保存上报 ID、HTTP 状态、后台反馈 ID、尝试次数及失败原因。只有有效确认响应才记为送达；离线有限补发和 24 小时事件去重沿用现有队列。队列读改写串行，网络发送不占用存储队列。

失败首次安装也会生成随机安装指纹，上传的是哈希；不会上传原始实例 ID。Chrome API 未提供的字段写为 unknown/null。未增加 `management` 权限，不枚举其他扩展；插件无法读取未连通的 Windows Host 日志，这些限制会写入报告。权限依据：[runtime.getPlatformInfo](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getPlatformInfo)、[management.getSelf](https://developer.chrome.com/docs/extensions/reference/api/management#method-getSelf)。

验证：`pnpm test:native-connection-diagnostics` 将实际 transport 和 diagnostics 模块串联，覆盖未注册、退出、超时、异常回包、交替错误、旧升级状态、桥接异常、连接成功与普通 App 未启动。`pnpm test:plugin-diagnostics` 覆盖脱敏、worker 恢复、离线补发、用户主动检查和无确认响应。服务器与 Agent 业务编排未改变。
