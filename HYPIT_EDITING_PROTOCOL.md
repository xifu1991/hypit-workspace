# Hypit 剪辑防错协议

这是视频剪辑任务的工作记忆，不是另一个剪辑软件，也不替代 Hypit Runtime。

## Playbook 总门禁

1. 任何新建、修改、重剪或交付任务开始前，先读取 `playbook/PLAYBOOK.md` 和 `playbook/playbook.json`，并运行 `node playbook/validate.mjs`。
2. 按 `选题 -> 参考 -> 素材 -> 编排 -> 组件 -> 动效 -> 检查 -> 发布复盘` 的顺序执行。不得用聊天记录代替阶段文件，不得跳过前一阶段门禁。
3. 每条视频工程使用 `playbook/templates/` 建立 `brief.json`、`reference.json`、`material-plan.json`、`shotbook.json`、`component-plan.json`、`qa.json` 和 `retrospective.json`。
4. 已有阶段文件时运行 `node playbook/validate.mjs --project <工程目录>`。shotbook 必须帧区间连续、无重叠，组件必须能追溯到组件库版本。
5. 只有 `qa.json` 的全部阻断项通过、`finalVerdict` 为 `pass`，并指向真实且非空的成片文件时，才能标记为可发布。

## 风格库复用

1. 收到参考视频后，先计算源文件 SHA-256，并在 `style-library/index.json` 中查找相同指纹；命中后直接读取对应版本的 `analysis/style.json`、`ANALYSIS.md` 和 `TIMELINE.md`，不得再次转写或重复拆片。
2. 风格库位于工作区的 `style-library/<style-id>/<version>/`，与 Hypit 源码和单条视频工程分开保存。参考视频、音频、逐字稿、分析、证据帧和预览都属于不可变版本内容。
3. `status` 必须如实记录：`draft` 是整理中，`analyzed` 是已完成参考分析但尚未用真实成片验证，`verified` 是已经通过真实素材替换和渲染验收，`retired` 是停止复用。不得把 `analyzed` 冒充 `verified`。
4. 风格命中只复用语义结构、画面比例、节奏、字幕和花字层级；不得自动复用参考中的品牌、文案或未授权素材。
5. 对当前影片的修改默认只影响当前工程。只有用户明确确认后，才能创建风格库新版本；已有工程继续绑定原版本，不静默漂移。

## 本次剪辑风格选择

1. Studio 左侧风格栏中的复选框会把用户勾选的风格写入工作区根目录的 `HYPIT_STYLE_SELECTION.json`。
2. 用户说“按已选风格剪”“用当前勾选风格”或类似指令时，先读取该文件，再读取每个已选风格的 `analysis/style.json`、`ANALYSIS.md` 和 `TIMELINE.md`。
3. 只执行已勾选风格，不自行加入未勾选风格。若文件为空，先说明没有勾选记录，不得从聊天历史猜选。
4. 勾选记录是本次剪辑的选择清单；风格库条目的版本内容仍保持不可变。

## 组件库复用

1. 组件库位于 `component-library/index.json`，记录标题、字幕、转场、版式、贴纸和场景块的版本、状态、授权与证据。
2. 正式交付只能使用状态为 `verified` 的组件。`planned`、`draft`、`analyzed` 只能用于探索或工程预览，不能进入可发布成片。
3. `component-plan.json` 必须记录每个镜头使用的组件 ID、版本、覆盖值、素材替换和许可。组件不存在时先登记并验证，不把一次性代码散落在工程里。
4. HyperFrames 官方 Registry、动态标题、嵌入式字幕和转场目前按登记状态使用；没有当前素材的真实渲染证据时，不得写成已验证。
5. 组件的品牌、字体、商标和素材授权必须逐项检查；结构可以复用，未授权资产不能随成片交付。
6. 涉及 overlay composition 的组件，在登记为 `verified` 之前必须跑通 `hyperframes lint` 与 `hyperframes inspect`（0 error、0 warning、0 layout issue），并把结果和字体、依赖等已知限制写进组件证据与工程 `qa.json`。

## 参考锁定

1. 用户指定的参考视频是本次任务唯一的风格母稿。
2. 开始前必须先看参考视频的抽帧和时间结构，记录：开场方式、镜头比例、字幕位置、转场、产品出现时机和结尾节奏。
3. 禁止把上一次任务的 SVS、style-board、字幕模板或黑底开场自动复用到新任务。
4. 如果新参考和旧参考明显不同，旧模板必须标记为“拒绝复用”，不能只改标题继续交付。

## Hypit 工程边界

1. 使用 Hypit 的 SVML/SVS/SVRUN 和 Studio；不再切换到已删除的旧本地任务流程。
2. 真实视频必须进入真实媒体轨道；静态抽帧只能用于风格分析或 Studio 降级预览，不能冒充成片。
3. 字幕、花字、转场、B-roll 必须是独立可编辑层；预览里必须能看到对应轨道或明确说明缺失。
4. Studio 显示的是工程预览，MP4 必须来自实际渲染产物；SVML/SVS 不能当 MP4 发给用户。
5. 需要词级语音对齐时，Studio 默认使用豆包录音文件识别 2.0；临时音频必须在上传前说明，并在任务结束后从 TOS 删除。

## 交付门禁

交付前逐项确认并记录：

- `playbook/validate.mjs --project <工程目录>` 通过，`qa.json` 没有未解决的阻断项且结论为 `pass`。
- 正式使用的组件均为 `verified`，或在交付说明中明确标记为探索版本并禁止发布。
- 参考风格与本次预览逐段对照，不得沿用旧版视觉语言。
- 原视频音频是否保留、字幕是否与口型同步。
- 用户提出的开场限制是否实际满足，例如前 3 秒不出现桌面产品。
- MP4 能播放、时长和画幅正确，且不是静音技术底片或静态图拼接假视频。
- overlay composition 交付前跑过官方校验：`hyperframes lint` 为 0 error / 0 warning，`hyperframes inspect` 为 0 layout issue；媒体引用全部落在项目根内，缩放与位移只用 `transform`。
- Studio URL、工程文件和 MP4 路径分别说明用途。
- 任一门禁未通过时，状态只能是“工程预览/待修复”，不能称为完成或成片。

## 错误记录

每次发现偏差都记录：现象、根因、修复、防回归检查。若属于流程缺口，同步更新 `playbook/playbook.json`、`playbook/PLAYBOOK.md` 或组件库，而不是只留在聊天里。下一次新任务开始前先读取本文件和用户指定的参考，不得重复旧模板泄漏、静态预览冒充真实视频、或把错误端口/旧工程发成新版。
