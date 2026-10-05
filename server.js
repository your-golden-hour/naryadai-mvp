/**
 * НарядAI — кастомный Next.js сервер с Socket.IO и планировщиком ИИ.
 * Запуск: npm run dev
 */
const { createServer } = require("http");
const next = require("next");
const { Server } = require("socket.io");
const cron = require("node-cron");
require("dotenv").config();

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  const io = new Server(server, { cors: { origin: "*" } });
  // Мост для TS-кода приложения (src/lib/realtime.ts читает globalThis.io)
  globalThis.io = io;

  io.on("connection", (socket) => {
    const { userId, role } = socket.handshake.auth || {};
    if (userId) socket.join(`user:${userId}`);
    if (role === "MASTER" || role === "ADMIN") socket.join("masters");
    if (role === "MANAGER") socket.join("managers");
    socket.on("order:watch", (orderId) => socket.join(`order:${orderId}`));
    socket.on("order:unwatch", (orderId) => socket.leave(`order:${orderId}`));
  });

  // Планировщик ИИ: контроль сроков каждые 60 секунд.
  // Саму проверку выполняет API-роут /api/internal/tick (работает в TS-контексте Next).
  cron.schedule("* * * * *", async () => {
    try {
      const internalSecret = process.env.SESSION_SECRET || "dev-secret";
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/tick`, {
        method: "POST",
        headers: { "x-internal-secret": internalSecret },
      });
      if (!res.ok) console.warn("[cron] tick failed:", res.status);
    } catch (e) {
      console.warn("[cron] tick error:", e.message);
    }
  });
  console.log("[cron] ИИ-контроль сроков: каждые 60 секунд");

  server.listen(port, hostname, () => {
    console.log(`✅ НарядAI готов: http://localhost:${port} (dev=${dev})`);
  });
});
