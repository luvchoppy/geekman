#!/usr/bin/env python3
"""LinuxDo 抓取（curl_cffi 过 Cloudflare）。

实测结论：
  - 直连 /latest.json、/latest.rss 都会被 Cloudflare Managed Challenge 挡成 403
  - r.jina.ai 回退被 401 bad IP reputation 封死
  - curl_cffi + impersonate=chrome 能过挑战，但 GitHub runner 的 IP 段经常被 429 限流

所以这里的策略是：429 就退避重试，实在拿不到就安静退出（退出码 2），
由上层决定跳过，不要让整轮抓取失败。
"""
import json
import os
import sys
import time

from curl_cffi import requests as cr

OUT = os.environ.get("LINUXDO_RAW", "/tmp/linuxdo-raw.json")
PAGES = int(os.environ.get("LINUXDO_PAGES", "2"))
RETRIES = int(os.environ.get("LINUXDO_RETRIES", "3"))


def get_json(url):
    for attempt in range(1, RETRIES + 1):
        try:
            r = cr.get(
                url,
                impersonate="chrome",
                timeout=30,
                headers={"accept": "application/json"},
            )
        except Exception as e:  # noqa: BLE001
            print(f"  [linuxdo] 第 {attempt} 次异常: {str(e)[:100]}")
            time.sleep(3)
            continue

        if r.status_code == 200:
            try:
                return json.loads(r.text)
            except Exception as e:  # noqa: BLE001
                print(f"  [linuxdo] 解析失败: {str(e)[:80]}")
                return None

        # 429 = 指纹过了但被限流，等一下还有机会；403 说明挑战没过，重试意义不大
        if r.status_code == 429:
            print(f"  [linuxdo] 第 {attempt} 次 429 限流，退避 {15 * attempt}s")
            time.sleep(15 * attempt)
            continue

        print(f"  [linuxdo] 第 {attempt} 次 HTTP {r.status_code}")
        return None
    return None


def main():
    topics = []
    for page in range(PAGES):
        data = get_json(f"https://linux.do/latest.json?page={page}")
        if not data:
            break
        items = (data.get("topic_list") or {}).get("topics") or []
        if not items:
            break
        topics.extend(items)

    out = []
    seen = set()
    for t in topics:
        tid = t.get("id")
        if tid is None or tid in seen:
            continue
        seen.add(tid)
        out.append(
            {
                "id": tid,
                "title": t.get("title"),
                "slug": t.get("slug"),
                "created_at": t.get("created_at"),
                "category_id": t.get("category_id"),
                "posts_count": t.get("posts_count"),
                "views": t.get("views"),
                "like_count": t.get("like_count"),
                "excerpt": t.get("excerpt"),
                "pinned": bool(t.get("pinned")),
            }
        )

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"  [linuxdo] 写入 {len(out)} 条 -> {OUT}")
    return 0 if out else 2


if __name__ == "__main__":
    sys.exit(main())
