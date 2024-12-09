import express from 'express';
import 'dotenv/config'
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import mysql from 'mysql2/promise';

// Fungsi untuk menginisialisasi database
async function initializeDatabase() {
  const db = await mysql.createConnection({
    host    : process.env.DB_HOST,
    user    : process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content TEXT,
      sender VARCHAR(255),
      receiver VARCHAR(255),
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

// Fungsi utama untuk menjalankan server
async function startServer() {
  if (cluster.isPrimary) {
    const numCPUs = availableParallelism();
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork({
        PORT: 3000 + i
      });
    }
    setupPrimary();
  } else {
    const db = await initializeDatabase();
    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
      connectionStateRecovery: {},
      adapter: createAdapter()
    });

    const __dirname = dirname(fileURLToPath(import.meta.url));
    
    // Middleware untuk melayani file statis
    app.use(express.static(__dirname));

    app.get('/:username', (req, res) => {
      const { username } = req.params;
      res.sendFile(join(__dirname, 'index.html'), { username });
    });

    io.on('connection', async (socket) => {
      // Handler untuk pesan chat
      socket.on('chat message', async (msg, clientOffset, sender, receiver, callback) => {        
        try {
          const [result] = await db.execute(
            'INSERT INTO messages (content, sender, receiver) VALUES (?, ?, ?)', 
            [msg, sender, receiver || null]
          );
          
          // Broadcast pesan ke semua klient
          io.emit('chat message', { 
            msg, 
            id: result.insertId, 
            sender, 
            receiver 
          });
          
          callback();
        } catch (e) {
          console.error('Kesalahan penyimpanan pesan:', e);
          callback(e);
        }
      });

      // Pemulihan pesan yang belum terkirim
      if (!socket.recovered) {
        try {
          const [rows] = await db.execute(
            'SELECT id, content, sender, receiver FROM messages WHERE id > ?',
            [socket.handshake.auth.serverOffset || 0]
          );
          rows.forEach(row => {
            socket.emit('chat message', { 
              msg: row.content, 
              id: row.id, 
              sender: row.sender, 
              receiver: row.receiver 
            });
          });
        } catch (e) {
          console.error('Kesalahan pemulihan pesan:', e);
        }
      }
    });

    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`Server berjalan di http://localhost:${port}`);
    });
  }
}

// Jalankan server
startServer().catch(console.error);
