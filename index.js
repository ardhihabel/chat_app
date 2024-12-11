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
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE,
      password VARCHAR(255),
      role JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      content TEXT,
      sender_id INT,
      receiver_id INT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
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

    app.get('/:userID', (req, res) => {
      const { userID } = req.params;
      res.sendFile(join(__dirname, 'index.html'), { userID });
    });

    io.on('connection', async (socket) => {
      // Handler untuk pesan chat
      socket.on('chat message', async (msg, clientOffset, sender_id, receiver_id, callback) => {        
        try {
            const [result] = await db.execute(
            'INSERT INTO messages (content, sender_id, receiver_id) VALUES (?, ?, ?)', 
            [msg, sender_id, receiver_id || null]
            );

            const [rows] = await db.execute(
            'SELECT m.id, m.content, m.sender_id, m.receiver_id, u1.username AS sender_name, u2.username AS receiver_name FROM messages m LEFT JOIN users u1 ON m.sender_id = u1.id LEFT JOIN users u2 ON m.receiver_id = u2.id WHERE m.id = ?',
            [result.insertId]
            );

            const messageData = rows[0];
            const { sender_name, receiver_name } = messageData;
          
          // Broadcast pesan ke semua klient
          io.emit('chat message', { 
            msg, 
            id: result.insertId, 
            sender_id, 
            receiver_id,
            sender_name,
            receiver_name
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
            'SELECT m.id, m.content, m.sender_id, m.receiver_id, u1.username AS sender_name, u2.username AS receiver_name FROM messages m LEFT JOIN users u1 ON m.sender_id = u1.id LEFT JOIN users u2 ON m.receiver_id = u2.id WHERE m.id > ?',
            [socket.handshake.auth.serverOffset || 0]
          );
          
          rows.forEach(row => {
            socket.emit('chat message', { 
              msg: row.content, 
              id: row.id, 
              sender_name: row.sender_name, 
              receiver_name: row.receiver_name,
              sender_id: row.sender_id,
              receiver_id: row.receiver_id
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
