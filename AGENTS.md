# AGENTS.md — dsh-library

面向 AI 代理/新协作者的说明。本项目是一个 **DeepSeek Harness (dsh) 第三方插件**：宿主半身（`index.js` + `src/host/`）直接读写用户本机 Zotero 文库（或自建独立文库）并提供 `library_*` agent 工具；浏览器半身（`src/client/` → esbuild → `client.js`）在左侧栏底部注入「文库」入口，并把主栏切换为 Zotero 风格整页视图 + 「文献助手」dock——面板内通过 `SessionProvider`（绑定 `ctx.sessions.retain` 的 Library 会话引用）嵌入 dsh 共享的 `conversation.content` Factory（native 对话正文 + composer，View 固定为 Chat，模式同 ui-subagent 侧栏聊天），不自绘对话 UI；无 sessions 服务时回退为 `uiWorkspace.openSession` 跳转。

插件规范与关键机制（研读 dsh 源码与 DS-Bot/dsh-mol-structure 的结论，勿重新摸索）：

- 包声明：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`（一行 `insert`，`id: library`、`name: dsh-library`）；`dsh.client: { platform: 'web', immediately: true }` 声明浏览器半身，`exports['./client']` 指向 `client.js`。
- 宿主半身导出 `name = 'library'`、`version`、`inject`、`apply(ctx, config)`。`inject` 必须含 `connection`（鉴权 API 通道）、`sessionController`/`sessionTitle`/`workspaceRegistry`（对话与工作区）。`tools` 用嵌套 `ctx.inject` 可选挂载。
- API 通道：`ctx.connection.fetch.register({ path: '/api/library', methods: ['POST'], requestBody: 'buffered', fetch })`。浏览器用同源 cookie 鉴权，**不要**改用 `webServer` + 自建信任围栏。单端点 `{endpoint, payload}` 信封，返回 `{ok, value|error}`。
- 会话/工作区（对话 dock）：`ctx.workspaceRegistry.resolveByPath/create` → `ctx.sessionController.create({workspaceId, agentPreset:'standard'?})` → `ctx.sessionTitle.rename`；发消息 `ctx.sessionController.prompt({requestId, sessionId, mode:'queue', content})`；读转录 `ctx.sessionController.page({address:{kind:'session',sessionId}, throughSeq, beforeSeq, maxMessages})`；停止 `resolveAgent(...).agent.cancel({kind:'user'})`。
- 浏览器半身：`window.__ModuleLoader__.load({ id: 'dsh-library', factory: (require) => … })`；平台模块表仅这些可 require：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。esbuild 必须把上述模块设为 external。
- 入口与整页视图：左侧栏底部 = `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'dsh-library', order:-50, inject: () => ({ layout: ctx.layout }) }, Entry))`；整页 = keyed slot `main`，`ctx.slots.register({ name:'main', key:'library' }, Page)`，切换 `ctx.layout.selectPanel('library')` / `selectPanel(null)`。
- 客户端 UI 文案为中文，直接写在组件里（第三方插件，不走 locale 词典）。

## 项目布局

```
dsh-library/
├── index.js                 宿主入口：注册 API 路由、工具、runtime 生命周期
├── cordis.patch.yml         bundle patch（一行 insert）
├── client.js                esbuild 产物（提交；不要手改）
├── src/host/
│   ├── db.js                node:sqlite 连接、schema 元数据（itemTypes/fields/列集合）、事务
│   ├── locate.js            Zotero 数据目录探测（profile prefs → 默认路径）
│   ├── read.js              分类树/标签/列表/详情/批注查询（原生 Zotero schema）
│   ├── write.js             建/改/删、标签/作者/分类、附件落盘（列自适应）
│   ├── ingest.js            导入流水线：元数据 → 父条目 → 附件 → 全文缓存 → 批注（needsMetadataHelp 标记）
│   ├── pdf.js               unpdf 全文 + PDF 内嵌批注提取（pdf.js 坐标）
│   ├── metadata.js          DOI/ISBN/arXiv + Crossref 题名检索
│   ├── cite.js              CSL-JSON / BibTeX 导出（也是 Office 插件预留接口）
│   ├── standalone.js        无 Zotero 时创建独立文库（schema 130 + 种子数据）
│   ├── schema-data.js       zotero/zotero-schema 紧凑种子（条目类型/字段/CSL 映射）※tools/gen-standalone-assets.mjs 生成
│   ├── userdata-sql.js      Zotero userdata.sql DDL（去注释与 debug 表）※同上
│   ├── webdav.js            Zotero WebDAV 协议（验证/列表/上传/下载/删除/同步）
│   ├── watcher.js           storage mtime 轮询扫描（勿改回 fs.watch，见陷阱 9）
│   ├── open.js              系统阅读器/文件管理器（Windows 用 explorer.exe，避免 cmd 解析）
│   ├── chat.js              Library 工作区会话、转录归一化、文献助手上下文前缀
│   ├── tools.js             13 个 library_* agent 工具（鸭子类型，标准 JSON Schema）
│   ├── runtime.js           数据库生命周期、文库模式（zotero/standalone）、导入队列、同步、备份、轮询 revision
│   ├── channel.js           API 端点分发（含 setup / cite-json / cite-bibtex）
│   ├── settings.js          $DSH_HOME/library/{settings,state}.json
│   └── updater.js           清单校验 + 分阶段替换 + 回滚
├── src/client/              React/JSX 源码（index、library-page、三分栏、pdf-viewer（pdf.js 轻量库内查看器：选择文本→高亮/下划线/批注、旋转当前页、全文查找，pdf-util.js 承载页矩阵/文本层/查找索引）、settings-section（dsh 原生设置里的「文库」页）、文献助手 dock（嵌入原生 conversation.content）、dialogs；platform.jsx 再导出 dsh 原生原子组件）
├── vendor/deps.js           fflate+unpdf 打包（宿主提取用，运行时零 npm 依赖）
├── tools/                   build-client / build-vendor / build-manifest / vendor-entry / gen-standalone-assets
├── scripts/                 host-smoke / webdav-smoke / client-smoke / reader-e2e（真浏览器：像素绘制、缩放重栅格化、适应宽度、缩小居中、跳页、选区→高亮→批注落库、查找、旋转当前页）/ bench-harness（基准共享壳）/ pdf-open-bench（打开→首像素→缩放→远跳计时）/ pdf-pages-bench（逐页跳转着色计时，--back 回程）
└── feed/manifest.json       自升级清单（npm run manifest）
```

## Zotero 数据库要点（已在本机 schema 125 与源码 v130 验证）

- 用户库 `libraryID=1`；`version('userdata')` 为 schema 版本，>130 拒绝写入。
- `items`（`version`/`synced`/`clientDateModified`）、`itemData`+`itemDataValues`+`fieldsCombined`、`itemCreators`+`creators`+`creatorTypes`、`itemTags`+`tags`、`collections`+`collectionItems`、`itemNotes`、`itemAttachments`、`itemAnnotations`、`deletedItems`/`deletedCollections`、`storageDeleteLog`。
- **列是动态的**：schema 125 没有 `clientVersion` / `valueNormalized` / `nameNormalized` / `*Normalized`；所有 INSERT 必须经 `insertRow()`/`db.columns()` 过滤。不要硬编码 schema 130 的列。
- 批注：内置 pdf.js 查看器经 `annotation-create/update/delete` 通道端点直接写 Zotero 行（`isExternal=0`，`synced=0` 随 Zotero 同步上传），**不改 PDF 文件**；选区矩形由客户端页矩阵转成 PDF 用户空间后入库。导入 PDF 时宿主仍会用 unpdf 提取**文件里已有的**内嵌批注入库（`isExternal=1`）。`itemAnnotations` 是右栏/文献助手/同步/查看器的统一查询面（`type` 1 高亮/5 下划线/2 笔记/4 墨迹/6 文本/3 图片；`position` JSON `{pageIndex, rects, pageHeight}` 为 **PDF 用户空间坐标**；`sortIndex = pageIndex|offset|pageHeight-rect[3]`）；批注 item 本身不需要 itemData。
- 本地修改：`synced=0`、`dateModified/clientDateModified = CURRENT_TIMESTAMP`（UTC SQL 时间），`version` 保持不变，由 Zotero 同步负责上传。
- 附件：`linkMode` 0/1 存在 `storage/<itemKey>/<file>`；`path` 写作 `storage:<filename>`；`storageModTime` 为毫秒；`storageHash` 为 zip 的 MD5；`syncState` 0=待上传、2=同步、3=冲突。
- 全文缓存：`storage/<key>/.zotero-ft-cache`（纯文本），搜索/阅读优先读它。
- 键：8 位，字符集 `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`（无 0/1/O/I）。

## WebDAV（Zotero 文件同步协议）

- 目录：`<配置 URL>/zotero/<key>.zip`；验证 = OPTIONS(DAV) + PROPFIND(zotero/) + GET 不存在文件必须 404 + PUT/GET/DELETE `zotero-test-file.prop`。
- 上传：先 DELETE `<key>.prop`，再 PUT zip（storage 目录整体压缩，含 `.zotero-ft-cache`）。
- 判定：`storageModTime` 为同步锚点；本地 mtime 更新 → 上传；远端 `getlastmodified` 更新 → 下载；两者都变 → `syncState=3`（冲突）。同步成功后 `storageModTime=Date.now()`、`storageHash=md5(zip)`。
- 删除：读 `storageDeleteLog` → DELETE 远端 `<key>.zip`/`.prop` → 清日志。
- 凭证只存 `$DSH_HOME/library/settings.json`（明文）；Zotero 客户端的 WebDAV 密码在系统登录管理器里，无法读取，需用户重填同一套凭证。

## 验证

1. `npm run build`（client.js 与 vendor/deps.js 都是产物，必须提交；client.js 内含 pdf.js 引擎——查看器走 pdf.js **主线程模式**，无需 worker 资源）。
2. `npm run check`：
   - `scripts/host-smoke.mjs`：复制真实 `zotero.sqlite` 到临时目录，mock ctx 驱动 API 通道：state/collections/items/item、搜索、创建/更新/回收站/永久删除、分类增删改、PDF 导入（全文 + 显式元数据父条目）、双击打开的附件路径解析回归、`library_read` search、cite 导出、chat 上下文前缀（list/item/reader）、批注 CRUD 回环、设置、`setup` 独立文库创建/写/导出/切回、更新状态、工具 schema 门禁（禁 inline required）、disposer。
   - `scripts/webdav-smoke.mjs`：本地 mock DAV 服务器验证 OPTIONS/PROPFIND/上传/远端更新下载/远端删除/错误凭证。
   - `scripts/client-smoke.mjs`：jsdom + 真实 React 18 挂载 `client.js`，断言三分栏、条目行、列选择器、详情、文献助手 dock 打开 → retain 会话 → SessionProvider 内渲染 `library.chat.area`（原生对话区，不自绘转录）、拖入导入 → 「AI 补全元数据」→ chat-send 携带 context、库内查看器标签页打开（pdf.js 主线程解析真实 fixture：页占位尺寸 + 页数；jsdom 不能画 canvas，须先给 `globalThis.DOMMatrix` 打桩）、批注行加载 + 覆盖层渲染、旋转当前页（页盒纵横比交换）、查找条打开，常驻标签条、设置分区页独立挂载（标签切换 + settings-set），左侧栏入口切换。
3. `node scripts/reader-e2e.mjs [sample.pdf]`：真 Edge 加载真实 `client.js`，走 UI 打开 PDF，断言：canvas 真实像素绘制、工具栏放大（页盒变宽且位图重栅格化）、适应宽度（页盒回到滚动列内容宽）、**缩小后页面列居中**、页码跳转（多页样本）、选区→弹窗（钳制在查看器内）→高亮（annotation-create 落库 + 覆盖层渲染 + 上半区可选中/热区在下条的交互分离）、全文查找（文本层高频词→计数→首匹配自动滚动入视区→下一处且当前标记在视区内）、旋转当前页（纵横比交换并复原）。改查看器必跑（fixture 1 页 + 一篇真实论文各一次；fixture 无文本时选区/查找自动跳过）。e2e 的 mock 对每个响应做深拷贝——真实宿主每次 JSON 解析都是新对象；若 mock 直接回传同一引用，`setAnnotations` 会因 React 同引用 bail-out 被吞、覆盖层不刷新。
4. `npm run bench`（或分别跑）：
   - `scripts/pdf-open-bench.mjs [sample.pdf]`：打开路径计时（点击→字节→canvas 挂载→首像素→缩放重栅格化→跳末页着色）+ 主线程 long-task 统计。
   - `scripts/pdf-pages-bench.mjs [sample.pdf] [--back]`：逐页跳转→着色计时（前向 + 可选回程；长文档自动抽样 ≤40 页）。现用于监控 pdf.js 主线程渲染吞吐。
5. 真机验证：安装到 dsh profile → 重启 → 左侧栏底部「文库」→ 首开选择关联/独立 → 打开浏览器控制台看错误；拖一个 PDF；双击打开（pdfOpen=builtin 时进库内 pdf.js 标签页，验证缩放/跳页/选择/批注/查找/旋转；pdfOpen=native 时由系统阅读器打开）；配置 WebDAV 点「验证连接」；文献助手发一条消息看前缀生效与 ↗ 跳转。

## 文库模式与文献助手（关键设计）

- **文库模式**：`settings.mode` ∈ `unset|zotero|standalone`。`unset` 时 `paths()` 抛 `library/needs-choice`（显式 `zoteroDataDir` 覆盖除外），浏览器显示首开选择页；`setup` 端点切换并即时建库。standalone 库在 `$DSH_HOME/library/data/`（`zotero.sqlite` schema 130 + storage/），由 `standalone.js` 用 `userdata-sql.js` DDL + `schema-data.js` 种子创建，同一 `ZoteroDb` 引擎读写。
- **文献助手上下文前缀**：仅 `chat-send` 携带 `context`（`{mode:'list'|'item'|'reader', itemKey?, itemTitle?}`）时，`chat.js#contextPreamble` 在用户消息前拼「摘要优先 / `library_read` search 优先」的中文前缀；原生 dsh 对话（不经过 dock）永远不注入。`reader` 模式由库内查看器标签页驱动：打开 PDF 会经 `chat-context` 推送到宿主 guidance（防抖），问话天然带上下文。
- **列定制**：可见列存 `localStorage['dsh-library:columns']`（标题列固定）；宿主 `readItems` 额外返回 `publicationTitle/publisher/tags/firstCreator`，排序白名单含 `creator`。
- **PDF 打开方式**：`settings.pdfOpen` ∈ `builtin`（dsh 内建查看器：**库内 pdf.js 标签页**，字节走 `GET api/library/file` 流式路由，x-library-* 响应头带附件/父条目/标题；带选择文本→高亮/下划线/批注（Zotero 行，不写文件）、旋转当前页、全文查找；页列 `max-content + margin auto` 居中，缩放超出视口才左对齐滚横）| `native`（系统阅读器，走 `open` 端点）。不要再用 `window.open`——dsh 桌面壳（Electron）的 `setWindowOpenHandler` 一律 deny 并把 http(s) 转交 `shell.openExternal`，`window.open` 恒返回 null，旧 builtin 的「新窗口」只能落到系统默认应用。
- **设置 = dsh 原生 `settings.section`**：`src/client/index.js` 注册 `{name:'settings.section', id:'library', order:60, label:()=>'文库'}`，页面在 `settings-section.jsx`（SegmentedTabs 分四页：数据来源 / PDF 与导出 / WebDAV 同步 / 更新；控件全部用 dsh 原子组件，行样式用 `--dsw-*` 令牌——该页在 dsh 模态内渲染，**在 `.dsh-library-root` 外**，别用 `--lib-*` 变量）。保存后派发 `dsh-library:settings-saved` CustomEvent，library-page 监听刷新 snapshot。打开面板：shell 未公开 openSettings 服务，齿轮按钮**合成 settings.open 快捷键事件**（`ctx.inject(['shortcuts'])` 后从 `catalog` 解析当前绑定，尊重用户改键；不可用时按平台回退 Ctrl+, / Cmd+, / Ctrl+Alt+,）。
- **界面状态持久化**：列表视图/排序 `localStorage['dsh-library:view'|'dsh-library:sort']`（选中分类随 view 恢复）；分类树**展开状态** `dsh-library:collections-expanded`（CollectionsPane 挂载即写回；选中分类变化时自动展开其祖先链，恢复场景才不会埋在折叠根下）。
- **布局约定**：标签条**常驻中栏**（`.lib-midcol` 首行，永远渲染「文献列表」tab，打开 PDF 只追加 tab），布局有无 PDF 完全一致，标签不横跨左列；左列底部「回到对话模式」**常显**（进入文库仍会自动收起宿主对话侧栏，离开时恢复，但不再轮询侧栏可见性）。
- **引用/Office 预留**：`cite-json`/`cite-bibtex` 通道端点与 `library_cite` 工具共用 `cite.js`（CSL 映射来自 `schema-data.js` 的 `csl.{types,fields,names}`）；设置页导出即同一接口，Word/LibreOffice 插件直接复用。

## 陷阱清单（已踩）

1. **嵌套事务**：`db.transaction()` 不可嵌套；`createItem`/`insertAnnotation` 自身不再开事务，由调用方决定。
2. **schema 列差异**：见上；`PRAGMA table_info` 缓存随连接重建。
3. **`main` 面板不是定位容器**：根元素用 `position:relative; flex:1; height:100%`，不要 `position:absolute; inset:0`（否则会覆盖整个窗口）。
4. **`useSyncExternalStore` 要求稳定快照**：`ctx.layout.panelInfo.getSnapshot()` 返回缓存对象；自建 mock 必须同样稳定，否则无限重渲染。
5. **批注坐标**：存储统一用 **PDF 用户空间**（左下原点，y 向上）；宿主提取（unpdf）与查看器选区入库同系；`sortIndex` 的 top 用 `pageHeight - rect[3]`。屏幕/选区矩形 ↔ PDF 空间的全部换算只走 `pdf-util.js` 的页矩阵（见陷阱 15），别处不要自己算 PDF 系数学。
6. **工具 schema 必须线上安全**：`parameters` 原样进模型 API，只允许 `type/properties/required/items/additionalProperties/enum/const/description/title`；requiredness 只在父级 `required` 数组。
7. **中文文案**：插件 UI 直接中文；不要引入未声明的 locale 依赖。
8. **Windows 打开文件**：用 `explorer.exe <path>`（ShellExecute），不要 `cmd /c start`（会二次解析 & 等特殊字符）。
9. **Node 24/win32 `fs.rmSync` 原生崩溃**：对**文件**调用 `fs.rmSync`，文件名含某些非 ASCII 字符（如 Zotero 命名「Li 等 - 2024 - ….pdf」）时进程直接段错误退出（无异常可捕获）；`unlinkSync`/`rmdirSync` 正常。所有删除必须走 `safeUnlink()`/`safeRemoveTree()`（`src/host/util.js`）。同理 **不要用 `fs.watch({recursive:true})`** 监视 storage（删除事件路径相同），`watcher.js` 是 stat 轮询，保持轮询。
10. **`readItem` 的 `attachments[]` 子项不带 `target`**：只有顶层附件的 `detail.attachment.target` 已解析；其余场景（双击打开、工具打开）必须自行调 `attachmentTarget(storageDir, key, rawPath, linkMode)`（`runtime.openRecord` 即此前双击打不开的根因）。
11. **jsdom+React 18 冒烟测试不派发 `input`**：`setNativeValue+Event('input')` 与 `TestUtils.Simulate.input` 都不触发 onChange（React input polyfill 在 jsdom 29 下崩）；需要文本输入的用例改走其它路径（如拖入导入 → 命令式 `openAndSend`）。
12. **插件必须经 `plugin_manager install_bundle` 安装**：若把 `- insert: [id: library]` 手工并进 profile 的 `cordis.patch.yml`，该块不属于任何 bundle 层——「停止/卸载」都动不了它，插件会变成卸不掉、停不掉的僵尸（`include:library` 恒为 active）。修复 = 从 profile patch 删掉该 insert 块与 `- id: library disabled` 覆盖行、删除 `node_modules/dsh-library` 链接，再 `install_bundle` 重装（bundle 层由安装器拥有，停止/卸载/重装随即恢复正常；toggle 立即经 HMR 生效，无需重启）。
13. **pdf.js（库内查看器）**：用 `pdfjs-dist@4`（v5/v6 的 worker `fingerprints` 依赖 `Uint8Array.prototype.toHex`，Node 24 没有该方法，冒烟直接炸；v4 对 Chromium/Node 都稳）。主线程模式 = 把 `pdf.worker.mjs` 的 `WorkerMessageHandler` 挂到 `globalThis.pdfjsWorker`——pdf.js 检测到该钩子就**完全不创建 Worker**（桌面壳禁 Blob Worker、主窗口也没开 `plugins`，iframe/嵌 PDF 一律不可行）。pdf.js 在 import 时就 `new DOMMatrix()`，jsdom 冒烟必须先打桩。滚动容器的 fit 宽度要扣掉 `.lib-pdf-scroll` 左右各 9px 内边距（clientWidth 含 padding）。真浏览器测试壳必须 `html,body,#app{height:100%}`，否则滚动容器被内容撑满不可滚动（`scrollTop=scrollHeight` 无效）。
14. **platform.jsx 与冒烟桩必须同步**：client-smoke 对 `@deepseek-ai/dsh-client-ui-primitives` 的桩只提供 platform.jsx 实际 re-export 的原子组件——给 platform.jsx 增加导出而不补桩，设置分区一挂载就报 "Element type is invalid"。**settings.section 的 `label` 是注册选项**（`() => string`），区块组件会额外收到 shell 注入的 `close`；`SegmentedControl` 必须传 `id` + `label`。
15. **查看器文本层自绘、不用 pdf.js 的 `TextLayer`**：pdf.js TextLayer 的 span 以**未旋转原始页面空间的百分比**定位、容器固定为原始页盒（`setLayerDimensions` 不翻转），旋转只能靠容器 CSS transform——无法干净地支持**每页独立 UI 旋转**，且 jsdom 下其 canvas 测宽路径直接抛错。因此 `pdf-util.js#buildTextSpans` 复刻其算法但**直接用自算页矩阵（含固有 /Rotate + 每页 UI 旋转）输出 CSS px**，并用 `viewport.convertToPdfPoint` 的逆矩阵（`makePageMatrix` + `rectToPdf`）把选区矩形转回 PDF 用户空间。文本层、批注覆盖层、查找标记、选区→批注换算四者必须共用同一矩阵（`pdf-util.js`），旋转后才会仍然对齐。文本层 span 依赖 canvas `measureText` 做 scaleX 校准（jsdom 无 2d context 时跳过、仅丢选择不丢渲染）；页离开视口即 `replaceChildren()` 释放 span，回来由 LRU 缓存（`pageDataOf`，24 页）重建。选区矩形要**按显示行合并**（`pdf-util.js#mergeLineRects`，≥50% 垂直重叠）并**裁剪到锚点页内**——拖拽越过行尾/栏宽时浏览器按文档序级联延伸选区，逐 span 的 `getClientRects()` 会返回几百个碎片。

## 发版

改码 → bump `package.json` **和** `index.js` 的 `version` → `npm run build` → `npm run check` → `npm run manifest` → 提交（含 `client.js`、`vendor/deps.js`、`feed/manifest.json`）。用户设置更新源后可在「文库设置 → 更新 → 检查/安装更新」在线升级；安装后重启 dsh 生效。
