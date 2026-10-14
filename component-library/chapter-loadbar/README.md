# 顶部章节加载条

全幅常驻的章节条，压在画面最上层，给长解说一个进度锚点。它属于信息层，不承载剧情，也不占用画面叙事区。

## 它做什么

- 顶上一整行章节标签，当前章节亮白，未到和已读章节压暗；单元格之间用 1px 细竖线分隔。
- **加载感来自两层动效**：当前章节下方一条进度线按该章节的**真实时长**从左往右长满；换章瞬间一块半透明药丸从上一格滑到当前格（320ms），随后在约 0.5 秒内淡出。
- 药丸是**切换动效，不是常驻高亮**。让白块一直停在当前格上，就会压在同样白色的章节名上把字抹掉——这是这个组件特意避开的坑。
- 标签行后面垫一层顶部压暗。默认是 64 段正弦渐变；给 `--scrim-fade` 则换成不透明实心带 +
  底边线性渐隐（明亮实拍/漫剧素材用这一档，渐变档在亮画面上会从条的上下沿透出画面，读起来像雾）。
- 活跃章节名带深色描边（默认 1.6px，漫剧档用 2px），字色 + 加粗 + 下方加载条三者一起表达"当前讲到哪"。
- 章节条下面一行可带左侧栏目名和右侧页码 `01 / 07`。

原效果抄自 `style-library/tech-share-chapter-progress`。这里只复用它的信息结构、版面层级和动效节奏，没有复用参考里的品牌、文案和素材。

## 怎么用

```powershell
cd C:\Users\admin\Documents\视频制作

# 1) 生成 .ass（章节改动只改 spec）
node --import tsx scripts/make-chapter-bar.ts `
  --spec component-library/chapter-loadbar/spec.manhua.json `
  --out outputs/<项目>/overlay/chapter-bar.ass `
  --width 1080 --height 1920 --font 等线 --duration 254

# 2) 烧进成片：和项目自己的 overlay 一起挂到 ass 滤镜上，逗号分隔
ffmpeg -i bed.mp4 -vf "ass=chapter-bar.ass,ass=<项目字幕>.ass" -c:a copy out.mp4
```

参数：`--width/--height` 画布，`--font` 字体，`--font-size` 章节字号（默认按格宽 11.5% 推），
`--bar-y` 顶距（默认画布高的 3.5%），`--duration` 让章节条撑到片尾（比最后一章的 end 更长时，
最后一格的进度线会停住而不是继续长）。

配色与强度：`--active`（活跃字色，默认 `#ffffff`）、`--dim`（其余字色默认值，同时兜底
`--inactive/--sep/--meta`）、`--rule`（进度线，默认 `#ffffff`）、`--pill`（药丸色，默认 `#ffffff`）、
`--pill-alpha`（药丸 alpha，默认 `94`，越大越淡）、`--scrim`（顶部压暗层 alpha，默认 `128`，
越大越淡；`0` 是纯黑实心，配合 `--scrim-fade` 使用）。

不透明实心顶栏（漫剧解说在用的一档，明亮素材上不会透出画面）：

```powershell
node --import tsx scripts/make-chapter-bar.ts --spec <spec>.json --out <bar>.ass `
  --width 1920 --height 1080 --font "汉仪中黑 197" --bar-y 30 --font-size 32 `
  --rule-h 4 --rule-track 205 --active-outline 2 --pill-alpha 165 `
  --scrim 0 --scrim-top 0 --scrim-bottom 158 --scrim-fade 18 `
  --inactive "#dcdcdc" --sep "#4f4f4f" --meta "#9a9a9a" --duration 185
```

- `--scrim-top/--scrim-bottom`：压暗层的绝对 y 范围，此时不要再靠 `--bar-y` 反推。
- `--scrim-fade`：底边渐隐高度。给这个参数就走实心带 + 线性渐隐，不给则保持原来的正弦渐变。
- `--rule-h`：加载条厚度。`--rule-track`：空轨道 alpha（给 `205` 左右是 20% 白，太小吃字）。
- `--active-outline`：活跃章节描边宽度。
- `--inactive/--sep/--meta`：其余章节字色 / 分格竖线色 / 栏目名与页码色，三者分开配。

规格文件里的 `chapters[].start/end` 用秒，必须按顺序、不重叠。脚本会在标签宽度超出单元格时告警，这时应减字或减少章节数。

## 已知限制

- 绘制坐标按 1:1 像素标定（`\p1` 下的坐标不受字号缩放影响），改画布尺寸要重新看一眼字宽是否够。
- 竖屏 1080 宽放 7 格时单格约 154px，章节名建议 2 到 3 个汉字；更长的名字要减字。
- 药丸是带圆角的矩形绘制，没有模糊光晕；参考里的发光边缘没有复刻。
- libass 会丢掉 `\c&HAABBGGRR&` 里的 alpha 字节，所有半透明填充必须另写 `\1a`/`\alpha`；只靠 `\c` 会渲染成实心块。同理，压暗层的分段必须精确相接，多 1px 重叠会叠出可见条纹。
- 中文字体依赖本地安装，商用发布前要把字体换成可商用字体，并随工程带上字体文件。
- Windows 上这台 ffmpeg 的 libass 用 DirectWrite 取字体：`ass` 滤镜的 `fontsdir` **无效**，
  用户级安装（`%LOCALAPPDATA%\Microsoft\Windows\Fonts`）也枚举不到，必须装进
  `C:\Windows\Fonts` 并写 HKLM 的 Fonts 键。用 `-loglevel debug` 看 `fontselect:` 行确认
  命中的是真的字体族，落到 `MicrosoftYaHeiUI` 就是回退了。
- 状态是 `active`：生成器、深底演示、亮底可读性验证齐全，已在《仙逆》第四期成片（1920×1080，
  185 秒，8 章）上按实心带档验收。

## 证据

- 生成器：`scripts/make-chapter-bar.ts`
- 样例渲染：`component-library/chapter-loadbar/qa/demo-chapter-bar.mp4`（深色底 22.4 秒，7 章压缩演示）
- 关键帧：`component-library/chapter-loadbar/qa/frames/`
- 拼版：`component-library/chapter-loadbar/qa/contact-sheet.png`（7 章稳态 + 2 次换章药丸）
- 亮底可读性：`component-library/chapter-loadbar/qa/frames/legibility-bright.png`
