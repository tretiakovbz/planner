// Цели и сроки: Telegram Mini App + бот с напоминаниями. Один файл для Railway Function (Bun).
import { Database } from "bun:sqlite";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";

const TOKEN = Bun.env.BOT_TOKEN || "";
const DOMAIN = Bun.env.RAILWAY_PUBLIC_DOMAIN || "";
const APP_URL = DOMAIN ? "https://" + DOMAIN + "/" : "";
const DIR = Bun.env.RAILWAY_VOLUME_MOUNT_PATH || Bun.env.DATA_DIR || "/data";
const HOOK = TOKEN ? createHash("sha256").update(TOKEN + ":hook").digest("hex").slice(0, 40) : "";

let persistent = true;
let db: Database;
try {
  mkdirSync(DIR, { recursive: true });
  db = new Database(DIR + "/goals.db");
} catch (e) {
  persistent = false;
  console.error("STORAGE: том недоступен, данные хранятся только в памяти", e);
  db = new Database(":memory:");
}
db.run("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT DEFAULT '', tz INTEGER DEFAULT 240, mode TEXT DEFAULT 'daily', hour INTEGER DEFAULT 9, last_sent TEXT DEFAULT '')");
db.run("CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, deadline TEXT NOT NULL, step TEXT DEFAULT '', created TEXT NOT NULL, done INTEGER DEFAULT 0, done_at TEXT DEFAULT '')");
db.run("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
try { db.run("ALTER TABLE goals ADD COLUMN cat TEXT DEFAULT ''"); } catch {}

type User = { id: number; name: string; tz: number; mode: string; hour: number; last_sent: string };
type Goal = { id: number; user_id: number; title: string; deadline: string; step: string; created: string; done: number; done_at: string; cat: string };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function ensureUser(id: number, name: string): User {
  db.run("INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name", [id, name || ""]);
  seed(id);
  return db.query("SELECT * FROM users WHERE id=?").get(id) as User;
}

// Разовый перенос стартового списка целей: достается первому пользователю, открывшему бота.
// Сам список лежит в переменной окружения SEED_JSON, а не в коде.
function seed(userId: number) {
  const raw = Bun.env.SEED_JSON;
  if (!raw || db.query("SELECT v FROM meta WHERE k='seeded'").get()) return;
  try {
    const now = new Date().toISOString();
    let n = 0;
    for (const item of JSON.parse(raw)) {
      const c = clean(item);
      if (!c) continue;
      db.run("INSERT INTO goals(user_id,title,deadline,step,cat,created) VALUES(?,?,?,?,?,?)", [userId, c.title, c.deadline, c.step, c.cat, now]);
      n++;
    }
    db.run("INSERT INTO meta(k,v) VALUES('seeded',?)", [String(userId)]);
    console.log("SEED: добавлено целей", n);
  } catch (e) { console.error("SEED: не удалось разобрать SEED_JSON", String(e)); }
}

// Проверка подписи Telegram: только настоящий пользователь бота получает доступ к своим целям.
function auth(req: Request): User | null {
  if (!TOKEN) return null;
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("tma ")) return null;
  const p = new URLSearchParams(h.slice(4));
  const hash = p.get("hash") || "";
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const calc = createHmac("sha256", secret).update(dcs).digest("hex");
  if (hash.length !== calc.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(calc))) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
  try {
    const u = JSON.parse(p.get("user") || "{}");
    if (!u.id) return null;
    return ensureUser(Number(u.id), String(u.first_name || ""));
  } catch { return null; }
}

function state(u: User) {
  const goals = (db.query("SELECT * FROM goals WHERE user_id=? ORDER BY deadline").all(u.id) as Goal[]).map(g => ({
    id: String(g.id), title: g.title, deadline: g.deadline, step: g.step, cat: g.cat || "", created: g.created, done: !!g.done, doneAt: g.done_at,
  }));
  return { goals, settings: { mode: u.mode, hour: u.hour, tz: u.tz } };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function clean(b: any) {
  const title = String(b?.title ?? "").trim().slice(0, 120);
  const deadline = String(b?.deadline ?? "");
  const step = String(b?.step ?? "").trim().slice(0, 140);
  const cat = String(b?.cat ?? "").trim().slice(0, 40);
  if (!title || !DATE.test(deadline) || isNaN(Date.parse(deadline))) return null;
  return { title, deadline, step, cat };
}

// ---------- Тексты ----------
const pl = (n: number, f: string[]) => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
const DAYS = ["день", "дня", "дней"], HRS = ["час", "часа", "часов"];
function dueMs(deadline: string, tz: number) { const [y, m, d] = deadline.split("-").map(Number); return Date.UTC(y, m - 1, d, 23, 59, 59) - tz * 60000; }
function leftText(ms: number) {
  if (ms < 0) return "срок прошел";
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  if (d >= 7) return d + " " + pl(d, DAYS);
  if (d >= 1) return d + " " + pl(d, DAYS) + " " + (h % 24) + " ч";
  return h >= 1 ? h + " " + pl(h, HRS) : "меньше часа";
}
function softLine(ms: number) {
  const d = Math.floor(ms / 86400000);
  if (ms < 0) return "Срок прошел, и это не провал. Дату можно сдвинуть или закрыть цель как есть.";
  if (d < 1) return "Финишная прямая. Одного спокойного подхода может хватить.";
  if (d < 3) return "Хорошее время, чтобы закончить главное и не трогать мелочи.";
  if (d < 8) return "Один небольшой шаг сегодня заметно разгрузит конец недели.";
  if (d < 31) return "Запас есть, достаточно двигаться понемногу.";
  return "Времени много, можно идти в своем темпе.";
}
function summary(u: User, onlyNear: boolean) {
  const now = Date.now();
  let list = (db.query("SELECT * FROM goals WHERE user_id=? AND done=0").all(u.id) as Goal[])
    .map(g => ({ g, ms: dueMs(g.deadline, u.tz) - now }))
    .filter(x => x.ms > -3 * 86400000)
    .sort((a, b) => a.ms - b.ms);
  if (onlyNear) list = list.filter(x => x.ms < 7 * 86400000);
  if (!list.length) return "";
  const lines = list.slice(0, 6).map(x => "• " + x.g.title + ": " + leftText(x.ms));
  if (list.length > 6) lines.push("…и еще " + (list.length - 6));
  const first = list.find(x => x.ms >= 0) || list[0];
  let t = lines.join("\n") + "\n\n" + softLine(first.ms);
  if (first.g.step) t += "\nБлижайший шаг: " + first.g.step;
  return t;
}

// ---------- Telegram ----------
async function tg(method: string, body: unknown) {
  if (!TOKEN) return null;
  try {
    const r = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j: any = await r.json();
    if (!j.ok) console.error("tg", method, j.description);
    return j;
  } catch (e) { console.error("tg", method, String(e)); return null; }
}
const openBtn = () => APP_URL ? { reply_markup: { inline_keyboard: [[{ text: "Открыть планер", web_app: { url: APP_URL } }]] } } : {};

async function onUpdate(up: any) {
  const m = up?.message;
  if (!m?.chat || m.chat.type !== "private" || !m.from) return;
  const u = ensureUser(Number(m.from.id), String(m.from.first_name || ""));
  const text = String(m.text || "");
  if (text.startsWith("/left")) {
    const s = summary(u, false);
    await tg("sendMessage", { chat_id: u.id, text: s || "Активных целей сейчас нет. Можно выдохнуть или поставить следующую.", ...openBtn() });
  } else {
    await tg("sendMessage", { chat_id: u.id, text: "Привет! Это планер целей с обратным отсчетом.\n\nДобавьте цель и срок. Я покажу, сколько времени осталось, и раз в день коротко напомню об этом.\n\nНажмите кнопку ниже, чтобы начать. Команда /left покажет остаток по всем целям.", ...openBtn() });
  }
}

async function tick() {
  let sent = 0;
  const users = db.query("SELECT * FROM users WHERE mode!='off'").all() as User[];
  for (const u of users) {
    const local = new Date(Date.now() + u.tz * 60000);
    const today = local.toISOString().slice(0, 10), hour = local.getUTCHours();
    if (hour < u.hour || u.last_sent === today) continue;
    if (u.mode === "weekly" && local.getUTCDay() !== 1) continue;
    const s = summary(u, u.mode === "near");
    db.run("UPDATE users SET last_sent=? WHERE id=?", [today, u.id]);
    if (!s) continue;
    const hi = hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
    const r = await tg("sendMessage", { chat_id: u.id, text: hi + (u.name ? ", " + u.name : "") + ". Коротко по срокам:\n\n" + s, ...openBtn() });
    if (r?.ok) sent++;
  }
  return sent;
}

// Аватар бота ставится один раз; отметка об этом хранится в базе.
async function avatar() {
  const KEY = "avatar_v3";
  try {
    if (db.query("SELECT v FROM meta WHERE k=?").get(KEY)) return;
    const f = Bun.file(import.meta.dir + "/avatar.jpg");
    if (!(await f.exists())) { console.log("AVATAR: файл не найден"); return; }
    const fd = new FormData();
    fd.append("photo", JSON.stringify({ type: "static", photo: "attach://ava" }));
    fd.append("ava", new File([await f.arrayBuffer()], "avatar.jpg", { type: "image/jpeg" }));
    const r = await fetch("https://api.telegram.org/bot" + TOKEN + "/setMyProfilePhoto", { method: "POST", body: fd });
    const j: any = await r.json();
    console.log("AVATAR:", j.ok ? "ok" : "ошибка: " + j.description);
    if (j.ok) db.run("INSERT INTO meta(k,v) VALUES(?,'1')", [KEY]);
  } catch (e) { console.error("AVATAR:", String(e)); }
}

async function setup() {
  if (!TOKEN || !APP_URL) { console.log("SETUP: жду", !TOKEN ? "BOT_TOKEN" : "публичный домен"); return; }
  const a = await tg("setWebhook", { url: APP_URL + "tg/" + HOOK, secret_token: HOOK, allowed_updates: ["message"] });
  const b = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Планер", web_app: { url: APP_URL } } });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Открыть планер" }, { command: "left", description: "Сколько осталось по целям" }] });
  await tg("setMyDescription", { description: "Планер целей с обратным отсчетом.\n\n• Добавьте цель и срок\n• Смотрите, сколько времени осталось\n• Получайте спокойные напоминания, без спама\n\nНажмите «Запустить», чтобы начать." });
  await tg("setMyShortDescription", { short_description: "Цели, сроки и обратный отсчет. Спокойные напоминания о том, сколько времени осталось." });
  await avatar();
  console.log("SETUP: webhook", a?.ok ? "ok" : "ошибка", "| кнопка меню", b?.ok ? "ok" : "ошибка", "| хранилище", persistent ? "постоянное" : "В ПАМЯТИ");
}

// ---------- HTTP ----------
async function api(req: Request, path: string) {
  const u = auth(req);
  if (!u) return json({ error: TOKEN ? "auth" : "no_token" }, 401);
  const body: any = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
  const idm = path.match(/^\/api\/goals\/(\d+)$/);
  if (path === "/api/state" && req.method === "GET") return json(state(u));
  if (path === "/api/goals" && req.method === "POST") {
    const c = clean(body);
    if (!c) return json({ error: "bad_input" }, 400);
    db.run("INSERT INTO goals(user_id,title,deadline,step,cat,created) VALUES(?,?,?,?,?,?)", [u.id, c.title, c.deadline, c.step, c.cat, new Date().toISOString()]);
    return json(state(u));
  }
  if (idm && req.method === "PUT") {
    const c = clean(body);
    if (!c) return json({ error: "bad_input" }, 400);
    const done = body.done ? 1 : 0;
    db.run("UPDATE goals SET title=?,deadline=?,step=?,cat=?,done=?,done_at=CASE WHEN ?=1 AND done=0 THEN ? WHEN ?=0 THEN '' ELSE done_at END WHERE id=? AND user_id=?",
      [c.title, c.deadline, c.step, c.cat, done, done, new Date().toISOString(), done, Number(idm[1]), u.id]);
    return json(state(u));
  }
  if (idm && req.method === "DELETE") {
    db.run("DELETE FROM goals WHERE id=? AND user_id=?", [Number(idm[1]), u.id]);
    return json(state(u));
  }
  if (path === "/api/settings" && req.method === "PUT") {
    const mode = ["off", "daily", "weekly", "near"].includes(body?.mode) ? body.mode : u.mode;
    const hour = Number.isInteger(body?.hour) && body.hour >= 0 && body.hour <= 23 ? body.hour : u.hour;
    const tz = Number.isInteger(body?.tz) && Math.abs(body.tz) <= 840 ? body.tz : u.tz;
    // Если выбранный час сегодня уже прошел, первое напоминание придет завтра, а не сразу.
    const local = new Date(Date.now() + tz * 60000);
    const last = hour !== u.hour && local.getUTCHours() >= hour ? local.toISOString().slice(0, 10) : u.last_sent;
    db.run("UPDATE users SET mode=?,hour=?,tz=?,last_sent=? WHERE id=?", [mode, hour, tz, last, u.id]);
    return json(state(db.query("SELECT * FROM users WHERE id=?").get(u.id) as User));
  }
  return json({ error: "not_found" }, 404);
}

const boot = () => Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  hostname: "0.0.0.0",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/" && req.method === "GET") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      if (path === "/avatar.jpg") return new Response(Bun.file(import.meta.dir + "/avatar.jpg"), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" } });
      if (path === "/health") return json({ ok: true, bot: !!TOKEN, domain: !!DOMAIN, persistent });
      if (path === "/tick") return json({ sent: await tick() });
      if (HOOK && path === "/tg/" + HOOK && req.method === "POST") {
        if (req.headers.get("x-telegram-bot-api-secret-token") !== HOOK) return json({ error: "forbidden" }, 403);
        await onUpdate(await req.json().catch(() => null));
        return json({ ok: true });
      }
      if (path.startsWith("/api/")) return await api(req, path);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error("ERR", path, e);
      return json({ error: "server" }, 500);
    }
  },
});

// ---------- Страница ----------
const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Цели и сроки</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap">
<style>
:root{
  --bg:#F5EFE0; --surface:#FFFBF2; --ink:#0B3B2C; --muted:#5F7065; --line:#E0D7C0;
  --accent:#046648; --soon:#046648; --late:#046648; --track:#E6DDC7;
  --btn:#046648; --btn-ink:#F5EFE0;
  --hero:#046648; --hero-ink:#F5EFE0; --hero-muted:#C3D3C4; --hero-gold:#F5EFE0; --hero-cell:rgba(0,0,0,.2); --hero-line:rgba(245,239,224,.25); --gold-ink:#04553C;
  --display:"Montserrat",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --body:"Montserrat",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#06241A; --surface:#0B3327; --ink:#F5EFE0; --muted:#A8B8A8; --line:#15483A;
  --accent:#F5EFE0; --soon:#F5EFE0; --late:#F5EFE0; --track:#15483A;
  --btn:#F5EFE0; --btn-ink:#04553C; color-scheme:dark } }
:root[data-theme="dark"]{
  --bg:#06241A; --surface:#0B3327; --ink:#F5EFE0; --muted:#A8B8A8; --line:#15483A;
  --accent:#F5EFE0; --soon:#F5EFE0; --late:#F5EFE0; --track:#15483A;
  --btn:#F5EFE0; --btn-ink:#04553C; color-scheme:dark }
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.5 var(--body)}
.wrap{max-width:560px;margin:0 auto;padding-inline:16px;padding-block:calc(16px + env(safe-area-inset-top,0px)) calc(40px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:20px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{font:800 1.35rem/1.15 var(--display);margin:0;letter-spacing:-.02em}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;border-radius:10px}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{padding:10px 16px;font-weight:500;border:1px solid var(--line);background:var(--surface);min-height:44px}
.btn.primary{background:var(--btn);color:var(--btn-ink);border-color:transparent;font-weight:600}
.btn.quiet{border-color:transparent;background:none;color:var(--muted);padding-inline:10px}
.btn.danger{color:var(--late)}
.hero{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px;display:flex;flex-direction:column;gap:14px;--state:var(--accent)}
[data-state="soon"]{--state:var(--soon)} [data-state="late"]{--state:var(--late)}
.eyebrow{margin:0;font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--state)}
.hero h2{margin:0;font:600 1.35rem/1.25 var(--body);text-wrap:balance;overflow-wrap:anywhere}
.clock{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.cell{background:var(--bg);border-radius:12px;padding:12px 4px 8px;text-align:center;min-width:0}
.num{display:block;font:800 clamp(1.5rem,7.5vw,2.3rem)/1.1 var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--state)}
.lbl{font-size:.75rem;color:var(--muted)}
.bar{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;background:var(--state);border-radius:3px}
.meta{margin:0;font-size:.875rem;color:var(--muted)}
.note{margin:0;padding-top:14px;border-top:1px solid var(--line)}
.step{margin:0;font-size:.9375rem}
.step b{font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.list li{padding:14px 0;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px;--state:var(--accent)}
.list li:first-child{border-top:0}
.top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.top .t{font-weight:500;min-width:0;overflow-wrap:anywhere}
.pill{flex:none;font-size:.8125rem;font-weight:600;color:var(--state);font-variant-numeric:tabular-nums}
.sub{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:.8125rem;color:var(--muted)}
h3{margin:0;font-size:.8125rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
details summary{cursor:pointer;font-size:.875rem;color:var(--muted);padding:8px 0}
.done .t{text-decoration:line-through;color:var(--muted)}
.empty{background:var(--surface);border:1px dashed var(--line);border-radius:20px;padding:28px 20px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.empty p{margin:0;color:var(--muted);max-width:34ch}
.remind{border-top:1px solid var(--line);padding-top:20px;display:flex;flex-direction:column;gap:12px}
.remind .fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.remind .snd{grid-template-columns:1fr auto;align-items:end}
.grp{display:flex;flex-direction:column;gap:6px}
.lab{font-size:.875rem;color:var(--muted)}
.seg{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.seg button{min-height:44px;padding:8px 4px;font-size:.8125rem;font-weight:500;border-radius:0}
.seg button[aria-pressed="true"]{background:var(--btn);color:var(--btn-ink);font-weight:600}
.remind p{margin:0;font-size:.8125rem;color:var(--muted)}

.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand img{border-radius:50%;flex:none}
.goals{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.goal{background:var(--surface);border:1px solid var(--line);border-radius:16px;--state:var(--accent)}
.head{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;padding:14px 16px;border-radius:16px}
.head .eyebrow{color:var(--muted)}
.head .top{align-items:flex-start}
.panel{display:flex;flex-direction:column;gap:14px;padding:2px 16px 16px}
.goal.open{background:var(--hero);color:var(--hero-ink);border-color:transparent}
.goal.open .head .eyebrow,.goal.open .pill,.goal.open .num{color:var(--hero-gold)}
.goal.open .t{font-size:1.2rem;font-weight:600;line-height:1.25}
.goal.open .cell{background:var(--hero-cell)}
.goal.open .lbl,.goal.open .meta{color:var(--hero-muted)}
.goal.open .bar{background:var(--hero-line)}
.goal.open .bar i{background:var(--hero-gold)}
.goal.open .note{border-top-color:var(--hero-line)}
.goal.open button:focus-visible{outline-color:var(--hero-gold)}
.btn.gold{background:var(--hero-gold);color:var(--gold-ink);border-color:transparent}
.btn.ghost{background:transparent;color:var(--hero-ink);border-color:var(--hero-line)}
dialog{max-height:calc(100% - 32px);overflow:auto;border:1px solid var(--line);border-radius:20px;background:var(--surface);color:var(--ink);padding:20px;width:min(100% - 32px,440px)}
dialog::backdrop{background:rgba(10,20,17,.5)}
form{display:flex;flex-direction:column;gap:14px}
form h2{margin:0;font:600 1.125rem/1.3 var(--body)}
label{display:flex;flex-direction:column;gap:6px;font-size:.875rem;color:var(--muted);min-width:0}
input,select{font:inherit;font-size:16px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px 12px;width:100%;min-height:44px}
.remind select{background:var(--surface)}
.actions{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
#fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5}
.toast{z-index:6;position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));margin:0 auto;max-width:420px;background:var(--ink);color:var(--bg);padding:12px 16px;border-radius:12px;font-size:.9375rem;text-align:center}
</style></head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><img src="/avatar.jpg" alt="" width="40" height="40"><div><h1>Цели и сроки</h1><p class="meta" id="count"></p></div></div>
    <button class="btn primary" id="add" hidden>Новая цель</button>
  </header>
  <main id="root"><div class="empty"><p>Загружаю цели…</p></div></main>
  <section class="remind" id="remind" hidden>
    <h3>Напоминания в Telegram</h3>
    <div class="fields">
      <label>Как часто
        <select id="sMode">
          <option value="daily">Каждый день</option>
          <option value="weekly">По понедельникам</option>
          <option value="near">Только когда срок близко</option>
          <option value="off">Не присылать</option>
        </select>
      </label>
      <label>Во сколько
        <select id="sHour"></select>
      </label>
    </div>
    <p id="sHint"></p>
  </section>
  <section class="remind" id="prefs">
    <h3>Оформление и звук</h3>
    <div class="grp"><span class="lab" id="labTheme">Тема</span>
      <div class="seg" id="segTheme" role="group" aria-labelledby="labTheme">
        <button type="button" data-v="auto">Как в Telegram</button>
        <button type="button" data-v="light">Светлая</button>
        <button type="button" data-v="dark">Темная</button>
      </div>
    </div>
    <div class="fields snd">
      <label>Звук при достижении цели
        <select id="pSound">
          <option value="win">Победа</option>
          <option value="cash">Касса</option>
          <option value="fanfare">Фанфары</option>
          <option value="chime">Колокольчики</option>
          <option value="off">Без звука</option>
        </select>
      </label>
      <button type="button" class="btn" id="pTry">Прослушать</button>
    </div>
  </section>
</div>

<dialog id="dlg">
  <form id="form">
    <h2 id="dlgTitle">Новая цель</h2>
    <label>Что нужно сделать
      <input id="fTitle" required maxlength="120" placeholder="Например: сдать отчет" autocomplete="off">
    </label>
    <label>Срок
      <input id="fDate" type="date" required>
    </label>
    <label>Категория (необязательно)
      <input id="fCat" maxlength="40" placeholder="Например: Бизнес" autocomplete="off" list="cats">
      <datalist id="cats"></datalist>
    </label>
    <label>Описание или ближайший шаг (необязательно)
      <input id="fStep" maxlength="140" placeholder="Например: набросать план" autocomplete="off">
    </label>
    <div class="actions">
      <button type="button" class="btn quiet danger" id="del" hidden>Удалить</button>
      <span class="row" style="margin-left:auto">
        <button type="button" class="btn" id="cancel">Отмена</button>
        <button type="submit" class="btn primary">Сохранить</button>
      </span>
    </div>
  </form>
</dialog>
<canvas id="fx" hidden></canvas>
<div class="toast" id="toast" hidden role="status"></div>

<script>
var $=function(id){return document.getElementById(id)}, root=$('root');
var tgApp=window.Telegram&&window.Telegram.WebApp, initData=tgApp&&tgApp.initData||'';
var LS='goals-tg-v1';
var goals=[], settings=null, ready=false, editing=null, busy=false;

var prefs={theme:'auto',sound:'win'};
function readPrefs(v){try{var o=JSON.parse(v||'{}');if(o.theme)prefs.theme=o.theme;if(o.sound)prefs.sound=o.sound}catch(e){}}
try{readPrefs(localStorage.getItem('prefs'))}catch(e){}
function savePrefs(){
  var v=JSON.stringify(prefs);
  try{localStorage.setItem('prefs',v)}catch(e){}
  try{tgApp.CloudStorage.setItem('prefs',v)}catch(e){}
}
function theme(){
  var sys=tgApp&&tgApp.colorScheme?tgApp.colorScheme:(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  var t=prefs.theme==='auto'?(sys==='dark'?'dark':'light'):prefs.theme;
  document.documentElement.dataset.theme=t;
  var c=t==='dark'?'#06241A':'#F5EFE0';
  try{tgApp.setHeaderColor(c);tgApp.setBackgroundColor(c)}catch(e){}
}
if(tgApp){try{tgApp.ready();tgApp.expand();tgApp.onEvent('themeChanged',theme)}catch(e){}}
theme();
function buzz(){try{tgApp.HapticFeedback.notificationOccurred('success')}catch(e){}}

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pl(n,f){var a=n%100,b=n%10;return a>10&&a<20?f[2]:b===1?f[0]:b>=2&&b<=4?f[1]:f[2]}
var DAYS=['день','дня','дней'], HRS=['час','часа','часов'];
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function due(g){var p=String(g.deadline).split('-').map(Number);return new Date(p[0],p[1]-1,p[2],23,59,59).getTime()}
function parts(ms){var s=Math.floor(Math.max(0,ms)/1000);return{d:Math.floor(s/86400),h:Math.floor(s%86400/3600),m:Math.floor(s%3600/60),s:s%60}}
function stateOf(ms){return ms<0?'late':ms<3*864e5?'soon':'calm'}
function shortLeft(ms){
  if(ms<0){var d=Math.ceil(-ms/864e5);return 'срок прошел '+d+' '+pl(d,DAYS)+' назад'}
  var p=parts(ms);
  if(p.d>=7)return p.d+' '+pl(p.d,DAYS);
  if(p.d>=1)return p.d+' '+pl(p.d,DAYS)+' '+p.h+' ч';
  return p.h+' ч '+p.m+' мин';
}
function pct(g){var a=Date.parse(g.created)||Date.now(),b=due(g);if(b<=a)return 100;return Math.min(100,Math.max(0,Math.round((Date.now()-a)/(b-a)*100)))}
function niceDate(g){var d=new Date(due(g));return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:d.getFullYear()===new Date().getFullYear()?undefined:'numeric'})}
function note(ms){
  var p=parts(ms), d=p.d;
  if(ms<0)return 'Срок прошел, и это не провал. Можно сдвинуть дату или закрыть цель как есть.';
  if(d<1)return 'Финишная прямая: '+(p.h?'осталось '+p.h+' '+pl(p.h,HRS):'остался последний час')+'. Одного спокойного подхода может хватить.';
  if(d<3)return 'Осталось '+d+' '+pl(d,DAYS)+'. Хорошее время, чтобы закончить главное и не трогать мелочи.';
  if(d<8)return 'Впереди '+d+' '+pl(d,DAYS)+'. Один небольшой шаг сегодня заметно разгрузит конец недели.';
  if(d<31)return 'Осталось '+d+' '+pl(d,DAYS)+'. Запас есть, достаточно двигаться понемногу.';
  return 'До срока '+d+' '+pl(d,DAYS)+'. Времени много, можно идти в своем темпе.';
}

var openId=null, picked=false;
function panel(g,ms){
  var p=pct(g);
  return '<div class="panel">'
    +'<div class="clock">'+[['d','дней'],['h','часов'],['m','минут'],['s','секунд']].map(function(u){return '<div class="cell"><span class="num" data-u="'+u[0]+'">0</span><span class="lbl">'+u[1]+'</span></div>'}).join('')+'</div>'
    +'<div class="bar"><i style="width:'+p+'%"></i></div>'
    +'<p class="meta">Срок '+esc(niceDate(g))+' · прошло '+p+'% времени</p>'
    +(g.step?'<p class="step">'+esc(g.step)+'</p>':'')
    +'<p class="note">'+esc(note(ms))+'</p>'
    +'<div class="row"><button class="btn gold" data-act="done" data-id="'+esc(g.id)+'">Готово</button><button class="btn ghost" data-act="edit" data-id="'+esc(g.id)+'">Изменить</button></div>'
    +'</div>';
}
function render(){
  if(!ready&&!goals.length)return;
  var act=goals.filter(function(g){return !g.done}).sort(function(a,b){return due(a)-due(b)});
  var done=goals.filter(function(g){return g.done}).sort(function(a,b){return String(b.doneAt||'').localeCompare(String(a.doneAt||''))});
  $('count').textContent=goals.length?'Выполнено '+done.length+' из '+goals.length:'';
  var cats={};goals.forEach(function(g){if(g.cat)cats[g.cat]=1});
  $('cats').innerHTML=Object.keys(cats).map(function(c){return '<option value="'+esc(c)+'">'}).join('');
  if(!goals.length){
    root.innerHTML='<div class="empty"><p>Добавьте первую цель и срок. Здесь появится обратный отсчет.</p><button class="btn primary" data-act="new">Добавить цель</button></div>';
    return;
  }
  var now=Date.now(), near=act.filter(function(g){return due(g)>=now})[0]||act[0], h='';
  var known=act.some(function(g){return g.id===openId});
  if(near&&(!picked||(openId&&!known)))openId=near.id;
  if(act.length){
    h+='<ul class="goals">'+act.map(function(g){
      var ms=due(g)-now, open=g.id===openId;
      var tag=(g.cat||'Цель')+(g===near?' · ближайшая':'');
      return '<li class="goal'+(open?' open':'')+'" data-state="'+stateOf(ms)+'" data-goal="'+esc(g.id)+'">'
        +'<button class="head" data-act="toggle" data-id="'+esc(g.id)+'" aria-expanded="'+open+'">'
        +'<span class="eyebrow">'+esc(tag)+'</span>'
        +'<span class="top"><span class="t">'+esc(g.title)+'</span><span class="pill">'+esc(shortLeft(ms))+'</span></span>'
        +(open?'':'<span class="bar"><i style="width:'+pct(g)+'%"></i></span>')
        +'</button>'+(open?panel(g,ms):'')+'</li>';
    }).join('')+'</ul>';
  }else{
    h+='<div class="empty"><p>Все цели закрыты. Можно выдохнуть или поставить следующую.</p></div>';
  }
  if(done.length){
    h+='<details style="margin-top:16px"><summary>Выполнено: '+done.length+'</summary><ul class="list done">'+done.map(function(g){
      return '<li><div class="top"><span class="t">'+esc(g.title)+'</span><button class="btn quiet" data-act="undo" data-id="'+esc(g.id)+'">Вернуть</button></div></li>'}).join('')+'</ul></details>';
  }
  root.innerHTML=h;
  tick();
}
function tick(){
  var el=root.querySelector('.goal.open'); if(!el)return;
  var g=goals.filter(function(x){return x.id===el.dataset.goal})[0]; if(!g)return;
  var p=parts(due(g)-Date.now());
  el.querySelectorAll('.num').forEach(function(n){var v=p[n.dataset.u];n.textContent=n.dataset.u==='d'?v:String(v).padStart(2,'0')});
}
setInterval(tick,1000); setInterval(render,60000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)render()});

var ac=null;
function playSound(name){
  name=name||prefs.sound;
  if(name==='off')return;
  try{
    var AC=window.AudioContext||window.webkitAudioContext; if(!AC)return;
    ac=ac||new AC(); if(ac.state==='suspended')ac.resume();
    var t=ac.currentTime+0.03, out=ac.createGain(); out.gain.value=0.6; out.connect(ac.destination);
    var ping=function(f,at,dur,type,vol){
      var o=ac.createOscillator(), g=ac.createGain();
      o.type=type; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,at); g.gain.exponentialRampToValueAtTime(vol,at+0.012); g.gain.exponentialRampToValueAtTime(0.0001,at+dur);
      o.connect(g); g.connect(out); o.start(at); o.stop(at+dur+0.05);
    };
    var hiss=function(at,dur,vol){
      var n=Math.floor(ac.sampleRate*dur), b=ac.createBuffer(1,n,ac.sampleRate), d=b.getChannelData(0);
      for(var i=0;i<n;i++)d[i]=Math.random()*2-1;
      var src=ac.createBufferSource(), g=ac.createGain(), hp=ac.createBiquadFilter();
      src.buffer=b; hp.type='highpass'; hp.frequency.value=4000;
      g.gain.setValueAtTime(vol,at); g.gain.exponentialRampToValueAtTime(0.0001,at+dur);
      src.connect(hp); hp.connect(g); g.connect(out); src.start(at);
    };
    if(name==='cash'){
      hiss(t,0.09,0.3);
      ping(2637,t+0.05,0.9,'sine',0.22); ping(3520,t+0.05,0.7,'sine',0.12); ping(5274,t+0.05,0.5,'sine',0.06);
      for(var i=0;i<10;i++)ping(3000+Math.random()*3000,t+0.26+i*0.045,0.12,'square',0.05);
      ping(2093,t+0.74,1.2,'sine',0.2); ping(3136,t+0.74,1.0,'sine',0.12);
    }else if(name==='fanfare'){
      [[392,0,0.16],[523.25,0.18,0.16],[659.25,0.36,0.16],[783.99,0.54,0.5],[659.25,1.06,0.14],[783.99,1.22,1.1]].forEach(function(x){
        ping(x[0],t+x[1],x[2]+0.08,'sawtooth',0.11); ping(x[0],t+x[1],x[2]+0.08,'triangle',0.2); ping(x[0]*2,t+x[1],x[2],'sine',0.05);
      });
      [261.63,329.63,392].forEach(function(f){ping(f,t+1.22,1.1,'triangle',0.12)});
    }else if(name==='chime'){
      [783.99,987.77,1174.66,1567.98].forEach(function(f,i){ping(f,t+i*0.16,1.6,'sine',0.2);ping(f*2.76,t+i*0.16,0.6,'sine',0.03)});
    }else{
      ping(1568,t,0.12,'square',0.10); ping(2093,t+0.08,0.45,'square',0.09); ping(4186,t+0.08,0.4,'sine',0.08);
      [523.25,659.25,783.99,1046.5,1318.5,1568].forEach(function(f,i){ping(f,t+0.22+i*0.07,0.5,'triangle',0.24);ping(f*2,t+0.22+i*0.07,0.3,'sine',0.07)});
      [1046.5,1318.5,1568,2093].forEach(function(f){ping(f,t+0.7,1.5,'sine',0.15);ping(f*2.01,t+0.7,1.1,'sine',0.04)});
      ping(130.81,t+0.7,0.5,'sine',0.4);
    }
  }catch(e){}
}
function confetti(){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var c=$('fx'), x=c.getContext('2d'), w=c.width=innerWidth, h=c.height=innerHeight, t0=Date.now();
  var col=['#046648','#F5EFE0','#2E8B6B','#E4D9BF','#0B3327'], ps=[];
  for(var i=0;i<140;i++){var a=Math.random()*Math.PI*2, v=6+Math.random()*12;ps.push({x:w/2,y:h*0.42,vx:Math.cos(a)*v,vy:Math.sin(a)*v-7,s:5+Math.random()*7,r:Math.random()*6,c:col[i%col.length]})}
  c.hidden=false;
  (function step(){
    var k=(Date.now()-t0)/1900; x.clearRect(0,0,w,h);
    if(k>=1){c.hidden=true;return}
    ps.forEach(function(p){p.vy+=0.45;p.vx*=0.985;p.x+=p.vx;p.y+=p.vy;p.r+=0.2;x.save();x.globalAlpha=1-k*k;x.translate(p.x,p.y);x.rotate(p.r);x.fillStyle=p.c;x.fillRect(-p.s/2,-p.s/4,p.s,p.s/2);x.restore()});
    requestAnimationFrame(step);
  })();
}
function toast(t){var e=$('toast');e.textContent=t;e.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){e.hidden=true},4000)}
function hint(){
  if(!settings)return;
  var m=settings.mode, t=String(settings.hour).padStart(2,'0')+':00';
  $('sHour').disabled=m==='off';
  $('sHint').textContent=m==='off'?'Бот ничего не присылает. Остаток всегда можно узнать командой /left.'
    :m==='daily'?'Одно короткое сообщение в '+t+'. Если активных целей нет, бот молчит.'
    :m==='weekly'?'Одно сообщение по понедельникам в '+t+'.'
    :'Бот пишет в '+t+' только в те дни, когда до какой-то цели осталось меньше недели.';
}
function apply(s){
  goals=s.goals||[]; settings=s.settings||settings; ready=true;
  try{localStorage.setItem(LS,JSON.stringify(goals))}catch(e){}
  $('add').hidden=false; $('remind').hidden=false;
  if(settings){$('sMode').value=settings.mode;$('sHour').value=String(settings.hour)}
  hint(); render();
}
function call(method,path,body){
  return fetch(path,{method:method,headers:{'authorization':'tma '+initData,'content-type':'application/json'},body:body?JSON.stringify(body):undefined})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw j;return j})});
}
function send(method,path,body,okText){
  if(busy)return; busy=true;
  call(method,path,body).then(function(s){apply(s);if(okText){toast(okText);buzz()}})
    .catch(function(){toast('Не удалось сохранить. Проверьте соединение и попробуйте еще раз.')})
    .then(function(){busy=false});
}
function payload(g,over){var o={title:g.title,deadline:g.deadline,step:g.step||'',cat:g.cat||'',done:!!g.done};for(var k in over)o[k]=over[k];return o}

function openForm(g){
  editing=g||null;
  $('dlgTitle').textContent=g?'Изменить цель':'Новая цель';
  $('fTitle').value=g?g.title:'';
  $('fDate').value=g?g.deadline:iso(new Date(Date.now()+30*864e5));
  $('fStep').value=g?(g.step||''):'';
  $('fCat').value=g?(g.cat||''):'';
  var d=$('del');d.hidden=!g;d.textContent='Удалить';d.dataset.sure='';
  $('dlg').showModal();
}
$('add').onclick=function(){openForm()};
$('cancel').onclick=function(){$('dlg').close()};
$('del').onclick=function(e){
  var b=e.currentTarget;
  if(!b.dataset.sure){b.dataset.sure='1';b.textContent='Точно удалить?';return}
  var id=editing.id;$('dlg').close();send('DELETE','/api/goals/'+id);
};
$('form').addEventListener('submit',function(e){
  e.preventDefault();
  var title=$('fTitle').value.trim(), deadline=$('fDate').value;
  if(!title||!deadline)return;
  var data={title:title,deadline:deadline,step:$('fStep').value.trim(),cat:$('fCat').value.trim(),done:editing?!!editing.done:false};
  var id=editing&&editing.id;
  $('dlg').close();
  if(id)send('PUT','/api/goals/'+id,data); else send('POST','/api/goals',data);
});
root.addEventListener('click',function(e){
  var b=e.target.closest('[data-act]'); if(!b)return;
  var g=goals.filter(function(x){return x.id===b.dataset.id})[0];
  if(b.dataset.act==='new')openForm();
  else if(!g)return;
  else if(b.dataset.act==='toggle'){openId=openId===g.id?'':g.id;picked=true;render()}
  else if(b.dataset.act==='edit')openForm(g);
  else if(b.dataset.act==='done'){playSound();confetti();send('PUT','/api/goals/'+g.id,payload(g,{done:true}),'Цель закрыта. Так держать!')}
  else if(b.dataset.act==='undo')send('PUT','/api/goals/'+g.id,payload(g,{done:false}));
});
function saveSettings(){send('PUT','/api/settings',{mode:$('sMode').value,hour:Number($('sHour').value),tz:-new Date().getTimezoneOffset()})}
$('sMode').onchange=saveSettings; $('sHour').onchange=saveSettings;
(function(){var h='';for(var i=6;i<=23;i++)h+='<option value="'+i+'">'+String(i).padStart(2,'0')+':00</option>';$('sHour').innerHTML=h})();

function syncPrefs(){
  $('segTheme').querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.v===prefs.theme))});
  $('pSound').value=prefs.sound; $('pTry').disabled=prefs.sound==='off';
}
$('segTheme').onclick=function(e){var b=e.target.closest('button');if(!b)return;prefs.theme=b.dataset.v;savePrefs();theme();syncPrefs()};
$('pSound').onchange=function(){prefs.sound=$('pSound').value;savePrefs();syncPrefs();playSound()};
$('pTry').onclick=function(){playSound()};
syncPrefs();
try{tgApp.CloudStorage.getItem('prefs',function(err,v){if(!err&&v){readPrefs(v);theme();syncPrefs()}})}catch(e){}

function start(){
  if(!initData){
    root.innerHTML='<div class="empty"><p>Планер открывается внутри Telegram. Зайдите в чат с ботом и нажмите кнопку «Планер».</p></div>';
    return;
  }
  try{goals=JSON.parse(localStorage.getItem(LS)||'[]')||[]}catch(e){goals=[]}
  if(!Array.isArray(goals))goals=[];
  render();
  call('GET','/api/state').then(function(s){
    apply(s);
    var tz=-new Date().getTimezoneOffset();
    if(s.settings&&s.settings.tz!==tz)call('PUT','/api/settings',{tz:tz}).then(apply).catch(function(){});
  }).catch(function(err){
    ready=true; goals=[];
    root.innerHTML='<div class="empty"><p>'+(err&&err.error==='no_token'?'Бот еще не подключен к сервису. Нужно добавить его токен в настройках.':'Не удалось загрузить цели. Закройте планер и откройте его снова из чата с ботом.')+'</p></div>';
  });
}
start();
</script>
</body></html>`;

boot();
console.log("START: порт", Bun.env.PORT || 3000);
await setup();
