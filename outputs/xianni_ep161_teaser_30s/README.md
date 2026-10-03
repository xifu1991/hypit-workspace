# 《仙逆》161 集 · 超前剧透解说 · 30 秒样片

## 成片

`xianni_ep161_teaser_30s_final.mp4`

- 1920×1080 / 30fps / 30.000 秒 / 900 帧
- H.264 High profile level 4.0 + AAC LC 44.1kHz 立体声 192kbps
- 30,335,607 字节，平均 8.09 Mbps
- SHA-256 `F5FE89D453F7D14B3244CC6EB6681A848C4E3405D2133EA451A7B54421078704`
- 音频实测 mean −17.7 dB / max −1.0 dB

## 这一版做了什么

把用户自备的《仙逆》动画 10 分钟超清素材 `10月3日.mp4` 剪成 30 秒超前剧透解说样片：

1. 从母版挑 10 个镜头，按「片头 → 抛章名 → 承接 → 悬念 → 章名反转 → 收口 → CTA」排好顺序。
2. 母版是 2596×1080 的超宽画幅，等比缩到 1920×800，上下各补 140px 黑边得到 16:9 画布。上下黑边正好用来放常驻品牌条和解说字幕，新增文字完全不进画面区。
3. 用本机离线 SAPI 生成 9 句解说（26.01 秒），配在时间轴上，原片声压到 15% 作垫底。
4. 用 ffmpeg + libass 烧一层 ASS：底部解说字幕 + 右上金色花字大字卡 + 顶部品牌条。

**这一版不讲剧情。** 161 集对应原著 905「下界卑民」到 906「蝴蝶之翅」，用户说小说正文无法下载，所以稿子只用集数和两个章名，涉及剧情的四句都写成悬念句。正文到位后按 `script.md` 里的四个〖剧情槽位〗填实即可。

## 目录

| 路径 | 内容 |
|---|---|
| `xianni_ep161_teaser_30s_final.mp4` | 成片 |
| `script.md` | 30 秒解说稿（含时间码、字数、待填槽位） |
| `beat-sheet.md` | 10 镜分镜卡点表（镜头 / 时间码 / 母版入点 / 花字 / 音频） |
| `overlay-assets-base-30s.mp4` | 带黑边的 30 秒底片，保留母版原声，未烧任何文字 |
| `segments/` | 10 个中间片段与 `list.txt` 拼接清单 |
| `overlay/ep161-overlay.ass` | 全部文字层：品牌条、解说字幕、花字、CTA |
| `overlay/narration.json` | 9 句解说的文本与配音参数 |
| `overlay/make-narration.ps1` | 调 Windows SAPI 生成 `audio/n02-n10.wav` |
| `overlay/assets/fonts/` | 等线 Bold / Regular 的本地副本，供 libass 离线加载 |
| `render-final.ps1` | 最终渲染脚本（一次 ffmpeg 编码出片） |
| `audio/` | 9 段解说配音 wav |
| `qa.json` | Playbook 检查报告，`finalVerdict = pass` |
| `qa/evidence/` | 5 张取证帧（2.5 / 8.0 / 14.5 / 19.0 / 29.0 秒） |
| `qa/contact-sheet.jpg` | 每 3 秒一帧的 10 宫格总览 |
| `qa/provenance/subtitle-timeline.md` | 字幕与花字的逐条时间轴核对表 |
| `qa/source-picks-check.jpg`、`qa/seg-first-sheet.jpg` | 母版入点与片段起始帧的逐格比对 |
| `brief.json` / `reference.json` / `material-plan.json` / `shotbook.json` / `component-plan.json` / `retrospective.json` | Playbook 七件套 |

## 复刻方式

```powershell
cd C:\HYPIT_MIGRATION\workspace\outputs\xianni_ep161_teaser_30s

# 1) 生成解说配音（需要提权：沙箱安全策略会拦截 SAPI 的 SelectVoice）
pwsh -File overlay\make-narration.ps1

# 2) 出片（依赖 tools\ffmpeg\bin\ffmpeg.exe，脚本里已写死）
pwsh -File render-final.ps1

# 3) 跑 Playbook 校验
node C:\HYPIT_MIGRATION\workspace\playbook\validate.mjs --project .
```

`overlay-assets-base-30s.mp4` 与 `audio/*.wav` 是中间产物，换电脑后需要按 `segments/list.txt` 和 `overlay/narration.json` 重建；`overlay/ep161-overlay.ass` 与 `render-final.ps1` 是版本化的源头文件。

## 下一步

1. 给 905、906 两章正文，把 `script.md` 里的四个〖剧情槽位〗填实。
2. 确认配音口径：现在的系统女声是占位音，可以换本机男声 `Microsoft Kangkang` 或真人录音。
3. 确认发布渠道的画幅与时长，再决定要不要出竖版。
