# Hypit 风格库接入检查

## 第一版实施进度（2026-09-23）

- 已建立工作区风格库 `style-library/`，首个存档为 `armani-yulong-clean-talk@0001`，状态如实保持为 `analyzed`。
- 已确认 `2104598920.mp4` 的 SHA-256 为 `B8907913C7CED5ED901815D68750C08272EC7DAC762B6A4E9AAFD3E871954DE5`，并复用之前保存的豆包 `volc-seedasr-2.0` 逐字稿与两组抽帧证据，没有重复付费转写。
- Studio 已增加“风格”标签页，可读取风格摘要、版本、时长、画幅、帧率、ASR、分析、时间结构、证据帧、参考视频和逐字稿。
- 已新增只读接口：`/__studio/style-library`、`/__studio/style-library/detail`、`/__studio/style-library/asset`。
- 当前版本是风格浏览与复用档案第一版。把所选风格绑定到工程、实例化模板和自动生成 SVML 工程仍属于下一阶段。

检查日期：2026-09-22。范围：定位当前本地 Studio、工程保存和扩展接入点。本阶段未改动运行中的界面、工程或启动进程。

后续修复（同日）：4317 已改为 latest-video.svrun，位置为 examples/style-clone-0919-reference137。
新工程把最新的 20 秒成片恢复成 7 个视频片段与 7 个对应原声片段；字幕/花字仍烧录在视频内。
start_studio_4317.ps1 已更新默认 Run、媒体工具 PATH 和端口工程检查。下文“当前”均指首次检查时的历史状态。

## 已核实的运行状态

- 页面：`http://localhost:4317/#studio`，HTTP 首页返回 200，标题为 Hypit Studio。
- 源码目录：`C:/Users/admin/Documents/视频制作/hypit-local-demo`。
- 本地包版本：0.1.13；Git HEAD：`1ccf831`。版本号用于记录本次检查，不代表上游最新版本。
- 检查时监听进程 PID：12524；使用 Node 执行 `bin/hypit.mjs studio`。
- 当前 workspace：`hypit-local-demo/examples/style-clone-1328770777`。
- 当前 Run：该目录的 `style_clone.svrun`，Author 为 `style_clone.svml`，引用 `style_clone.svs`。
- HTTP `/__studio/session` 确认当前 Source 为 `style_clone.svml`，revision 为 1，文件闭包包含上述三个文件。
- 当前 Author 明确标注参考 `2104598920` 的黑底、圆窗、产品近景和花字节奏；30 秒、720×1280、30fps。
- 当前主轨道为自定义 `styleboard:Board`，传入 open/product/face/circle/notes/final 六个 JPG。此工程是旧的图片风格展示，不能作为真实视频轨道模板直接批准入库。
- 启动脚本 `start_studio_4317.ps1` 固定使用上述旧 Run；若 4317 已被占用则直接退出，不校验所服务工程。这是工程身份容易混淆的一个具体位置。

## 源码接入位置

路径以下均相对于 hypit-local-demo。

| 功能 | 已有入口 | 后续接入方式 |
| --- | --- | --- |
| Studio 启动、工作区、插件注册 | `packages/studio/start.ts` | 注册独立风格库服务，显式配置跨工程的库路径；保留当前工程边界 |
| 顶部工程标题和主布局 | `packages/studio/src/ui/main.ts` | 展示当前素材、风格名称与版本，避免只显示通用文件名 |
| 左侧源文件/任务/产物导航 | `packages/studio/src/ui/library.ts`、`sidebar-panel.ts` | 增加风格卡列表和详情；空库显示待添加，不生成虚假的已验证风格 |
| 样式与中文文案 | `packages/studio/src/style.css`、`locales/zh-CN.json`、`locales/en.json` | 复用现有界面结构和语言系统 |
| 工程快照、保存、时间线编辑 | `packages/studio/src/server.ts`、`ui/writeback.ts` | 使用已有 revision 冲突检查与白名单校验，将模板实例保存为工程源文件 |
| 多文件写回 | `packages/studio/src/source-transaction.ts` | 参考现有临时文件与失败恢复机制；新建文件/目录仍需独立实现 |
| 时间点评论 | `packages/studio/src/ui/comments.ts`、`feedback-server.ts`、`feedback-store.ts` | 复用 FEEDBACK.json，新增修正记录和明确的应用范围 |
| 渲染任务执行 | `packages/cli/src/main.ts` 的 build 分支，最终调用 `runtime.build(request)` | 后续任务服务复用现有执行链；风格/素材绑定检查放在任务提交前 |

已核实的 HTTP 接口：

- `GET /__studio/session`：当前 Run 的编译快照。
- `PUT /__studio/source`：保存当前允许编辑的 Source 文件，检查 revision。
- `POST /__studio/mutation`：参数或时间线修改。
- `GET /__studio/library`：读取任务和产物。
- `GET/POST /__studio/feedback`：读写当前 Run 的时间点评论。

当前检查到的服务路由没有风格库、切换工程、上传新素材或提交剪辑任务的专用接口。Tasks 是任务查看入口，不能直接当成已存在的任务提交功能。

## 可复用的能力与缺口

- Studio 已把编辑写回 SVML/SVS/SVRun；不需要另建一套脱离渲染的时间线数据。
- FEEDBACK.json 已支持评论 ID、Run、时间点、文字、解决状态，以及并发修改冲突检测。本次读取的 Run 有 0 条评论。
- 评论保存与 Agent 通知尚未连接；后续要显式实现任务触发，不能把“已保存评论”显示成“已开始修改”。
- 当前工作目录有 `HYPIT_EDITING_PROTOCOL.md`，包含旧模板泄漏、图片冒充视频、交付格式和验收约定；未在本次工作目录搜索到 AGENTS.md 或 .learnings 档案。此结论不覆盖其他目录。
- Hypit skill 已有文件记忆、参考分析、工程保存与成片检查要求；仍需把选中的风格及相关纠错按任务传入，不能假定聊天记录是唯一数据来源。
- 源码已有用户改动：pnpm-lock.yaml，以及若干未跟踪的视频工程和 FEEDBACK.json。实施时保留这些改动。

## 建议的数据与任务约定（待实施）

共用风格库存放于视频制作工作区，与 Hypit 软件源码和单条视频工程分开：

`style-library/<style-id>/<version>/` 保存风格说明、参考指纹、分析、预览小样、可执行模板与相关修正规则；索引只保存名称、摘要、版本和预览路径。

每个视频工程的任务记录固定以下内容：

- 素材地址及指纹。
- 所选风格 ID、不可变版本号、模板指纹。
- 目标时长和本片特殊要求。
- 对应 Run、输出位置和验收状态。

修改默认只作用于本片。用户选择“保存为风格新版本”后，才将验证过的修改纳入模板。通用错误规则单独存档；旧工程继续绑定原版本，可主动升级，不静默漂移。

新素材仍需读取、转写或分析；节省的是重复参考片分析和重复编写样式。已有模板及产物尽量复用，只加载选中风格和相关纠错。

## 后续最小实现顺序

1. 风格库持久化、风格卡界面、当前工程与所选版本的明确显示。
2. 从确认满意的真实视频工程建立第一个模板，验证素材可替换、各层可编辑，保存分析和小样。
3. 工程生成与任务执行接入，提交前核对风格和素材绑定；切换工程需同步服务端会话，不能只换前端标签。
4. 时间点反馈连接修正任务，区分本片修改与风格版本更新。
5. 加入模板选择、错工程绑定、版本隔离、并发保存等必要检查；视觉和声音质量另做实际视频验收。

本次检查没有提交渲染、语音转写或付费生成。下一阶段应实现界面和持久化；当前旧图片展示不自动成为用户认可的第一个模板。
