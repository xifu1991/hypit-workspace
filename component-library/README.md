# 组件库

组件库记录标题、字幕、转场、版式、贴纸和场景块的可复用能力，不把一次性工程代码当成组件。

## 状态

- `planned`：已确定需要，但还没有实现或接入。
- `draft`：已有实现，仍在开发。
- `analyzed`：已读懂来源、接口和许可，但还没有用当前素材完成验收。
- `verified`：已有版本锁定、真实渲染产物和授权记录，可以进入正式交付。
- `retired`：停止复用，保留记录以解释旧项目。

只有 `verified` 能进入正式成片。`draft` 和 `analyzed` 只能用于探索，并必须在 `component-plan.json` 中如实标记。

## 当前策略

HyperFrames 官方 Registry、动态标题、嵌入式字幕、转场和透明贴纸能力已经登记，但尚未全部用当前中文口播素材完成验收。后续每接入一个组件，要把版本、覆盖参数、素材替换、许可证据和真实渲染产物补回 `index.json`，然后才把状态提升为 `verified`。

## 校验要求

涉及 overlay composition 的组件，登记为 `verified` 之前必须先用 HyperFrames 官方命令跑通校验：

```powershell
hyperframes lint
hyperframes inspect
```

要求 `lint` 为 0 error / 0 warning、`inspect` 为 0 layout issue。校验结果、媒体是否全部落在项目根内、以及字体等依赖限制，都要写进组件证据和工程 `qa.json`，否则只能停留在 `analyzed`。

已知限制：中文字体（等线）单文件约 15.6MB，超过 HyperFrames 的 2MB 内联上限，因此中文口播工程暂时无法靠 HyperFrames 打包自包含，成片仍由本地 HTML/GSAP 加 Chrome 抽帧管线渲染。详见 `HYPIT_LESSONS.md` 的 L-011。
