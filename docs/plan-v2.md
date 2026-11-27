# v2 架构计划书（TG 频道方案）

> 状态：**待开发**。当前 v1 架构继续运行，等新对话开工后整体替换。
> 这份文档是给下一个开发对话的交接说明，不需要再重复调研。

---

## 一、为什么换

v1 用「5 个论坛各写一套适配器 + Cloudflare Worker 调度 + curl_cffi 对抗 Cloudflare」，
每天消耗 1570 分钟 Actions，其中 collect 占 1454 分钟且 49 次运行**全部被 cancel**（24 轮长驻从未跑完）。
LinuxDo 长期 0 产出（403 挑战 + 429 限流），`nodeseek-proxy` Worker 实测 0 调用。

TG 频道方案用同一个接口覆盖多个论坛，反爬问题转移给频道主，自己不再处理。

---

## 二、频道评估（2026-11-27 实测）

抓取方式：`GET https://t.me/s/{channel}` → HTTP 200，无需认证，消息在 `.tgme_widget_message`。

| 频道 | 名称 | 订阅 | 实测日更 | 内容 | 判定 |
|---|---|---|---|---|---|
| **baipiaotg** | 白嫖推送 | 7.4K | ~169 条 | ns / nodeloc / linux.do 羊毛帖 + 原帖链接 | ⭐⭐⭐⭐⭐ 主力 |
| **nodeseekc** | NodeSeek官方频道 | 42.1K | ~3130 条 | ns 全站新帖标题流 | ⭐⭐⭐⭐ 兜底/交叉验证 |
| **wzxylh** | 网络技术文章分享 | 10.9K | ~1 条 | AI 模型免费额度、中转站 | ⭐⭐⭐⭐ 精品低频 |
| **zrj96** | zrj766的频道 | 17.9K | ~36 条 | 黑五优惠 + 开源工具 + VPS 测评 | ⭐⭐⭐ 补充 |
| geekshare | 极客分享 | 65.9K | ~1 条 | 开源工具，偶发 VPS 优惠 | ⭐⭐ 可略 |
| ~~LycorisStore~~ | 彼岸羊毛捡漏组 | 4.64K | ~1606 条 | **京东/淘宝电商**（床单、牛奶、牙膏） | ❌ 排除 |
| ~~zaihuapd~~ | 在花科技圈 | 292K | ~22 条 | **科技新闻**（政策、厂商动态） | ❌ 排除 |

### 样本（baipiaotg）
```
$100 Apple Gift Card 送 $15 Amazon balance   → nodeseek.com/post-1086071
【送】送个懒猫家宽 Frontier 动态家宽 ¥15/月    → nodeseek.com/post-1086115
免费VPS-ipv6主机：512M RAM+5G SSD+250G流量    → nodeloc.com/t/119712
【gemini】听说新用户没-50%了                    → linux.do/t/topic/3258997
```

---

## 三、回源能力（关键限制）

频道消息只有标题，需要回源补正文和评论。**只有 2/3 能成**：

| 来源站 | 正文 | 评论 | 实现 |
|---|---|---|---|
| NodeSeek | ✅ | ✅ | `curl_cffi` + `.post-content` + `extract_comments()`（现成代码） |
| NodeLoc | ✅ | ✅ | Discourse `/t/{id}.json` 的 `post_stream.posts` |
| LinuxDo | ❌ | ❌ | 403 挑战 + 429 限流，四种办法全试过（直连/RSS/jina/curl_cffi）|

**LinuxDo 的补救**：只出现在 baipiaotg 里说明频道主已人工筛过一轮；且它的羊毛帖标题通常写得直白，纯标题可判八九成。

---

## 四、处理流水线

```
t.me/s/{channel} 轮询（10 分钟）
      ↓ 解析：channel + msgId + title + url + publishedAt
按 channel:msgId 去重
      ↓
【第一段】AI 标题初筛（无正文，成本极低）
  输出 keep/drop，预计 169 条留下 15-30 条
      ↓ keep
【第二段】按链接域名回源
  nodeseek  → Python 抓正文+评论
  nodeloc   → Discourse API 抓正文+评论
  linux.do  → 跳过，只用标题（降低权重）
      ↓
【第三段】AI 终审（沿用 prompts/review.md 现有规则）
      ↓
推送 Telegram + 累积到当日排行榜
```

**成本对比**：详情请求从 900 次/天降到 20-30 次/天，IP 被限流风险基本消失。

---

## 五、清理清单

### Cloudflare：两个 Worker 全删

| Worker | 判定 | 理由 |
|---|---|---|
| `forum-digest-cron` | ❌ 删 | 改用 GitHub 原生 cron；TG 频道有历史消息，漏几次能补回 |
| `nodeseek-proxy` | ❌ 删 | 实测 0 调用（`PROXY_HOSTS=linux.do` 但 LinuxDo 走 Python 不走 http.mjs） |

> 注意：Cloudflare API token 已失效，删除需在后台操作或提供新 token。

### GitHub Actions：删 1 个

| Workflow | 判定 |
|---|---|
| `digest.yml` (forum-collect) | 🔧 保留，重写为抓 TG 频道 |
| `review.yml` (forum-review) | ✅ 保留，核心逻辑不动 |
| `rank.yml` (daily-ranking) | ✅ 保留 |
| `probe-site.yml` | ✅ 保留（探测工具） |
| `heartbeat.yml` | ❌ 删（纯 echo，测 cron 投递率用，无业务价值） |

### 代码文件

**删除**
```
scripts/fetch-nodeseek.py    ← 改为只保留「回源抓正文」部分，抓列表的逻辑删掉
scripts/fetch-linuxdo.py     ← 整删
src/sources/nodeseek.mjs     ← 整删
src/sources/linuxdo.mjs      ← 整删
src/sources/discourse.mjs    ← 保留（NodeLoc 回源要用）
src/sources/v2ex.mjs         ← 待定（见「待拍板」）
src/sources/rss.mjs          ← 待定（见「待拍板」）
worker/github-cron.js        ← 整删
worker/nodeseek-proxy.js     ← 整删
worker/README.md             ← 整删
```

**新增**
```
src/sources/tg.mjs           ← 频道解析器（唯一新适配器）
```

**不动**
```
src/review.mjs / src/reviewer.mjs / src/rank.mjs / src/notify.mjs
src/lib/http.mjs / src/lib/parse.mjs / src/state.mjs
prompts/review.md
```

### 配置清理

**删除 secrets**
```
PROXY_TOKEN
```

**删除 variables**
```
PROXY_PREFIX     https://nodeseek-proxy.zht93060.workers.dev/?url=
PROXY_ENABLED    1
PROXY_HOSTS      linux.do
ENABLE_JINA_FALLBACK 0
```

**保留**
```
secret  LLM_API_KEY
secret  TG_BOT_TOKEN
var     REVIEW_BASE_URL      https://napi.luvz.top/v1
var     REVIEW_MODEL         deepseek-v4.1-flash-1017
var     REVIEW_MAX_TOKENS    16000
var     REVIEW_BATCH_SIZE    10
var     REVIEW_CONCURRENCY   3
var     MIN_SCORE            8
var     PUSH_THRESHOLD       5
var     DATA_RETAIN_DAYS     7
var     TG_CHAT_ID           6867015060
```

---

## 六、数据存储（保持 jsonl，不上数据库）

```
data/
  tg-raw-{date}.jsonl      频道原文（去重后）
  queue-{date}.jsonl       初筛通过、待回源
  reviewed-{date}.jsonl    终审结论
  sent-{date}.jsonl        已推送
  ranking/{date}.md        每日排行榜
```

现 v1 用 4 类 jsonl / 14.7 MB 撑了 8 天，证明 jsonl 完全够用。

---

## 七、调度

GitHub 原生 cron `*/10 * * * *`，单次 1-2 分钟，约 200-300 分钟/天。

**已知风险**：GitHub 原生 cron 在本仓库投递率仅 3.5%。但 TG 频道有历史消息，
`t.me/s/` 一页给 20 条，即使 cron 半天才响一次，也能靠一次抓取补回几小时的量。
这是 TG 方案相比论坛直抓的最大优势——**数据不会因为调度失败而永久丢失**。

---

## 八、待拍板的三个点

1. **V2EX 和 1A2X 要不要保留？**
   不在频道列表里。保留 = 混合架构（干净度略降，但多 60-75 条/天）；砍掉 = 纯频道方案。

2. **`nodeseekc`（3130 条/天）怎么用？**
   直接送审会淹没信号（169 vs 3130）。建议只做交叉验证或干脆不接。

3. **定时频率**
   10 分钟（约 200 分钟/天）够用；5 分钟约 400 分钟。

---

## 九、验收标准

- [ ] `t.me/s/{channel}` 解析出 title / url / publishedAt / msgId
- [ ] 按 `channel:msgId` 去重，重复抓不重复入队
- [ ] 标题初筛走通，能区分「羊毛」和「闲聊/新闻」
- [ ] NodeSeek 链接能回源拿到正文 + 前 5 条高赞评论
- [ ] NodeLoc 链接能回源拿到正文 + 评论
- [ ] LinuxDo 链接优雅降级（只用标题，不报错）
- [ ] 终审沿用现有 `prompts/review.md` 规则，`MIN_SCORE=8`
- [ ] 推送 Telegram 成功
- [ ] 每晚 20:00 排行榜正常生成
- [ ] 无 Cloudflare 依赖：全删 Worker 后仍能运行
