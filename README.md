# dsh-library

一个面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的第三方插件：把 **Zotero 文库**搬进 dsh——左侧栏底部一键切换到 Zotero 风格的整页图书馆，直接读写你现有的 `zotero.sqlite`（没有 Zotero 也能用独立文库），支持拖放导入与元数据自动补全、系统阅读器打开 PDF、批注回写、WebDAV 文件同步，以及一个悬浮于列表之上的「文献助手」对话窗口（在专属 Library 工作区里运行完整 dsh agent，可调用文库读写工具，也可一键跳到 dsh 原生对话界面）。

> 插件遵循 dsh 插件规范（`dsh.bundle.patch` + `dsh.client` 双半身），浏览器半身为手写 ModuleLoader bundle（源码 `src/client/` 经 esbuild 生成 `client.js`），宿主半身零 `@deepseek-ai/*` 运行时依赖。

## 功能

| 能力 | 说明 |
|---|---|
| 整页图书馆视图 | 左侧栏底部「文库」入口；主栏切换为三分栏：左=分类树/标签/回收站，中=文献列表，右=选中文献详情 |
| 关联或独立 | 首次打开会询问：关联本机 Zotero（自动定位 `zotero.sqlite`，完整读写条目/分类/标签/作者/附件/笔记/批注），或使用**独立文库**（按 Zotero schema 130 规范存放在 dsh 数据目录，随时在设置里切换或导出迁移到 Zotero） |
| 写入 Zotero 数据库 | 新建条目、编辑字段/标签/分类、回收站/还原/永久删除；写入 `synced=0`，Zotero 自身的同步会正常上传 |
| 拖放导入 | 把 PDF 拖到列表即导入：复制进 `storage/<key>/`、创建附件、按文件名/正文中的 DOI、arXiv、ISBN 或 Crossref 题名检索补全元数据；检索失败或不完整时导入卡提供「**用 AI 补全元数据**」，一键把任务交给文献助手（联网核对并写回字段） |
| 双击打开 | 优先打开 PDF 子附件，用系统默认阅读器；附件文件 mtime 变化会被轮询监视，自动刷新全文缓存并把 PDF 中新增的批注回写为 Zotero 原生批注记录 |
| 批注 | 读取 `itemAnnotations`（高亮/下划线/笔记/墨迹/文本），右侧按颜色与页码展示；外部阅读器新增的批注以 `isExternal=1` 导入 |
| 列表列定制 | 表头右侧「列」按钮增删列（标题/创建者/年份/期刊/出版社/DOI/标签/条目类型/添加时间/修改时间），标题、创建者、年份、添加/修改时间可点击排序，偏好持久化 |
| WebDAV 同步 | 完整实现 Zotero 的 WebDAV 文件同步协议：OPTIONS/PROPFIND 验证、`zotero/<key>.zip` 上传下载、`.prop` 标记、`storageDeleteLog` 删除同步，可与 Zotero 客户端共用同一台 WebDAV；独立文库同样可用 |
| 文献助手 | 悬浮于文献列表之上的对话 dock：平时只占底部一行，点开即浮出面板；消息发送到专属 **Library 工作区**的 dsh 会话，具备完整对话/工具能力，可用 ↗ 一键跳到 **dsh 原生对话界面**继续；对话结束自动刷新文库 |
| 提示词注入 | 仅文献助手的消息附带上下文前缀：优先用 `library_search`/`library_item` 从标题、摘要等元数据回答，需要全文时优先用 `library_read` 的 `search` 参数定位而非通读；正在查看某篇文献时自动告知 agent（内置阅读器场景已预留 reader 模式）。原生 dsh 对话不受影响 |
| 引用导出 | `cite-json`/`cite-bibtex` 通道端点与设置页一键导出 **CSL JSON / BibTeX**（Zotero「导入…」可直接读取） |
| Word 引文插件 | **完全重写、完整移植 Zotero 文字处理集成**：Zotero 兼容命令（插入/编辑引注、插入参考文献表、编辑参考文献表、文档设置、刷新、移除域代码、查看引注、导出文档）、Zotero 兼容域代码与文档数据、citeproc 排版、引文对话框（气泡/文献列表按关键词检索/默认文献库按分类浏览（分类数字=实际列出条目数）/输入关键词自动切到文献列表/已选中条目高亮/定位符/前缀后缀/实时预览）、参考文献编辑、样式在线检索安装。**插入/编辑引文后自动重算全文引注与参考文献表**（无需手动刷新；文档设置里仍可开启「延迟更新」提速大文档）。功能区 7 个中文命令按钮：「插入参考文献表」在文档已有参考文献表时自动置灰（改用「编辑参考文献表」）。**与 Zotero 相同的一键安装**：随插件分发预构建的 `DshLibrary.dotm`（内含 VBA 工程与功能区），点击安装只是把文件复制到 Word 的 STARTUP 启动目录，不调用 Word、不需要管理员；安装器会解包自检模板完整性并检测 Word 是否正在运行。完全退出并重启 Word 后出现「文库引用」选项卡。引文对话框在弹出的**独立无边框小窗口**中显示（不是浏览器标签页，且自动置顶，Word 最大化时也不会被遮住），确定/取消自动关窗；功能区与对话框按钮均为中文，7 个引文相关命令配自绘图标与相邻「?」帮助按钮（与命令同行成对排列，悬停显示功能说明，点击弹出完整说明） |
| Agent 工具 | `library_status/search/item/read/annotations/collections/add/update/import/open/sync/cite/trash` 十三个工具，任何 dsh 会话都能阅读、检索、修改、总结文库并导出引用 |
| 黑夜模式 | 全部颜色走 `--dsw-alias-*` 令牌并以 `body[data-ds-dark-theme]` 探测的暗色回退兜底；工具栏/对话框采用 dsh 原生 Button 原子组件 |
| 安全 | 首次写入前自动备份 `zotero.sqlite`（保留最近 3 份）；修改前无需关闭 Zotero，但建议关闭以避免锁冲突 |
| 在线升级 | `feed/manifest.json` + SHA-256 校验 + 备份回滚的自升级接口（设置中填写更新源；默认关闭） |

## 安装

插件以普通 dsh bundle 安装（与 `dsh-mol-structure`、`ds-bot` 相同）：

1. 在 dsh profile 的 `package.json` 中加入依赖（示例为本地路径安装）：
   ```json
   {
     "dependencies": { "dsh-library": "file:C:\\path\\to\\dsh-library" },
     "dsh": { "profile": { "bundles": ["…", "dsh-library"] } }
   }
   ```
2. 在 profile 目录执行 `npm install`（或 pnpm）。
3. 重启 dsh 桌面端/网页端。

也可以直接用应用自带的 dsh CLI（会同时写入依赖与 `dsh.profile.bundles`）：

```sh
dsh plugin --profile desktop add "file:C:\path\to\dsh-library"
```

或在 dsh 里让 agent 通过 plugin manager 安装本目录。

## 使用

- **进入文库**：左侧栏底部「文库」按钮（与设置按钮同排）。再次点击或切换到其他面板即返回对话。
- **首次打开**：选择「关联本机 Zotero」或「使用独立文库」（也可稍后在设置里切换/手填数据目录）。
- **浏览**：左栏点分类/标签；中栏点选条目（Ctrl/⌘ 多选、Shift 连选），双击打开 PDF；表头「▾」按钮增删列、点击表头排序。
- **导入**：把一个或多个 PDF 拖进中栏；导入卡显示进度与检索到的标题。导入到当前选中的分类；元数据不全时点「用 AI 补全元数据」交给文献助手。
- **编辑**：右侧详情可直接点击字段编辑；标签可增删；「＋ 加入分类」归档。
- **对话**：中栏底部「文献助手」一行点开即浮出对话面板；Enter 发送、Shift+Enter 换行；「＋」开新对话；↗ 跳到 dsh 原生对话界面。
- **同步**：工具栏「同步」使用设置中的 WebDAV 配置上传/下载附件。
- **导出**：设置 → 导出，下载整个文库的 CSL JSON 或 BibTeX。
- **设置**：工具栏齿轮：数据来源（关联 Zotero / 独立文库）、Zotero 数据目录、WebDAV 地址/账号/密码、每 30 分钟自动同步、插件更新源。

## 与 Zotero 并存

- 本插件直接操作 Zotero 的本地数据库与 `storage/` 目录；Zotero 运行时会持有数据库连接，写入偶发 `SQLITE_BUSY`（已设置 4s 重试），大规模整理建议关闭 Zotero。
- Zotero 的**元数据同步**（api.zotero.org）仍由 Zotero 客户端负责；本插件的 WebDAV 只同步**附件文件**，与 Zotero 的「文件同步（WebDAV）」完全兼容。
- Zotero 在内存中缓存数据库内容，本插件的修改会在 Zotero 下次启动/重载时可见；反向地，Zotero 中做的修改在 dsh 中最多 5 秒（列表轮询）后可见。
- 外部 PDF 阅读器新增的批注导入为只读（`isExternal=1`），与 Zotero 导入外部批注的语义一致。

## 已知边界（v1）

- 不实现「保存的检索（saved searches）」与 Zotero 的同步元数据（API key）流程。
- 批注导入以 PDF 内嵌注释为准；Zotero 阅读器内新增的批注本来就直接写入数据库，插件会直接读到。
- 群组文库可读，写操作默认面向用户文库（libraryID=1）。
- 附件类型中仅 PDF 做全文/批注提取，其它类型仍可导入、打开与同步。

## 开发

```sh
npm install
npm run build      # src/client → client.js；tools/vendor-entry → vendor/deps.js
npm run check      # 语法 + 宿主/办公集成/浏览器/WebDAV 四个冒烟测试
npm run manifest   # 生成 feed/manifest.json（发版用）
```

冒烟测试会复制本机真实 `zotero.sqlite` 到临时目录后读写，不会触碰原库；无 Zotero 时自动跳过数据库用例。

## 目录

```
index.js                宿主半身入口（cordis 插件）
src/host/               Zotero 数据层、WebDAV、导入流水线、工具、对话、升级器
src/host/office/        Word 引文集成（Zotero integration.js / 对话框 / HTTP 协议 / 安装器）
src/client/             浏览器半身（React + JSX，esbuild 打包）
assets/csl/             种子 CSL 样式与本地化（zotero.org + CSL locales 官方仓库）
assets/word/            Word 端 VBA 与 Ribbon（安装器打包为 .dotm）
vendor/deps.js          fflate + unpdf/pdf.js 的离线打包（零 npm 运行时依赖）
vendor/citeproc.js      Zotero 官方打包的 citeproc-js
tools/                  构建脚本
scripts/                冒烟测试
feed/manifest.json      自升级清单
```

## License

MIT
