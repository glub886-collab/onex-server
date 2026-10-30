const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');

const app = express();
const db = new Database('onex.db');

app.use(cors());
app.use(express.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    owner_id TEXT,
    owner_name TEXT,
    price INTEGER,
    prev_price INTEGER,
    next_change INTEGER,
    created_at INTEGER,
    sell_count INTEGER DEFAULT 0,
    sell_price INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS holdings (
    player_id TEXT,
    exchange_id INTEGER,
    count INTEGER DEFAULT 0,
    PRIMARY KEY(player_id, exchange_id)
  );
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT,
    coins INTEGER DEFAULT 1000
  );
`);

app.get('/api/exchanges', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, COALESCE(h.count,0) as my_shares 
    FROM exchanges e
    LEFT JOIN holdings h ON h.exchange_id=e.id AND h.player_id=?
    ORDER BY e.created_at DESC
  `).all(req.query.player_id || '');
  res.json(rows);
});

app.post('/api/login', (req, res) => {
  const { name } = req.body;
  let p = db.prepare('SELECT * FROM players WHERE name=?').get(name);
  if (!p) {
    const id = Math.random().toString(36).slice(2);
    db.prepare('INSERT INTO players (id,name,coins) VALUES (?,?,1000)').run(id, name);
    p = db.prepare('SELECT * FROM players WHERE id=?').get(id);
  }
  res.json(p);
});

app.post('/api/exchanges', (req, res) => {
  const { player_id, name, price } = req.body;
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(player_id);
  if (p.coins < 350) return res.status(400).json({error: 'Нужно 350 монет'});
  if (db.prepare('SELECT id FROM exchanges WHERE name=?').get(name)) 
    return res.status(400).json({error: 'Имя занято'});
  
  db.transaction(() => {
    db.prepare('UPDATE players SET coins=coins-350 WHERE id=?').run(player_id);
    db.prepare('INSERT INTO exchanges (name,owner_id,owner_name,price,prev_price,next_change,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(name, player_id, p.name, price, price, Date.now()+15000, Date.now());
  })();
  res.json({ok: true});
});

app.post('/api/buy', (req, res) => {
  const { player_id, exchange_id, count, from_owner } = req.body;
  const ex = db.prepare('SELECT * FROM exchanges WHERE id=?').get(exchange_id);
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(player_id);
  const price = from_owner && ex.sell_count > 0 ? ex.sell_price : ex.price;
  const total = price * count;
  
  if (p.coins < total) return res.status(400).json({error: 'Не хватает монет'});
  
  db.transaction(() => {
    db.prepare('UPDATE players SET coins=coins-? WHERE id=?').run(total, player_id);
    db.prepare(`INSERT INTO holdings (player_id,exchange_id,count) VALUES (?,?,?)
      ON CONFLICT(player_id,exchange_id) DO UPDATE SET count=count+?`)
      .run(player_id, exchange_id, count, count);
    if (from_owner) {
      db.prepare('UPDATE exchanges SET sell_count=MAX(0,sell_count-?) WHERE id=?').run(count, exchange_id);
      db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(total, ex.owner_id);
    }
  })();
  res.json({ok: true});
});

app.post('/api/sell', (req, res) => {
  const { player_id, exchange_id, count } = req.body;
  const h = db.prepare('SELECT * FROM holdings WHERE player_id=? AND exchange_id=?').get(player_id, exchange_id);
  if (!h || h.count < count) return res.status(400).json({error: 'Нет акций'});
  
  const ex = db.prepare('SELECT * FROM exchanges WHERE id=?').get(exchange_id);
  const gain = Math.floor(ex.price * 0.9) * count;
  
  db.transaction(() => {
    db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(gain, player_id);
    db.prepare('UPDATE holdings SET count=count-? WHERE player_id=? AND exchange_id=?').run(count, player_id, exchange_id);
  })();
  res.json({ok: true, gain});
});

app.post('/api/offer', (req, res) => {
  const { player_id, exchange_id, count, price } = req.body;
  const ex = db.prepare('SELECT * FROM exchanges WHERE id=?').get(exchange_id);
  if (ex.owner_id !== player_id) return res.status(400).json({error: 'Не владелец'});
  
  db.prepare('UPDATE exchanges SET sell_count=?, sell_price=? WHERE id=?').run(count, price, exchange_id);
  res.json({ok: true});
});

app.post('/api/sell-exchange', (req, res) => {
  const { player_id, exchange_id } = req.body;
  const ex = db.prepare('SELECT * FROM exchanges WHERE id=?').get(exchange_id);
  if (ex.owner_id !== player_id) return res.status(400).json({error: 'Не владелец'});
  if (Date.now() - ex.created_at < 600000) return res.status(400).json({error: 'Меньше 10 минут'});
  
  const gain = ex.price * 3;
  db.transaction(() => {
    db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(gain, player_id);
    db.prepare('DELETE FROM exchanges WHERE id=?').run(exchange_id);
    db.prepare('DELETE FROM holdings WHERE exchange_id=?').run(exchange_id);
  })();
  res.json({ok: true, gain});
});

setInterval(() => {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM exchanges WHERE next_change<=?').all(now);
  for (const ex of rows) {
    const ch = Math.floor(Math.random()*21)-10;
    const np = Math.max(1, Math.min(500, ex.price+ch));
    db.prepare('UPDATE exchanges SET prev_price=price, price=?, next_change=? WHERE id=?')
      .run(np, now+10000+Math.random()*410000, ex.id);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Сервер на порту ' + PORT));
