# 镜头库 · 仙逆

把已经剪完的成片镜头反扫成一个可检索的索引，用途是：**以后剪新一期时，按关键词挑镜头，而不是手写源片时间码。**

## 文件

- `index.config.json` —— 输入清单。新增一期成片后在这里补一行。
- `仙逆-shot-index.json` —— 生成的索引（52 个镜头，可检索词条 2126 个）。

## 重建索引

```powershell
cd C:\Users\admin\Documents\视频制作
node scripts\build-shot-index.mjs
```

脚本会读每一期的 `build/timeline.json`（解说词、章节、时长、源片时间码）和 `build/shots/*.mp4`，把两边合成一条索引记录。

## 检索

```powershell
node scripts\shot-search.mjs stats
node scripts\shot-search.mjs list --episode EP01
node scripts\shot-search.mjs search "王林 战斗" --limit 8
node scripts\shot-search.mjs search "天劫 雷" --chapter 名场面
node scripts\shot-search.mjs search "储物袋" --json
node scripts\shot-search.mjs search "破境" --limit 2 --pick
```

筛选器：`--episode EP01` `--chapter 名场面` `--tone 冷|暖|中性` `--brightness 暗|中|亮` `--min 3` `--max 9` `--limit N` `--json` `--pick`

`--pick` 只输出镜头文件路径，是留给后续出片脚本直接消费的接口。

## 每条记录里有什么

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `chapter` | 手工 | 该镜在论证结构里的位置（提问/立靶/原委/反差/名场面/内核/升华） |
| `narration` | 成片文案 | 该镜所配的那句解说 |
| `tags` | 文案 + 词表 | 人物/动作/主题/场景/情绪/物件 |
| `terms` | 文案 + 词表 | 检索用的词条及权重（词表命中 4 分，三字 2 分，二字 1 分） |
| `visual` | 实测 | 画面区平均 RGB、亮度、色调（冷/中性/暖）、明暗（暗/中/亮） |
| `sourceStart` / `sourceTimecode` | 工程 | 该镜在母版里的取用起点 |
| `durationSeconds` | 实测 | 镜头时长 |

## 检索是怎么打分的

1. 查询词先过一遍词表，命中的词按 idf 加权（越少见的词越值钱）。
2. 词表同时当同义表用：查「战斗」会连带把「斗法」「交手」「清算」这些同组动作词找出来，但同组词按类别大小归一化，一整组同义词也压不过一个精确命中的词。
3. 同时命中两个以上精确词的镜头再加权，命中的词在结果里用 `~` 标出同义扩展。

## 两个已知边界

- **标签来自解说词，不是画面。** 这个镜当初就是按那句解说挑的，所以「配这句解说合适」是准确的；但它不等于画面里真的是什么。`visual` 里的亮度和色调是实测的，其余是推导的。
- **要真正的画面标签**（人物是谁、景别是特写还是全景、有没有武器），需要额外跑一遍画面分类。这一步没做，因为离线环境里没有可用的模型；如果要做，可以接本地视觉模型或人工补标。

## 后端怎么接

现在的 `outputs/*/build-cut.mjs` 里有一张手写的 `windows` 表（每句解说配一个源片时间点）。索引成熟之后，这张表可以换成「每句解说配一组关键词」，由检索脚本 `--pick` 返回镜头路径，出片脚本按句子顺序拼接。那样画面来源会天然跨集，不再依赖单部母版。
