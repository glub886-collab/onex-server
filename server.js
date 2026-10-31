const express = require('express');
const cors = require('cors');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
app.use(cors());
app.use(express.json());

// Загружаем или создаём базу
let db;
let dbFile = 'onex.db';

async function loadDb() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(dbFile)) {
    const buffer = fs.readFileSync(dbFile);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Создаём таблицы
  db.run(`
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
  
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbFile, Buffer.from(data));
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// API endpoints
app.get('/api/exchanges', (req, res) => {
  const rows = query(`
    SELECT e.*, COALESCE(h.count,0) as my_shares 
    FROM exchanges e
    LEFT JOIN holdings h ON h.exchange_id=e.id AND h.player_id=?
    ORDER BY e.created_at DESC
  `, [req.query.player_id || '']);
  res.json(rows);
});

app.post('/api/login', (req, res) => {
  const { name } = req.body;
  let p = query('SELECT * FROM players WHERE name=?', [name])[0];
  if (!p) {
    const id = Math.random().toString(36).slice(2);
    run('INSERT INTO players (id,name,coins) VALUES (?,?,1000)', [id, name]);
    p = query('SELECT * FROM players WHERE id=?', [id])[0];
  }
  res.json(p);
});

app.post('/api/exchanges', (req, res) => {
  const { player_id, name, price } = req.body;
  const p = query('SELECT * FROM players WHERE id=?', [player_id])[0];
  if (p.coins < 350) return res.status(400).json({error: 'Нужно 350 монет'});
  if (query('SELECT id FROM exchanges WHERE name=?', [name])[0]) 
    return res.status(400).json({error: 'Имя занято'});
  
  run('UPDATE players SET coins=coins-350 WHERE id=?', [player_id]);
  run('INSERT INTO exchanges (name,owner_id,owner_name,price,prev_price,next_change,created_at) VALUES (?,?,?,?,?,?,?)',
    [name, player_id, p.name, price, price, Date.now()+15000, Date.now()]);
  
  res.json({ok: true});
});

app.post('/api/buy', (req, res) => {
  const { player_id, exchange_id, count, from_owner } = req.body;
  const ex = query('SELECT * FROM exchanges WHERE id=?', [exchange_id])[0];
  const p = query('SELECT * FROM players WHERE id=?', [player_id])[0];
  const price = from_owner && ex.sell_count > 0 ? ex.sell_price : ex.price;
  const total = price * count;
  
  if (p.coins < total) return res.status(400).json({error: 'Не хватает монет'});
  
  run('UPDATE players SET coins=coins-? WHERE id=?', [total, player_id]);
  run(`INSERT INTO holdings (player_id,exchange_id,count) VALUES (?,?,?)
    ON CONFLICT(player_id,exchange_id) DO UPDATE SET count=count+?`,
    [player_id, exchange_id, count, count]);
  
  if (from_owner) {
    run('UPDATE exchanges SET sell_count=MAX(0,sell_count-?) WHERE id=?', [count, exchange_id]);
    run('UPDATE players SET coins=coins+? WHERE id=?', [total, ex.owner_id]);
  }
  
  res.json({ok: true});
});

app.post('/api/sell', (req, res) => {
  const { player_id, exchange_id, count } = req.body;
  const h = query('SELECT * FROM holdings WHERE player_id=? AND exchange_id=?', [player_id, exchange_id])[0];
  if (!h || h.count < count) return res.status(400).json({error: 'Нет акций'});
  
  const ex = query('SELECT * FROM exchanges WHERE id=?', [exchange_id])[0];
  const gain = Math.floor(ex.price * 0.9) * count;
  
  run('UPDATE players SET coins=coins+? WHERE id=?', [gain, player_id]);
  run('UPDATE holdings SET count=count-? WHERE player_id=? AND exchange_id=?', [count, player_id, exchange_id]);
  
  res.json({ok: true, gain});
});

app.post('/api/offer', (req, res) => {
  const { player_id, exchange_id, count, price } = req.body;
  const ex = query('SELECT * FROM exchanges WHERE id=?', [exchange_id])[0];
  if (ex.owner_id !== player_id) return res.status(400).json({error: 'Не владелец'});
  
  run('UPDATE exchanges SET sell_count=?, sell_price=? WHERE id=?', [count, price, exchange_id]);
  res.json({ok: true});
});

app.post('/api/sell-exchange', (req, res) => {
  const { player_id, exchange_id } = req.body;
  const ex = query('SELECT * FROM exchanges WHERE id=?', [exchange_id])[0];
  if (ex.owner_id !== player_id) return res.status(400).json({error: 'Не владелец'});
  if (Date.now() - ex.created_at < 600000) return res.status(400).json({error: 'Меньше 10 минут'});
  
  const gain = ex.price * 3;
  run('UPDATE players SET coins=coins+? WHERE id=?', [gain, player_id]);
  run('DELETE FROM exchanges WHERE id=?', [exchange_id]);
  run('DELETE FROM holdings WHERE exchange_id=?', [exchange_id]);
  
  res.json({ok: true, gain});
});

// Обновление цен
setInterval(() => {
  const now = Date.now();
  const rows = query('SELECT * FROM exchanges WHERE next_change<=?', [now]);
  for (const ex of rows) {
    const ch = Math.floor(Math.random()*21)-10;
    const np = Math.max(1, Math.min(500, ex.price+ch));
    run('UPDATE exchanges SET prev_price=price, price=?, next_change=? WHERE id=?',
      [np, now+10000+Math.random()*410000, ex.id]);
  }
}, 5000);

const PORT = process.env.PORT || 3000;
loadDb().then(() => {
  app.listen(PORT, () => console.log('Сервер на порту ' + PORT));
});
