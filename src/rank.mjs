import fs from 'node:fs';
import path from 'node:path';
import { sendTelegram, chunk, escapeHtml } from './notify.mjs';

/**
 * 每日排行榜：从今天已经过 TG 审核并推送的帖子里，重新挑出「最值得薅」的十个。
 *
 * 为什么要在 TG 之后再做一层：TG 的门槛是「8 分以上就算白嫖情报」，
 * 一天可能推几十条，信息密度低。这里按更严的标准再筛一遍——
 * 必须有人亲测有效、必须有可执行的教程、必须真能薅到东西——然后排序。
 */

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, 'data');

const log = (...a) => console.log(...a);

function readJsonl(dir, prefix, day) {
  const p = path.join(dir, prefix + '-' + day + '.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// 北京时间切天
const dayKey = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

function providerConfig() {
  const base = process.env.REVIEW_BASE_URL;
  const key = process.env.REVIEW_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  if (!base) throw new Error('REVIEW_BASE_URL 未配置');
  if (!key) throw new Error('REVIEW_API_KEY 未配置');
  return {
    url: base.replace(/\/+$/, '') + '/chat/completions',
    model: process.env.REVIEW_MODEL ?? 'deepseek-v4.1-flash-1017',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
  };
}

async function chat(messages, { timeout = 180000 } = {}) {
  const cfg = providerConfig();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        // 0 而不是 0.2：同样的候选必须给出同样的排序，否则同一批帖子
        // 在 60 条候选时排第 8、扩到 119 条反而落榜（实测发生过）。
        temperature: 0,
        max_tokens: Number(process.env.REVIEW_MAX_TOKENS ?? 16000),
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('rank provider ' + res.status + ': ' + text.slice(0, 200));
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

const PROMPT = `你是「白嫖情报」的终审编辑。下面是今天已经通过初筛并推送给读者的帖子。

读者只想要一件事：**今晚就能动手、大概率能成功薅到手的实惠**。

请从里面挑出真正值得动手的，按「值得薅的程度」从高到低排序。判断标准按重要性排列：

1. **有人亲测有效**：评论区或正文里有「已领到」「到手了」「亲测可用」这类实证。没有实证的排后面。
2. **有可执行的教程**：写清了怎么领、要什么条件、截止时间、有没有坑。只说「有活动」没细节的不要。
3. **普惠程度**：大多数人能领 > 需要特定地区/特定资质 > 少数人才能拿。
4. **实物价值**：真金白银（VPS、域名、API 额度、代金券）> 虚拟权益（会员、积分）> 抽奖。
5. **时效**：还在有效期内的排前面，已过期或即将过期的直接排除。

以下情况**一律排除，不要出现在结果里**：
- 纯抽奖、中奖率极低（如「抽 1 个人送」「下午 4 点开奖」）
- 需要拉人头、助力、邀请码才能拿（这是给别人打工，不是白嫖）
- 需要先充值/先消费才能用的「优惠」
- 已经有人反馈失效、要充值、是骗局
- 只有标题没有正文细节
- 技术讨论、跑分评测、求助提问（哪怕技术含量高）

**注意两条容易判错的边界**：

1. **省钱就是白嫖。** 优惠码、立减金、赠金、返现、折扣券，只要价格是真降、有具体码或链接、有截止时间，都算可薅情报，不要因为是「要花钱才能省」就排除。典型例子：「9esim 优惠码 BF26 减免 30%」「谷歌 AI Pro 每月领 10 刀赠金」——这类必须保留并给高分。

2. **链接带 AFF 人头的，不因此排除。** 只要优惠本身真实可薅，照样收录，但要在 pitfall 里写明「链接带 AFF 返利，介意可自己去官网搜」。读者要的是能薅到东西，不是替别人省钱。

输出严格的 JSON，不要 markdown 围栏，不要任何额外文字：

{"items":[{"i":3,"rank_score":95,"how":"注册后在控制台点领取，全程 3 分钟","pitfall":"需要信用卡验证，虚拟卡不行","proof":"评论区 5 人说已到手"}]}

字段说明：
- i：对应下面的编号
- rank_score：0-100，你判断的「值得薅程度」
- how：怎么领，一句话说清步骤（必须具体到能照着做）
- pitfall：坑在哪（没有就写「无明显门槛」）
- proof：有没有实证，谁说的（没有实证就写「暂无人反馈」）

最多输出 10 条。如果一条都不合格，就输出 {"items":[]}。

帖子列表：
{{ITEMS}}`;

async function main() {
  const day = dayKey();

  // 幂等：同一天只生成一次。Worker 和 GitHub 原生 cron 都可能触发，
  // 不拦一下会重复推送到 Telegram。手动重跑设 FORCE_RANK=1。
  const outFile = path.join(dataDir, 'ranking', day + '.md');
  if (fs.existsSync(outFile) && process.env.FORCE_RANK !== '1') {
    log('今天的排行榜已存在（' + outFile + '），跳过。要重跑请设 FORCE_RANK=1');
    return;
  }

  // 取数据源：优先今天；今天还没有推送记录（比如 cron 被拖到凌晨跑）就回退到最近有数据的一天，
  // 不然会像 11-24/25/26 那样连续空跑。
  let sent = readJsonl(dataDir, 'sent', day);
  let srcDay = day;
  if (!sent.length) {
    const days = fs
      .readdirSync(dataDir)
      .map((f) => /^sent-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1])
      .filter((d) => d < day)
      .sort()
      .reverse();
    for (const d of days.slice(0, 3)) {
      const cand = readJsonl(dataDir, 'sent', d);
      if (cand.length) {
        sent = cand;
        srcDay = d;
        log('今天还没有推送记录，改用 ' + d + ' 的数据');
        break;
      }
    }
  }
  if (!sent.length) {
    log('最近几天都没有推送记录，跳过排行榜');
    return;
  }
  if (srcDay !== day) {
    // 回退模式下输出文件名用数据所属的日期，幂等判断才有意义
    const fallbackFile = path.join(dataDir, 'ranking', srcDay + '.md');
    if (fs.existsSync(fallbackFile) && process.env.FORCE_RANK !== '1') {
      log(srcDay + ' 的排行榜已存在，跳过');
      return;
    }
  }
  log('用 ' + srcDay + ' 的 ' + sent.length + ' 条推送记录排榜');

  // 回 queue 里补详情：sent 只存了 key 和 score
  const queue = [];
  for (const f of fs.readdirSync(dataDir)) {
    if (!/^queue-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    queue.push(...readJsonl(dataDir, 'queue', f.slice(6, 16)));
  }
  const byKey = new Map(queue.map((p) => [p.sourceId + ':' + p.id, p]));

  const candidates = [];
  const seen = new Set();
  for (const s of sent.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const p = byKey.get(s.key);
    if (!p || seen.has(s.key)) continue;
    seen.add(s.key);
    candidates.push(p);
    if (candidates.length >= 120) break;
  }
  if (!candidates.length) {
    log('推送记录在 queue 里找不到原文，跳过');
    return;
  }
  log('候选 ' + candidates.length + ' 条，送审');

  const items = candidates
    .map((p, i) => {
      const replies = Array.isArray(p.replies) && p.replies.length
        ? '\n评论：' + p.replies.map((r) => r.text).join(' / ').slice(0, 300)
        : '';
      return (
        '--- 编号 ' + (i + 1) + ' ---\n来源：' + p.sourceName + '\n标题：' + p.title +
        '\n正文：' + (p.text || '（无正文）').slice(0, 900) +
        (p.stats ? '\n数据：' + p.stats : '') + replies
      );
    })
    .join('\n\n');

  const prompt = PROMPT.replace('{{ITEMS}}', items);

  let parsed = null;
  for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
    try {
      const raw = await chat([
        { role: 'system', content: '你是严格的白嫖情报终审编辑。只输出 JSON，不要解释、不要 markdown 围栏。' },
        { role: 'user', content: prompt },
      ]);
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (err) {
      log('  第 ' + attempt + ' 次失败: ' + err.message.slice(0, 120));
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  const picks = (parsed?.items ?? []).filter((x) => candidates[x.i - 1]);
  if (!picks.length) {
    log('终审认为今天没有值得薅的，不推送');
    return;
  }
  picks.sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0));

  const lines = ['<b>🔥 ' + srcDay + ' 白嫖排行榜</b>', ''];
  picks.forEach((x, idx) => {
    const p = candidates[x.i - 1];
    const medal = ['🥇', '🥈', '🥉'][idx] ?? (idx + 1) + '.';
    lines.push(medal + ' <b>' + escapeHtml(p.title.slice(0, 60)) + '</b>');
    lines.push('   ' + escapeHtml(String(x.how || '').slice(0, 90)));
    if (x.pitfall && !/无明显/.test(x.pitfall)) lines.push('   ⚠️ ' + escapeHtml(String(x.pitfall).slice(0, 70)));
    if (x.proof && !/暂无/.test(x.proof)) lines.push('   ✅ ' + escapeHtml(String(x.proof).slice(0, 60)));
    lines.push('   🔗 ' + p.url);
    lines.push('');
  });
  lines.push('共 ' + candidates.length + ' 条候选中筛出 ' + picks.length + ' 条，其余不值当。');

  const body = lines.join('\n');
  log('生成排行榜，' + picks.length + ' 条');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    for (const part of chunk(body)) {
      await sendTelegram(part, { token, chatId, log });
    }
    log('已推送到 Telegram');
  } else {
    log('未配置 Telegram，只打印：\n' + body);
  }

  // QQ 通道预留：如果要接 NapCat / 邮箱，在这里加一个 webhook 调用即可
  const qqWebhook = process.env.QQ_WEBHOOK_URL;
  if (qqWebhook) {
    try {
      const res = await fetch(qqWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day, markdown: body, picks: picks.length }),
      });
      log('QQ webhook: HTTP ' + res.status);
    } catch (err) {
      log('QQ webhook 失败: ' + err.message.slice(0, 100));
    }
  }

  const finalFile = path.join(dataDir, 'ranking', srcDay + '.md');
  fs.mkdirSync(path.dirname(finalFile), { recursive: true });
  fs.writeFileSync(finalFile, body);
  log('已写入 ' + finalFile);
}

main().catch((err) => {
  console.error('排行榜生成失败:', err);
  process.exit(1);
});
