import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

// Fungsi untuk menginisialisasi database
async function initializeDatabase() {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      username TEXT
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

    app.get('/', (req, res) => {
      res.sendFile(join(__dirname, 'index.html'));
    });

    io.on('connection', async (socket) => {
      // Handler untuk pesan chat
      socket.on('chat message', async (msg, clientOffset, username, callback) => {
        try {
          const result = await db.run(
            'INSERT INTO messages (content, client_offset, username) VALUES (?, ?, ?)', 
            msg, clientOffset, username
          );
          
          // Broadcast pesan ke semua klien
          io.emit('chat message', { 
            msg, 
            id: result.lastID, 
            username 
          });
          
          callback();
        } catch (e) {
          if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
            callback();
          } else {
            console.error('Kesalahan penyimpanan pesan:', e);
          }
        }
      });

      // Pemulihan pesan yang belum terkirim
      if (!socket.recovered) {
        try {
          await db.each(
            'SELECT id, content, username FROM messages WHERE id > ?',
            [socket.handshake.auth.serverOffset || 0],
            (_err, row) => {
              socket.emit('chat message', { 
                msg: row.content, 
                id: row.id, 
                username: row.username 
              });
            }
          );
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