import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
type Row = Record<string, unknown>;
const db = () => { if (!env.DB) throw new Error("数据库尚未连接"); return env.DB; };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
const money = (n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 100000000;
const isAdmin = (r: NextRequest) => !!env.ADMIN_KEY && r.cookies.get("tg_admin")?.value === env.ADMIN_KEY;
const sameOrigin = (r: NextRequest) => !r.headers.get("origin") || r.headers.get("origin") === new URL(r.url).origin;
const current = async () => (await db().prepare("SELECT * FROM rounds ORDER BY created_at DESC LIMIT 1").first()) as Row | null;
const products = async (id: string) => (await db().prepare("SELECT * FROM products WHERE round_id=? ORDER BY number").bind(id).all()).results as Row[];
const details = async (id: string) => (await db().prepare("SELECT oi.product_id, oi.quantity, oi.unit_cents, p.name, p.number FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? ORDER BY p.number").bind(id).all()).results as Row[];
const summary = async (roundId: string) => (await db().prepare("SELECT o.id,o.name,o.paid_cents,o.payment_method,o.created_at,o.updated_at,COALESCE(SUM(oi.quantity*oi.unit_cents),0) AS total_cents FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.round_id=? GROUP BY o.id ORDER BY o.created_at").bind(roundId).all()).results as Row[];

export async function GET(r: NextRequest) {
  try {
    const action = new URL(r.url).searchParams.get("action");
    const round = await current();
    if (action === "admin") {
      if (!isAdmin(r)) return json({ error: "请先登录管理页" }, 401);
      const rounds = (await db().prepare("SELECT * FROM rounds ORDER BY created_at DESC").all()).results as Row[];
      const requested = new URL(r.url).searchParams.get("roundId");
      const selected = requested ? rounds.find(x => x.id === requested) || null : round;
      const orders = selected ? await summary(String(selected.id)) : [];
      return json({ round: selected, rounds, products: selected ? await products(String(selected.id)) : [], orders, items: Object.fromEntries(await Promise.all(orders.map(async o => [String(o.id), await details(String(o.id))]))) });
    }
    if (action === "order") {
      const token = new URL(r.url).searchParams.get("token") || "";
      if (!token) return json({ error: "缺少订单凭证" }, 400);
      const order = await db().prepare("SELECT id,round_id,name,paid_cents,payment_method FROM orders WHERE edit_token=?").bind(token).first() as Row | null;
      if (!order) return json({ error: "找不到订单" }, 404);
      return json({ order, items: await details(String(order.id)) });
    }
    if (action === "lookup") {
      if (!round) return json({ orders: [] });
      const name = (new URL(r.url).searchParams.get("name") || "").trim();
      if (!name || name.length > 30) return json({ orders: [] });
      const rows = await summary(String(round.id));
      return json({ orders: rows.filter(o => String(o.name).includes(name)).map(({ id, name, total_cents }) => ({ id, name, total_cents })) });
    }
    return json({ round, products: round ? await products(String(round.id)) : [] });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "读取失败" }, 500); }
}

export async function POST(r: NextRequest) {
  try {
    if (!sameOrigin(r)) return json({ error: "请求来源无效" }, 403);
    const body = await r.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "login") {
      if (!env.ADMIN_KEY || body.key !== env.ADMIN_KEY) return json({ error: "管理密码不正确" }, 401);
      const response = json({ ok: true });
      response.cookies.set("tg_admin", env.ADMIN_KEY, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30 });
      return response;
    }
    if (action === "logout") { const response = json({ ok: true }); response.cookies.delete("tg_admin"); return response; }
    const admin = isAdmin(r);
    if (["publish", "payment", "adminOrder", "close", "product"].includes(action) && !admin) return json({ error: "请先登录管理页" }, 401);
    if (action === "publish") {
      const title = String(body.title || "本期团购").trim().slice(0, 60);
      const cutoffAt = String(body.cutoffAt || "");
      const parsed = Array.isArray(body.products) ? body.products : [];
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(cutoffAt) || Date.parse(cutoffAt) <= Date.now()) return json({ error: "请选择未来的截单时间" }, 400);
      const chinaCutoff = new Date(Date.parse(cutoffAt) + 8 * 3600000);
      if (![1,4].includes(chinaCutoff.getUTCDay()) || chinaCutoff.getUTCHours() !== 22 || chinaCutoff.getUTCMinutes() !== 0) return json({ error: "截单时间须为周一或周四晚上10点" }, 400);
      if (!parsed.length || parsed.length > 150) return json({ error: "请先核对商品" }, 400);
      const clean = parsed.map((p, i) => { const x = p as Row; return { id: crypto.randomUUID(), number: i + 1, name: String(x.name || "").trim().slice(0, 80), spec: String(x.spec || "").trim().slice(0, 100), price: Number(x.priceCents) }; });
      if (clean.some(p => !p.name || !money(p.price) || p.price === 0)) return json({ error: "商品名称或价格有误" }, 400);
      const prev = await current();
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      await db().batch([...(prev ? [db().prepare("UPDATE rounds SET status='closed' WHERE id=?").bind(prev.id)] : []), db().prepare("INSERT INTO rounds (id,title,cutoff_at,status,created_at) VALUES (?,?,?,'open',?)").bind(id,title,cutoffAt,now), ...clean.map(p => db().prepare("INSERT INTO products (id,round_id,number,name,spec,price_cents) VALUES (?,?,?,?,?,?)").bind(p.id,id,p.number,p.name,p.spec,p.price))]);
      return json({ ok: true, id });
    }
    const round = admin && body.roundId ? await db().prepare("SELECT * FROM rounds WHERE id=?").bind(String(body.roundId)).first() as Row | null : await current();
    if (!round) return json({ error: "还没有发布商品" }, 400);
    if (action === "product") {
      const id = String(body.productId || ""); const name = String(body.name || "").trim().slice(0, 80); const spec = String(body.spec || "").trim().slice(0, 100); const price = Number(body.priceCents);
      if (!name || !money(price) || price === 0) return json({ error: "商品名称或价格有误" }, 400);
      const product = await db().prepare("SELECT id FROM products WHERE id=? AND round_id=?").bind(id,round.id).first();
      if (!product) return json({ error: "商品不存在" }, 404);
      await db().batch([db().prepare("UPDATE products SET name=?,spec=?,price_cents=? WHERE id=?").bind(name,spec,price,id),db().prepare("UPDATE order_items SET unit_cents=? WHERE product_id=?").bind(price,id)]);
      return json({ ok: true });
    }
    if (action === "cancel") {
      const token = String(body.token || "");
      const order = admin && body.orderId ? await db().prepare("SELECT * FROM orders WHERE id=? AND round_id=?").bind(String(body.orderId),round.id).first() as Row | null : await db().prepare("SELECT * FROM orders WHERE edit_token=? AND round_id=?").bind(token,round.id).first() as Row | null;
      if (!order) return json({ error: "订单不存在" }, 404);
      if (!admin && (round.status !== "open" || Date.now() >= Date.parse(String(round.cutoff_at)))) return json({ error: "已截单，请联系团长修改" }, 403);
      await db().batch([db().prepare("DELETE FROM order_items WHERE order_id=?").bind(order.id),db().prepare("UPDATE orders SET updated_at=? WHERE id=?").bind(new Date().toISOString(),order.id)]);
      return json({ ok: true });
    }
    if (action === "close") { await db().prepare("UPDATE rounds SET status='closed' WHERE id=?").bind(round.id).run(); return json({ ok: true }); }
    if (action === "payment") {
      const id = String(body.orderId || ""); const paid = Number(body.paidCents); const method = String(body.method || "").slice(0, 20);
      if (!money(paid) || !["微信转账", "扫码", "线下", "其他", ""].includes(method)) return json({ error: "收款金额有误" }, 400);
      const result = await db().prepare("UPDATE orders SET paid_cents=?,payment_method=?,updated_at=? WHERE id=? AND round_id=?").bind(paid,method,new Date().toISOString(),id,round.id).run();
      if (!result.meta.changes) return json({ error: "订单不存在" }, 404);
      return json({ ok: true });
    }
    if (action === "order" || action === "adminOrder") {
      const name = String(body.name || "").trim().slice(0, 30);
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (!name || rawItems.length > 150) return json({ error: "请填写微信名并选择商品" }, 400);
      const catalog = await products(String(round.id));
      const valid = new Map(catalog.map(p => [String(p.id), p]));
      const seen = new Set<string>();
      const items = rawItems.map(x => { const y = x as Row; const id = String(y.productId || ""); const qty = Number(y.quantity); if (!valid.has(id) || !Number.isInteger(qty) || qty < 1 || qty > 99 || seen.has(id)) throw new Error("商品份数有误"); seen.add(id); return { id, qty, price: Number(valid.get(id)?.price_cents) }; });
      if (!items.length) return json({ error: "请至少选一件商品；取消整单请联系团长" }, 400);
      const token = String(body.token || "");
      let order = token ? await db().prepare("SELECT * FROM orders WHERE edit_token=?").bind(token).first() as Row | null : null;
      if (action === "adminOrder" && body.orderId) order = await db().prepare("SELECT * FROM orders WHERE id=? AND round_id=?").bind(String(body.orderId),round.id).first() as Row | null;
      if (token && !order && action !== "adminOrder") return json({ error: "订单凭证失效，请联系团长" }, 403);
      if (order && order.round_id !== round.id) return json({ error: "这不是本期订单" }, 400);
      if (!admin && (round.status !== "open" || Date.now() >= Date.parse(String(round.cutoff_at)))) return json({ error: "已截单，请联系团长修改" }, 403);
      const now = new Date().toISOString();
      const id = order ? String(order.id) : crypto.randomUUID();
      const editToken = order ? String(order.edit_token) : crypto.randomUUID() + crypto.randomUUID();
      await db().batch([order ? db().prepare("UPDATE orders SET name=?,updated_at=? WHERE id=?").bind(name,now,id) : db().prepare("INSERT INTO orders (id,round_id,name,edit_token,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(id,round.id,name,editToken,now,now), db().prepare("DELETE FROM order_items WHERE order_id=?").bind(id), ...items.map(x => db().prepare("INSERT INTO order_items (order_id,product_id,quantity,unit_cents) VALUES (?,?,?,?)").bind(id,x.id,x.qty,x.price))]);
      return json({ ok: true, id, token: editToken });
    }
    return json({ error: "未知操作" }, 400);
  } catch (e) { return json({ error: e instanceof Error ? e.message : "保存失败" }, 500); }
}
