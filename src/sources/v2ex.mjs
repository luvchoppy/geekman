import { requestJson } from '../lib/http.mjs';
import { excerpt, stripHtml, toISO } from '../lib/parse.mjs';

/**
 * V2EX 适配器。
 *
 * 实测（runner 环境）：GET /api/topics/latest.json 返回 44 条，
 * 自带 content / content_rendered 正文和 created 时间戳，不需要额外抓详情。
 * 只要求请求带非空 User-Agent（http.mjs 的 DEFAULT_UA 已满足）。
 */
export async function fetchV2ex(source, ctx) {
  const windowHours = Number(source.windowHours ?? 24);
  const cutoff = Date.now() - windowHours * 3600_000;

  const data = await requestJson('https://www.v2ex.com/api/topics/latest.json', {
    timeout: 25000,
    retries: 2,
  });
  const list = Array.isArray(data) ? data : [];
  if (!list.length) throw new Error('v2ex 返回空列表');

  const out = [];
  for (const t of list) {
    if (t.deleted) continue;
    if (!t.id || !t.title) continue;

    // created 是 unix 秒
    const created = t.created ? new Date(Number(t.created) * 1000).toISOString() : toISO(t.created);
    const ts = created ? Date.parse(created) : NaN;
    if (!Number.isNaN(ts) && created && Number(t.created) && ts < cutoff) continue;

    out.push({
      sourceId: source.id,
      sourceName: source.name,
      id: String(t.id),
      title: t.title,
      url: t.url || 'https://www.v2ex.com/t/' + t.id,
      author: t.member && t.member.username ? t.member.username : undefined,
      createdAt: created,
      category: (t.node && (t.node.title || t.node.name)) || undefined,
      stats: (t.replies ?? 0) + ' 回复',
      text: excerpt(stripHtml(t.content_rendered || t.content || ''), 1200),
      replies: [],
    });
  }

  console.log('  [v2ex] 抓到 ' + list.length + ' 条，窗口内 ' + out.length + ' 条');
  return out;
}
