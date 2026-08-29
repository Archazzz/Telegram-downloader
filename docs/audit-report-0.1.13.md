# Telegram Media Downloader v0.1.13 测试与审计报告

- 审计日期：2026-08-29
- 版本：0.1.13（package.json = public/manifest.json 一致）
- 代码规模：src/ 25 个 TS 文件，2845 行；tests/ 21 个测试文件
- 审计方式：4 个并行子代理分别负责用户分层、质量稳定性、代码卫生、交互体验；全文通读源码 + 实跑验证命令

## 验证结果速览

| 检查项 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit） | 通过，0 错误 |
| `npm test`（vitest run） | 通过，21 文件 / 66 用例全绿（约 63s） |
| 实机下载测试（作者手工） | 数十个下载全部正常 |

## 0. 执行摘要（给接手 Agent 的话）

功能底子扎实：类型检查与测试全绿，权限最小化，无 XSS 面，状态机与错误翻译完整。最需要动手的是三类事：

1. **一个真实的数据损坏缺陷（最高优先）**：`file:chunk`/`file:close` 超时后客户端自动重发，offscreen 会重复追加写入，导致文件字节重复、视频静默损坏且显示成功。详见 §2 高严重度问题 1。
2. **rookie 的"第 0 公里"完全缺失**：无安装引导、无首用 onboarding、Web A/Z 零反馈；设计稿里的"使用方式"引导区未实现。详见 §1、§4。
3. **体验两笔高性价比投资**：队列面板全量重建（同时拖累性能与键盘可用性）+ 零深色主题适配。详见 §4 P0 清单。

建议行动顺序见 §5。

---

## 1. 用户分层使用情况

### Rookie（新手用户）

**典型使用旅程（实际）**

1. 安装：目前只能开发者模式侧载（`PRODUCT_PLAN.md:575`），仓库根目录无 README，只有 `dist.zip`。
2. 打开 Telegram Web：仅匹配 `https://web.telegram.org/k/*`（`public/manifest.json:30-44`）。在 Web A/Z 页面上扩展完全静默，无任何"请切换到 K 版"提示。
3. 发现下载入口：每个媒体右下角出现 38×38px 半透明圆形图标按钮（`public/content.css:3-10`），无文字标签，hover 才有 `title="下载这个媒体"`（`src/content/main.ts:400-401`）。无首次使用引导。
4. 首个动作：未选目录直接点下载 → 任务立即失败"请点击扩展图标并选择下载目录"（`src/content/main.ts:679`）。正确路径：扩展图标 →「选择」→ Chrome 目录选择器（`src/popup/popup.ts:79-98`）。
5. 下载未加载视频：可能临时自动打开 Telegram 播放器（`src/content/main.ts:707-715`），仅一次性 toast 说明（`src/content/main.ts:709`）。
6. 查看结果：成功短暂提示后按钮复位（`src/content/main.ts:127-129`）；失败显示持久 toast 需手动关闭（`src/content/main.ts:383`）。

**卡点与断点**

- 侧载安装 rookie 基本无法独立完成（`PRODUCT_PLAN.md:575`）。
- "先选目录"这一前置条件无任何引导；设计稿 `docs/design/popup-render.png` 里有「使用方式」说明区，但实际 `public/popup.html:10-45` 未实现。
- Web A/Z 用户零反馈（`public/manifest.json:31-44`；Web A/Z adapter 是 `PRODUCT_PLAN.md:25` 未完成项）。
- 术语不人话：「Telegram 原生下载失败：…；预览回退失败：…」（`src/content/main.ts:720`）、「媒体地址已失效…」（`src/content/main.ts:592`）、「写入器未获得权限」（`src/popup/popup.ts:88`）。
- 播放器自动弹出易被误解，且 toast 只展示一次（`viewerHintShown`，`src/content/main.ts:56`）。
- 下载完成后无「打开所在文件夹」入口（`src/content/main.ts:127-129` 仅复位按钮）。

**缺失能力（刚需）**：商店上架或图文安装说明；首次运行引导；Web A/Z 检测与迁移提示；下载完成后的文件定位入口。

### 普通用户

**典型使用旅程（实际）**

1. 选好目录（状态"已授权，可直接保存"，`src/popup/popup.ts:21`）。
2. 单文件：附件按钮 →「等待」→ 百分比进度 → 打勾（`src/core/ui-state.ts:21-33`）。
3. 消息级批量：≥2 附件的消息下方出现「下载本消息全部 N 项」（`src/content/main.ts:433`），按钮显示「下载中 x/N」。
4. 队列管理：右上角队列面板分「正在下载/等待中/最近状态」三段，支持逐项暂停/继续/取消/重试与全部操作（`src/content/main.ts:237-245`、`:353-356`）。
5. 出错处理：自动重试 3 次（1/2/4 秒退避，`src/content/main.ts:44`、`:748-785`）；最终失败弹持久 toast + 行内重试；附件按钮变「!」可点重试（`src/core/ui-state.ts:34-37`）。
6. 进度反馈：字节数、百分比、平滑速度、阶段（Telegram 传输/网络传输/本地写入，`src/content/main.ts:223-226`）；badge 显示活动数、失败优先「!」（`src/core/ui-state.ts:42-47`）。

**卡点与断点**

- 批量范围仅限单条消息：「下载本聊天已加载的 50 张图」做不到（跨消息选择是 P1 未完成项，`PRODUCT_PLAN.md:25`、`:105`；代码只处理 `group.mediaIds`，`src/content/main.ts:437-447`）。
- 重试依赖原消息还在注册表：滚出视口后报「原消息媒体已失效…」（`src/content/main.ts:291`）。
- 队列不持久：存于 content script 内存（`src/content/main.ts:51`），刷新页面等待中任务全丢。
- 权限失效需用户主动再点（`src/content/main.ts:680`、`src/popup/popup.ts:86`）。
- 未知大小文件进度条恒为 28%（`src/content/main.ts:231`），易被误认为卡死。
- 未加载视频取流阶段不可暂停（`canPause=false`，`src/content/main.ts:170`），无解释。
- 弹窗统计只看当前活动标签页（`src/background.ts:63-71`），多标签页时数据误导。

**缺失能力（刚需）**：跨消息多选/全量批量（FR-13，P1）；GIF、语音、视频消息支持（`PRODUCT_PLAN.md:106`）；队列持久化；「一键重试全部失败项」。

### 专家用户

**典型使用旅程（实际）**

专家能用的"高级控制"实际只有一项：弹窗并发 1–5 分段选择（`public/popup.html:28-34`、`src/shared/settings.ts:5-7`）。设置持久化在 `chrome.storage.local`，运行中改并发经 bridge 即时生效（`src/content/main.ts:61-64`）。三阶段速度（`src/content/main.ts:223-226`）是唯一的专家向反馈。

**卡点与断点**

- `ExtensionSettings` 只有 `concurrency` 一个字段（`src/shared/settings.ts:5-7`）：无命名模板、无格式/质量选择、无子目录规则。
- 文件名硬编码：原始文件名 → `telegram-{kind}-{id}` 兜底（`src/core/media.ts:78-83`）；命名模板是 P1 计划（`PRODUCT_PLAN.md:107`）未实现。
- 无自动化接口：MAIN world 刻意不暴露下载 API（`PRIVACY.md:9`）；导出清单是 P2（`PRODUCT_PLAN.md:117`）。
- 并发硬上限 5（`src/shared/settings.ts:2`、`:15-19`）。
- 结构化诊断日志默认关闭且无用户开关（`PRODUCT_PLAN.md:461-462`）。
- 无下载历史（P2，`PRODUCT_PLAN.md:115`）、无筛选（P2，`PRODUCT_PLAN.md:116`）。
- 大文件内存路径 >512MB 只弹 toast 提醒（`src/core/ui-state.ts:49-53`、`src/content/main.ts:689`），无法选"流式/放弃"。
- 仅 Web K，无法跟随常用 A/Z 客户端。

**缺失能力（刚需）**：文件名模板与子目录规则；跨消息筛选 + 全量批量 + 导出清单；并发上限自定义/限速；格式画质选择；诊断日志开关；下载历史；最小自动化 API。

### 分层结论速查表

| 档位 | 上手难度 | 主要卡点 | 最急需改进 |
|---|---|---|---|
| Rookie | 高：侧载 + 无引导 + 必须先手动选目录 | 不知先选目录；Web A/Z 无反应；播放器自动弹出困惑 | 安装引导 + 首用 onboarding（设计稿已有）+ Web A/Z 提示 |
| 普通用户 | 低：选完目录后链路顺畅 | 批量只到单条消息；滚走后无法重试；刷新丢队列 | 跨消息批量（FR-13）+ 一键重试失败项 + 队列持久化 |
| 专家用户 | 中：功能在，没深度 | 唯一可调项是并发 1–5；命名/格式/筛选/自动化全缺 | 文件名模板 + 筛选批量/导出 + 诊断日志开关（均在 P1/P2 计划内，排期提前） |

---

## 2. 代码质量与稳定性

### 验证结果

- `npm run check`（tsc --noEmit）：**通过**，0 错误。
- `npm test`（vitest run）：**通过**，21 个测试文件、66 个用例全部通过（约 63s）。

### 高严重度问题

**H1. `file:chunk`/`file:close` 超时后被客户端自动重发，造成重复写入、文件静默损坏**

- 位置：`src/content/bridge-client.ts:181-185`（`request()` 对任何 `BRIDGE_UNAVAILABLE` 无条件重发一次）、`:205-208`（超时即按 `BRIDGE_UNAVAILABLE` reject）、`:142-146`（`recoverBridge` reject 全部在途请求触发连锁重发）、`src/core/file-store.ts:67-73`（`write` 纯追加，无幂等保护）。
- 问题：客户端超时（chunk 30s、close 10 分钟）只说明**响应**慢了，不代表 offscreen 没处理——请求经 BroadcastChannel 几乎必然已送达。重发同一 `requestId` 的 chunk 后，offscreen 把同一块数据**再追加一遍**；`file:close` 重发则命中 `file-store.ts:77`"句柄不存在"或走入 `discard` 删掉正在提交的文件。批量场景一次桥接重建会让所有在途 chunk 各自自动重发。
- 触发场景：单 4MB 块写入超 30 秒（机械盘休眠、杀软扫描、网络盘）、大文件 close 超 10 分钟、下载中扩展重载/更新。结果：显示成功但视频字节重复、无法播放，无任何报错。
- 建议：只允许"确认未发出"的失败（帧已死、`postMessage` 抛错）重试；超时路径对非幂等请求（`file:start/chunk/close`）禁止自动重发，直接失败由上层整文件重试；或 offscreen 端按 `requestId` 记录已写偏移做幂等（重复块直接返回当前 `bytesWritten`）。

### 中严重度问题

**M1. `FileStore` 句柄泄漏累积到 25 个后写入器永久锁死，无自愈路径**

- 位置：`src/content/bridge-client.ts:47-49`（`abortFile` 静默吞错）、`src/content/main.ts:782`、`src/core/file-store.ts:42`（`openFiles` 无过期/回收）、`:52-54`（达上限抛 `WRITER_CAPACITY`）、`src/background.ts:29-46`（offscreen 永不关闭）。
- 场景：桥接失效窗口内失败/取消的下载，其 `file:abort` 到不了 offscreen，句柄和半成品文件滞留；泄漏满 25 个后**所有标签页**无法下载，只能重启浏览器。
- 建议：`file:start` 按存活时间或同 `fileName` 回收无主句柄；或提供 writer 重置消息。

**M2. `file:start` 超时重试导致"句柄已存在" + 句柄泄漏 + 多余副本文件**

- 位置：`src/core/file-store.ts:51`（同 `requestId` 直接抛错而非返回既有句柄）、`src/content/bridge-client.ts:181-185`。
- 建议：`start` 幂等化——同 `requestId` 已存在时直接返回已分配的 `fileName`。

**M3. offscreen 文档就绪竞态：`createDocument` resolve 后 BroadcastChannel 监听未必就绪，首条 relay 消息丢失**

- 位置：`src/background.ts:37-45`、`src/bridge/bridge.ts:117`。BroadcastChannel 不缓冲，offscreen 未订阅前消息直接丢弃，请求挂到 30s 超时。
- 场景：扩展冷启动后第一次 `status`/`file:start`，慢机器更易命中；表现为首次下载偶发 30 秒级卡顿。
- 建议：offscreen 加载后主动广播 `writer:ready`，bridge 收到前排队 relay；或首条请求先 ping/ack。

**M4. popup 存在未处理的 Promise rejection，失败时界面白屏**

- 位置：`src/popup/popup.ts:73`（`Promise.all` 无 catch）、`:59`（`sendMessage` 可 reject）、`:76`（listener 内 `void renderStats()`）。
- 场景：IDB 不可用（隐私模式）或 SW 重启间隙打开 popup → 界面保持空白。
- 建议：三个 render 函数各自 catch 并渲染降级文案。

**M5. viewer 回退路径在多视频同时变化时永远等不到"唯一候选"**

- 位置：`src/core/viewer.ts:88-90`（`changedVideos.length === 1` 才采纳）。
- 场景：聊天页多个自动播放视频同时加载/换源 → 候选 >1 → 30 秒超时失败，尽管目标流早已出现。
- 建议：多候选时按"位于 viewer 内且为新视频"优先、其次与 `root` DOM 距离最近者择优。

### 低严重度问题

- `src/content/main.ts:619`：真实 0 字节媒体在 `written <= 0` 处误报"下载已停滞"。`total === 0` 时应跳过该检查。
- `src/content/main.ts:609`、`:547`：fetch 响应头阶段与 `arrayBuffer()` 路径无停滞超时（60s 看门狗只覆盖 body 读取），服务器挂起连接时无限等待。给首字节也套 `withAbortableTimeout`。
- `src/content/main.ts:778`：`closeFile` 返回的 `bytesWritten` 被忽略，无"写入字节数 vs 预期 total"最终校验；短文件会显示成功。
- `src/content/main.ts:127-129`：成功/取消后 2.2s 的 `resetAttachmentState` 与快速重新入队竞态——新任务已排队，按钮却被重置为 idle。reset 前检查 `downloadItems` 当前状态。
- `src/core/queue.ts:158`：`onState` 回调在 `drain()` 内同步调用且无 try/catch，回调抛异常会中断 drain 并泄漏 `running` 计数（队列永久卡槽）；`.then` 内回调抛错产生 unhandled rejection。现实风险点：`main.ts:444` 的 `button!.querySelector("span")!`。drain 内包 try/catch。
- `src/core/errors.ts:36-41`：DOMException 映射不全，`NoModificationAllowedError`（文件被占用）会把英文原文抛给用户。补 `FILESYSTEM_UNAVAILABLE` 映射。
- `src/shared/destination.ts:35-48`：`operation(store)` 同步抛错时 `database.close()` 永不执行，IDB 连接泄漏。包 try/catch 兜底关闭。
- `src/content/main.ts:809` + `src/background.ts`：每个 Telegram 标签页 boot 即唤醒 offscreen 且终身不关闭，不下载也常驻。属设计取舍，建议记录为已知成本。

**值得肯定**：SW 休眠唤醒处理（`getContexts` 防重复创建、`statsByTab` + `storage.session` 双写回退）、桥接失效检测（`contentDocument` 判死、`frameEpoch` 防串联恢复）、队列取消/暂停语义与错误归一化整体扎实。

### 测试覆盖评估

- **覆盖充分**：`queue`（含 500 任务压力）、`bridge-client`（含失效重建/扩展重载/长 close）、`file-store`（含重名/容量）、`discovery`（含 3000 媒体/1 万消息 stress）、`viewer`、`telegram`、`range`、`media` 等。
- **薄弱/缺失**：
  - `src/content/main.ts`（814 行，全项目最大文件）**零直接测试**——重试矩阵、206 多分块续传循环、停滞超时均无覆盖。**这是最大盲区，H1 恰好落在这里。**
  - `src/bridge/bridge.ts` 仅 `page:stats` 一条路径有测试；`file:*` relay、relay 超时、`notifyInvalidated` 未测。
  - `src/background.ts`、`src/offscreen/offscreen.ts`、`src/shared/writer.ts` 无测试。
  - `errors.ts` 未覆盖各 DOMException→错误码映射分支。

> 注：H1 与 M3 属时序/环境相关缺陷，无法在 vitest 环境实证复现，结论基于代码路径推演，修复时应补集成测试验证。

---

## 3. 代码卫生

总体结论：**卫生状况良好，无高危问题**。逐项结果：

### 3.1 遗留标记
未发现问题。`TODO|FIXME|HACK|XXX|DEPRECATED` 在 src/、public/、scripts/、tests/ 零命中。

### 3.2 调试残留
未发现问题。src/ 与 public/ 中 `console.*`/`debugger` 零命中（错误全走消息协议或 toast）。唯一 `console.log` 在 `scripts/build.mjs:52`，属 CLI 正常输出，保留。

### 3.3 类型卫生
- `: any`、`as any`、`@ts-ignore`、`@ts-expect-error` 零命中；tsconfig 开 `strict` + `noUncheckedIndexedAccess`。
- 非空断言 src/ 共 9 处，全部有前置守卫。`src/content/main.ts:442-444, 451-453` 的 `button!` 三连可引入 `const btn = button` 消除（低优）。
- `as unknown as BridgeStatus` 双断言（`src/content/bridge-client.ts:28`、`:245`）绕过结构检查，跨进程消息无运行时校验（低优）。

### 3.4 安全相关卫生
- innerHTML 仅 `src/content/main.ts` 6 处（:123-125, :138, :188, :210, :402, :433），插入的全部是静态 SVG 常量或纯数字/固定状态词；用户可见文本走 `textContent`。**无 XSS 注入面**，建议保持"innerHTML 只接静态常量"约定。
- `eval`/`new Function`/`document.write`/`insertAdjacentHTML` 零命中；三个 HTML 无内联脚本，符合 MV3 CSP。
- manifest 权限最小化：`permissions: ["storage", "offscreen"]` 均必需；`host_permissions` 仅 `https://web.telegram.org/*`，content_scripts 收窄到 `/k/*`；CSP 为最小 `script-src 'self'; object-src 'self'`。
- 弱项：`src/content/bridge-client.ts:111` ping 用 `postMessage(..., "*")`，载荷无敏感数据且响应侧有校验（低优）。

### 3.5 死代码
- 无未引用导出、无大段注释代码。
- 仅测试使用的生产 API：`src/core/queue.ts:75` `enqueueMany()`、`:49` `maxConcurrency`、`src/core/file-store.ts:46` `openCount`（保留或低优删除）。
- `src/shared/destination.ts:64` `requestDirectoryPermission` 多余导出（仅模块内部调用），低优去掉 `export`。

### 3.6 仓库卫生
- `.gitignore` 覆盖 node_modules/dist/coverage/log；`git ls-files` 73 文件无产物入库。
- **中优：`dist.zip`（61.5 KB）在仓库根目录，未被 git 跟踪也未被 .gitignore 覆盖，有误提交风险** → `.gitignore` 增加 `dist.zip` 或删除该文件。
- 版本一致性合格（构建时 `scripts/build.mjs:49` 用 package.json 覆盖 manifest 版本）。
- 根目录无 README.md（低优建议补）。

### 3.7 重复与一致性
- 错误字面量重复：「扩展写入桥接页已失效，正在重新连接」4 处（`src/bridge/bridge.ts:36`、`src/content/bridge-client.ts:201,224,239`）、「无法启动扩展写入器」2 处（低优提取为 protocol.ts 常量）。
- 大文件警告逻辑重复：`main.ts:687-690` 与 `:764-767`（低优抽函数）。
- `updateDownloadState` + `setAttachmentState` 成对同参调用 5 处（低优合并辅助函数）。
- 裸 `Error` 与 `DownloadError` 混用（`main.ts:619,621,679,680`），错误分类依赖隐式行为（低优统一）。
- 用户可见字符串全简体中文、术语一致，合格。

### 3.8 依赖与配置卫生
- 5 个 devDependencies 全部在用，无运行时依赖。tsconfig 严格度高于常规。vitest.config 最小。
- `scripts/build.mjs:5` 用 `process.cwd()` 推导根目录，脱离 npm scripts 直接运行会用错根（低优改 `import.meta.url`）。

### 卫生问题清单（按优先级）

| 优先级 | 问题 | 位置 | 建议动作 |
|---|---|---|---|
| 中 | `dist.zip` 未跟踪也未 ignore，有误提交风险 | 仓库根目录 / `.gitignore` | `.gitignore` 加 `dist.zip` 或删除 |
| 低 | `button!` 非空断言三连 | `src/content/main.ts:442-444, 451-453` | 引入 const 消除 |
| 低 | `as unknown as BridgeStatus` 双断言 | `src/content/bridge-client.ts:28, 245` | 保留或补运行时校验 |
| 低 | 错误字面量重复 4/2 处 | bridge.ts:36、bridge-client.ts:201,224,239、writer.ts:11 | 提取共享常量 |
| 低 | 大文件警告逻辑重复 | `main.ts:687-690` 与 `764-767` | 抽公共函数 |
| 低 | 状态设置成对调用 5 处 | `main.ts:656-657` 等 | 合并辅助函数 |
| 低 | 裸 Error 与 DownloadError 混用 | `main.ts:619,621,679,680` | 统一为 DownloadError |
| 低 | `requestDirectoryPermission` 多余导出 | `src/shared/destination.ts:64` | 去掉 export |
| 低 | 缺 README.md | 仓库根目录 | 补充 |
| 低 | build.mjs 依赖 process.cwd() | `scripts/build.mjs:5` | 改 import.meta.url |

---

## 4. 交互与体验优化

### 4.1 反馈与状态可见性

做得好：单附件按钮状态机完整且每态有独立 aria-label + title（`src/core/ui-state.ts:20-40`）；失败常驻 toast 需手动关闭；队列面板有聚合进度与总速度；传输阶段透明；badge 显示活动数/失败数。

问题：
- **未知总大小时下载按钮无心跳**：拿不到 total 时按钮回落为静态下载箭头（`ui-state.ts:22-31`、`main.ts:600`），长下载看起来"死了"。
- **全部完成时 badge 直接清空，无正向完成信号**（`ui-state.ts:46`）；manifest 无 notifications 权限。
- 成功反馈仅 2.2 秒打勾图标（`main.ts:127-129`），无 toast、无面板强调。
- 队列面板折叠状态不持久（内存变量 `main.ts:55`）。

### 4.2 错误体验

做得好：`normalizeDownloadError` 把磁盘满/目录失效/权限/断网翻译成"人话 + 下一步"（`src/core/errors.ts:30-47`）；失败有两处一键重试入口。

问题：
- popup 失败数只读不可点（`src/popup/popup.ts:68`），用户看到失败无从处理。
- 失败 toast 无内联重试按钮（`main.ts:104`）。
- 内部错误直接透传原始 message（`main.ts:633-635`、`errors.ts:46`），如"下载分块长度与服务器声明不一致"（`main.ts:621`）顶到 toast，无行动指引。
- 批量失败后无"重试全部失败"（`main.ts:353-356`）。

### 4.3 页面内控件的融入度

- **完全没有深色主题适配**：`prefers-color-scheme` 零匹配；content.css 全部浅色硬编码（39-64 行）；popup 锁死 `color-scheme: light`（`public/popup.css:2`）。Telegram 深色用户占比很高。
- **仅支持 K 版**（`manifest.json:30-45`）；但 `discovery.ts:3-6` 的 `[data-mid]` 选择器实际已兼容 A 版，差距只在 match pattern 和验证。
- 38px 圆形按钮固定压每个附件右下角（`content.css:3-4`），无尺寸/避让守卫，小贴纸/GIF 上占比过大，可能遮原生角标。
- `.tmd-message-actions` 块级容器撑高消息气泡（`main.ts:416-425`），注入瞬间有可见跳动。
- 样式全 `!important` + 固定色值，不跟随 Telegram 主题变量。

### 4.4 popup 信息架构

现状三段结构（目录/并发/当前页面）层级清楚，空状态文案明确。与设计稿差距：
- **缺"使用方式"引导区**（设计稿 `docs/design/popup-render.png` 下半部分有图文引导，实现没有）。
- **缺设置页与隐私承诺承载**：`options-render.png` 画了整页设置（含"仅在本机处理，不上传任何媒体"），manifest 无 `options_ui`。privacy-first 是卖点却无界面承载。
- 并发段控件视觉无单位（1–5 纯数字，`popup.ts:49`，设计稿每个数字下有"个任务"小字）。
- 无版本号、无反馈/帮助入口。

### 4.5 文案与国际化

- 无 i18n：无 `_locales`、无 `default_locale`，全部硬编码中文。
- 名称不统一：manifest `name`/`description`/`default_title` 英文（`manifest.json:3,6,21`），popup 标题中文"媒体下载器"，offscreen justification 英文（`background.ts:40`）——同一产品三个名字。
- 好的一面：中文术语内部一致，错误文案语气统一。

### 4.6 无障碍与键盘

做得好：注入控件全是原生 `<button>` 带 aria-label/`:focus-visible`；toast 用 `role="status"/"alert"`；`prefers-reduced-motion` 已处理。

问题：
- **活动下载期间队列面板对键盘用户不可用**：`renderQueuePanel` 每次 `panel.replaceChildren()` 全量重建（`main.ts:319`），进度事件驱动 rAF 渲染——下载中每秒多次重建整个面板 DOM，焦点被销毁、滚动被重置。
- 面板无 Escape 关闭、无焦点管理。
- 进度条纯 `div > i` 无 `role="progressbar"`/`aria-valuenow`（`main.ts:228-232`）。
- `.tmd-queue-text-button` 无 `:focus-visible` 样式（`content.css:70-71`）。
- 附件按钮对比度随图片背景波动，仅靠 1px 白边兜底。
- 并发段控件语义应为 `radiogroup` + `aria-checked` 而非 `group` + `aria-pressed`（`popup.html:33`）。
- 队列行 detail 文字 10px 偏小（`content.css:82`）。

### 4.7 性能体感

- **队列面板全量重建是最大隐患**：除无障碍问题外，每帧重建含缩略图 `<img>` 重建（`main.ts:204-208`），任务多时可感知掉帧。应改按 item 增量更新。
- MutationObserver 监听整棵文档 + 属性（`main.ts:793-804`），有 rAF 合批 + 每帧最多 24 个 root（`main.ts:495-500`），属合理折中，视频宫格页 `src` 属性过滤触发密集，建议后续观察。
- popup 打开延迟无明显问题；badge 状态经 `storage.session` 持久化，SW 重启不丢，设计正确。
- toast 到期直接 `remove()` 无退场动画（`main.ts:113`），观感生硬。

### 优化清单（按优先级）

| 优先级 | 优化项 | 位置 | 现状→建议 | 工作量 |
|---|---|---|---|---|
| P0 | 队列面板改增量更新 | `main.ts:306-361`（replaceChildren@319） | 每帧全量重建 DOM → 按 item id 缓存行节点，只更新进度条宽度与文本 | M |
| P0 | 深色主题适配（页面控件 + popup） | `content.css` 全文；`popup.css:2` | 浅色硬编码 → CSS 变量 + `@media (prefers-color-scheme: dark)` | M |
| P0 | 未知大小时下载按钮补心跳 | `ui-state.ts:22-31` | 静态箭头 → 旋转/脉冲动画或已下载字节数 | S |
| P0 | 完成态正向反馈 | `ui-state.ts:42-47` | badge 清空 → 短暂绿色 ✓ 或成功 toast | S |
| P0 | 失败 toast 内联"重试"按钮 | `main.ts:104, 383` | 只有关闭 → 附加重试按钮调 `retryDownload` | S |
| P1 | popup 补"使用方式"引导区 + 隐私承诺 | `public/popup.html`（对比设计稿） | 缺失 → 按 `docs/design/popup-render.png` 补 section | S |
| P1 | popup 失败数可点击 | `src/popup/popup.ts:68` | 纯文本 → 点击跳回标签页并展开队列面板 | S |
| P1 | 队列面板键盘可用性 | `main.ts:306-361` | 无 Escape/焦点管理 → 补齐（配合 P0 增量更新） | S |
| P1 | 进度条 aria 语义 | `main.ts:228-232` | 纯 div → `role="progressbar"` + `aria-valuenow` | S |
| P1 | 批量"重试全部失败" | `main.ts:353-356` | 无 → 存在失败项时追加"重试失败 N 项" | S |
| P1 | 内部错误文案人话化 | `main.ts:619-621, 633-635`；`errors.ts:46` | 透传开发者文案 → 统一进 DownloadError 映射表 | S |
| P1 | 支持 Telegram A 版（/a/） | `manifest.json:30-45` | 只匹配 /k/ → 增加 /a/ 并实测选择器 | M |
| P2 | i18n 与名称统一 | `manifest.json:3,6,21`；全仓库 | 硬编码中文 + 三个名字 → `_locales` + 统一命名 | L |
| P2 | 下载按钮尺寸/避让守卫 | `main.ts:390-413`、`content.css:3-4` | 38px 无条件压右下角 → 小媒体缩小/隐藏 | M |
| P2 | 队列折叠状态持久化 | `main.ts:55` | 内存态 → sessionStorage | S |
| P2 | 段控件语义与单位 | `popup.html:33`、`popup.ts:36,49` | group/aria-pressed → radiogroup/aria-checked + "个任务"小字 | S |
| P2 | `.tmd-queue-text-button` 焦点样式 | `content.css:70-71` | 仅 :hover → 补 :focus-visible | S |
| P2 | toast 退场动画 | `main.ts:113` | 直接 remove → opacity/translate 过渡（尊重 reduced-motion） | S |

---

## 5. 建议行动顺序（跨章节合并 Backlog)

按"风险/收益 × 成本"排序，供接手 Agent 直接按序执行：

| # | 事项 | 来源 | 理由 |
|---|---|---|---|
| 1 | 修复 H1：非幂等请求超时禁止自动重发 / offscreen 按 requestId 幂等 | §2-H1 | 唯一已确认的数据损坏路径，静默产生坏文件 |
| 2 | 修复 M1+M2：FileStore 句柄回收与 file:start 幂等 | §2-M1/M2 | 与 H1 同一修复面，顺带消除"25 句柄锁死" |
| 3 | 修复 M3：offscreen ready 握手 | §2-M3 | 首次下载偶发 30s 卡顿，改动小 |
| 4 | 补 main.ts 重试矩阵与幂等写入的回归测试 | §2 测试盲区 | 没有测试挡 H1 回归 |
| 5 | M4 popup rejection 兜底 + M5 viewer 多候选择优 | §2-M4/M5 | 各几行改动，消除白屏与超时失败 |
| 6 | P0 体验包：队列面板增量更新、深色主题、无 total 心跳、完成态反馈、失败 toast 内联重试 | §4-P0 | 体验立升，全部 S–M |
| 7 | popup 补"使用方式"引导区（rookie 第 0 公里） | §1-Rookie、§4-P1 | 设计稿已存在，实现成本低，直接降 rookie 流失 |
| 8 | P1 体验包：失败可点、键盘可用、aria 进度条、批量重试失败、错误文案人话化 | §4-P1 | 均 S |
| 9 | 卫生中优项：.gitignore 加 dist.zip | §3 | 一行改动 |
| 10 | 低优修复包：0 字节误报、fetch 首字节超时、bytesWritten 校验、reset 竞态、queue onState try/catch、errors 映射补全、IDB close 兜底 | §2-低 | 可合并为一个"稳定性打磨"提交 |
| 11 | 低优卫生包：字面量常量化、重复逻辑抽函数、DownloadError 统一、去多余 export、README | §3 | 顺手可做 |
| 12 | P1 规划项提前：跨消息批量（FR-13）、文件名模板、诊断日志开关 | §1 各档 | 已在 PRODUCT_PLAN P1 内，是普通/专家用户最想要的 |
| 13 | A 版支持（/a/ match + 实测） | §4-P1 | discovery 选择器已兼容，差距在 match pattern 与验证 |
| 14 | P2 包：i18n/名称统一、按钮避让、折叠持久化、段控件语义、焦点样式、toast 退场 | §4-P2 | 打磨项 |

> 执行注意：#1–#3 修改的是同一条消息链路（bridge-client ↔ bridge ↔ offscreen/file-store），建议作为一组变更一起做并一起测；#6 的队列面板增量更新会重写 `renderQueuePanel`，#8 的键盘可用性依赖它，顺序不要颠倒。
