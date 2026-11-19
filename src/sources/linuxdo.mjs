import fs from 'node:fs';
import { excerpt, toISO } from '../lib/parse.mjs';

/**
 * LinuxDo 适配器：读取 scripts/fetch-linuxdo.py 的产出。
 *
 * 为什么不用 HTTP 直连：/latest.json 和 /latest.rss 都会被 Cloudflare
 * Managed Challenge 挡成 403，jina 回退又被封 IP。只有 curl_cffi 模拟
 * 浏览器指纹能过挑战，代价是 GitHub runner 的 IP 段常被 429 限流，
 * 所以拿不到时安静返回空数组，不影响其它源。
 */
function loadRaw() {
  const p = process.env.LINUXDO_RAW ?? '/tmp/linuxdo-raw.json';
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > 20 * 60_000) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function fetchLinuxdo(source, ctx) {
  const windowHours = Number(source.windowHours ?? 24);
  const cutoff = Date.now() - windowHours * 3600_000;
  const base = source.baseUrl.replace(/\/$/, '');

  const list = loadRaw();
  if (!list.length) {
    console.log('  [linuxdo] 无 curl_cffi 产出（可能被 429 限流），本轮跳过');
    return [];
  }

  const out = [];
  for (const t of list) {
    if (t.pinned) continue;
    if (!t.id || !t.title) continue;

    const created = toISO(t.created_at);
    const ts = created ? Date.parse(created) : NaN;
    if (!Number.isNaN(ts) && ts < cutoff) continue;

    out.push({
      sourceId: source.id,
      sourceName: source.name,
      id: String(t.id),
      title: t.title,
      url: base + '/t/' + (t.slug ? t.slug + '/' : '') + t.id,
      createdAt: created,
      category: t.category_id ? 'cat-' + t.category_id : undefined,
      stats: (t.views ?? 0) + ' 浏览 / ' + (t.posts_count ?? 0) + ' 回复',
      text: excerpt(t.excerpt ?? '', 1200),
      replies: [],
    });
  }

  console.log('  [linuxdo] 窗口内 ' + out.length + ' 条');
  return out;
}
