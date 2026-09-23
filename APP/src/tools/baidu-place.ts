/** 百度 Place 检索 + 详情（place/v2/search + place/v2/detail?scope=2）。
 * 0.4.1 职责：为 v2 poi/aoi 事件填充 opening_detail / price / rating / scope_grade / classified_poi_tag
 * （SPEC/event-model-v2.md §3.2/§4.2/§10）。
 * regular_open_hour.periods 直接作为 opening_detail 存储格式，零转换成本；
 * 查不到的字段留 null（共创哲学：进清单由用户回填，不编造）。 */
import { baiduGet } from "./baidu.ts";
import type { OpeningDetail } from "../memory/event-v2.ts";

export interface BaiduPoiHit {
  baidu_uid: string;
  name: string;
  geo: { lat: number; lng: number } | null;  // GCJ02（ret_coordtype=gcj02）
  city: string | null;
  category_tags: string[];
}

/** POI 检索拿 uid（place/v2/search，region 限定城市防同名误解析） */
export async function searchBaiduPoi(name: string, city?: string): Promise<BaiduPoiHit | null> {
  const data = await baiduGet("/place/v2/search", {
    query: name,
    region: city || "全国",
    output: "json",
    ret_coordtype: "gcj02",
    page_size: "5",
    page_num: "0",
  });
  const r = data.results?.[0];
  if (!r?.uid) return null;
  return {
    baidu_uid: r.uid,
    name: r.name ?? name,
    geo: r.location?.lat != null ? { lat: +r.location.lat, lng: +r.location.lng } : null,
    city: r.city ?? null,
    category_tags: splitTags(r.detail_info?.classified_poi_tag),
  };
}

export interface BaiduPlaceDetail {
  opening_detail: OpeningDetail | null;
  price: { amount: number; desc?: string } | null;
  rating: { score: number; votes?: number } | null;
  scope_grade: string | null;        // AAAAA 等景区等级
  category_tags: string[];           // classified_poi_tag 拆分
}

/** classified_poi_tag 形如 "风景名胜;公园广场;公园" → 数组 */
function splitTags(raw: unknown): string[] {
  return String(raw ?? "").split(";").map(s => s.trim()).filter(Boolean);
}

/** scope=2 详情：结构化营业时段/价格/评分/景区等级/分类标签（全字段缺失返回 null，不抛） */
export async function placeDetail(uid: string): Promise<BaiduPlaceDetail | null> {
  const data = await baiduGet("/place/v2/detail", {
    uid, scope: "2", output: "json",
  });
  const di = data.result?.detail_info ?? {};
  const roh = di.regular_open_hour;
  let opening: OpeningDetail | null = null;
  if (Array.isArray(roh?.periods) && roh.periods.length) {
    opening = {
      periods: roh.periods
        .filter((p: any) => p?.open && p?.close)
        .map((p: any) => ({
          open: { day: +p.open.day || 1, hour: +p.open.hour || 0, minute: +p.open.minute || 0 },
          close: { day: +p.close.day || 1, hour: +p.close.hour || 0, minute: +p.close.minute || 0 },
        })),
      text: di.shop_hours ?? null,
      source: "api",
      fetched_at: Date.now(),
    };
  } else if (di.shop_hours) {
    // 无结构化 periods 但有原文：保留文本兜底展示，结构化判断（V3）按未知处理
    opening = { periods: [], text: String(di.shop_hours), source: "api", fetched_at: Date.now() };
  }
  const priceNum = di.price != null && +di.price > 0 ? +di.price : null;
  const ratingNum = di.overall_rating != null && +di.overall_rating > 0 ? +di.overall_rating : null;
  return {
    opening_detail: opening,
    price: priceNum ? { amount: priceNum, desc: di.price_desc ?? undefined } : null,
    rating: ratingNum ? { score: ratingNum, votes: di.comment_num != null ? +di.comment_num : undefined } : null,
    scope_grade: di.scope_grade ?? null,
    category_tags: splitTags(di.classified_poi_tag),
  };
}

/** 一站式富化：检索 + 详情。任一步失败返回已拿到的部分（best-effort，不阻断落图） */
export async function enrichFromBaidu(name: string, city?: string): Promise<(BaiduPoiHit & { detail: BaiduPlaceDetail | null }) | null> {
  try {
    const hit = await searchBaiduPoi(name, city);
    if (!hit) return null;
    let detail: BaiduPlaceDetail | null = null;
    try { detail = await placeDetail(hit.baidu_uid); } catch { /* 详情失败只留检索结果 */ }
    return { ...hit, detail };
  } catch {
    return null; // 百度未配置 AK / 网络失败：全部留空，走共创
  }
}
