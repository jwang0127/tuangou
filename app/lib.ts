export type Product = { id: string; number: number; name: string; spec: string; price_cents: number };
export type Round = { id: string; title: string; cutoff_at: string; status: string };
export type Order = { id: string; name: string; paid_cents: number; payment_method: string; total_cents: number };
export type Item = { product_id: string; quantity: number; unit_cents: number; name: string };
export const yuan = (cents: number) => (cents / 100).toFixed(2);
export const shortId = (id: string) => id.slice(0, 8).toUpperCase();
export const cutoffText = (iso: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export async function api(body: Record<string, unknown>): Promise<any> { const r = await fetch("/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json() as any; if (!r.ok) throw new Error(data.error || "操作失败"); return data; }
export async function getApi(query = ""): Promise<any> { const r = await fetch("/api" + query, { cache: "no-store" }); const data = await r.json() as any; if (!r.ok) throw new Error(data.error || "读取失败"); return data; }
export function parseCatalog(input: string) {
  return input.split(/\r?\n|\\\s*\\/).map(line => line.trim()).filter(Boolean).map(line => {
    const normalized = line.replace(/[\uFE0F\u20E3]/g, "");
    if (!/^\s*[0-9⃣]{1,5}/u.test(line) && !/^\d{1,3}[.、]/.test(normalized)) return null;
    const priceMatch = [...line.matchAll(/(?:💰+\s*|(?:^|\s))([0-9]+(?:\.[0-9]{1,2})?)\s*元?/gu)].at(-1);
    if (!priceMatch) return null;
    const price = Math.round(Number(priceMatch[1]) * 100);
    if (!price || price > 10000000) return null;
    const withoutNo = normalized.replace(/^\s*\d{1,3}[.、:：]?\s*/, "");
    const body = withoutNo.split("💰")[0];
    const parts = body.split(/[🔥:：]/);
    const name = (parts[0] || "").trim();
    const spec = parts.slice(1).join(" ").replace(/秒杀|福利|一份/g, "一份").trim();
    return name ? { name, spec, priceCents: price } : null;
  }).filter((x): x is { name: string; spec: string; priceCents: number } => !!x);
}
