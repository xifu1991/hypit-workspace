# Hypit 制作经验与避坑清单

本文件只记录真实发生过的问题，以及由此得出的、可执行的规避规则。
没有真实验证的推测不写入。每条规则都要有对应的验证方式。

记录格式：现象、根因、规则、验证。

---

## L-001 透明 WebM 合成会丢 alpha 通道

- 现象：把 `overlay-alpha.webm` 用 ffmpeg overlay 叠到底片上，输出只剩 overlay，底片区域变成纯黑。
- 根因：本地 ffmpeg 解码 VP9 alpha WebM 时 `pix_fmt` 报为 `yuv420p`，alpha 没有被 overlay 滤镜采用。
- 规则：透明层合并不直接信任 WebM。优先用 PNG 序列直接 overlay；确需 WebM 时，先用 `alphaextract` 验证 alpha 不是全白再合成。
- 验证：v2 改为 PNG 序列合成后画面正常；抽帧 `alphaextract` 确认透明区有效。

## L-002 流程文档的时间码不随精剪更新

- 现象：成片切点是 378/618/731 帧，但 `qa.json` 的 reference-structure 仍写 402/640/753 帧，且状态是 pass。
- 根因：精剪改了成片，文档没有做一致性回写。
- 规则：每次定稿后强制执行一次时间码一致性校验，把所有 JSON 中的帧码与秒数对齐成片；不一致的检查项不得标 pass。
- 验证：v2 已把 `reference.json` 的 13.34/21.32 秒修正为 12.6/20.6 秒，`qa.json` 改写为实际帧码。

## L-003 证据帧引用不存在的文件

- 现象：`reference.json` 引用 `qa/final_frames/t13.8.jpg`、`t18.jpg`、`t24.5.jpg`，实际目录只有 `t13.jpg`、`t16.8.jpg`、`t23.6.jpg`。
- 根因：关键帧来自另一版生成，文档沿用了旧文件名。
- 规则：文档写入任何路径后，用脚本批量 `Test-Path` 校验，全部为 True 才算完成。
- 验证：v2 的 reference、qa、material-plan 引用已全部批量校验通过。

## L-004 素材登记了但没有落盘

- 现象：`material-plan.json` 写 `assets/source-full.mp4`、`assets/background.jpg`，项目目录下并不存在这两个文件。
- 根因：先写登记、后补素材，补素材这一步被跳过。
- 规则：素材先真实落盘并算好 SHA-256，再写进 material-plan；登记路径必须能在项目根下解析。
- 验证：v2 的自制对比卡先导出 PNG 并算哈希，再写 claim-06。

## L-005 禁止机械套用已拆解风格（v3 路线永久否决）

- 现象：v3 把横屏口播素材按 1.667 倍裁切放大，再加 360×360 圆窗去模拟 `product-hero-speaker-pip`，用户判定"一塌糊涂"。
- 根因：只做参数映射，没有先验证原素材的构图和产品关系，直接改主片构图，把脸和产品的取舍做反了。
- 规则：禁止在 DSC_5862 及同类横屏口播项目上复用这套裁切重构和圆窗方案。任何已拆解风格必须先出小样对比，确认构图可行再进主片；未验证不得在 `reference.json` 写成已应用。
- 验证：v3 成片、工程、文档与 Studio 资源已全部删除，v3 不再作为任何参考案例。

## L-006 跨工作区同步库之后相对路径失效

- 现象：`component-library/index.json` 的引用写成 `../ChatGPT/视频制作ds版本/production-30/edit.svml`，复制到另一个工作区后全部解析失败。
- 根因：引用路径按来源工作区硬编码，不是工作区相对路径。
- 规则：跨工作区同步库时，把引用统一改写为工作区相对路径，并批量验证解析结果。
- 验证：同步到 ds 工作区后，17 条本地引用全部 `Test-Path` 通过。

## L-007 大体积二进制不能进仓库

- 现象：工作区 `tools/` 目录含 FFmpeg 与 whisper.cpp 二进制，其中 `ggml-small.bin` 单文件 465MB。
- 根因：本地工具目录没有从一开始列入忽略规则。
- 规则：FFmpeg、whisper 模型、浏览器缓存等本地二进制一律不进 Git；每个仓库的 `.gitignore` 明确列出。
- 验证：`视频制作/.gitignore` 已加入 `tools/`，`hypit-local-demo/.gitignore` 原有 `examples/**/assets/` 与 `*.mp4` 规则生效。
