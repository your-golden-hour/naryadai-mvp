import type { Server as HttpServer } from "node:http";
import type { SocketId, Server as IOServer } from "socket.io";
import { Notification, Priority, WorkerStatus } from "@prisma/client";
import { prisma } from "./prisma";

// Global singleton so Next.js API routes (dev HMR-safe) and the custom server share one IO instance.
// server.js sets globalThis.io directly; setIO() is kept for explicit wiring/tests.
const globalForIo = globalThis as unknown as { io?: IOServer };

export function setIO(io: IOServer) {
  globalForIo.io = io;
}

export function getIO(): IOServer | null {
  return globalForIo.io ?? null;
}

// ---------- Socket auth (shared secret handshake in server.js) ----------
export const SOCKET_HANDSHAKE_SECRET = process.env.SESSION_SECRET || "dev-secret";

// ---------- Real-time room helpers ----------
export function emitOrderUpdated(orderId: string, payload: unknown) {
  const io = getIO();
  if (!io) return;
  io.to(`order:${orderId}`).emit("order.updated", payload);
  io.to("masters").emit("board.update", payload);
}

export function emitWorkerStatus(userId: string, status: WorkerStatus) {
  const io = getIO();
  if (!io) return;
  io.to("masters").emit("worker.status_changed", { userId, status });
}

// ---------- Web Push ----------
let webpushInitialized = false;
async function ensureWebPush() {
  if (webpushInitialized) return true;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:demo@naryadai.local", publicKey, privateKey);
  webpushInitialized = true;
  return true;
}

async function sendWebPush(subscriptionJson: string | null, title: string, body: string, url: string) {
  if (!subscriptionJson) return false;
  try {
    if (!(await ensureWebPush())) return false;
    const webpush = (await import("web-push")).default;
    await webpush.sendNotification(JSON.parse(subscriptionJson), JSON.stringify({ title, body, url }));
    return true;
  } catch (e) {
    console.warn("[push] send failed:", (e as Error).message);
    return false;
  }
}

// Telegram заглушка (roadmap): логируем вместо реальной отправки
function telegramStub(chatId: string | null, text: string) {
  if (chatId) console.log(`[telegram-stub] to ${chatId}: ${text.replace(/\n/g, " ")}`);
}

// ---------- Central notification dispatcher ----------
export async function notifyUser(
  userId: string,
  args: { type: Notification["type"]; title: string; message: string; orderId?: string; url?: string }
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  // 1. In-app notification record
  const notif = await prisma.notification.create({
    data: {
      userId,
      orderId: args.orderId ?? null,
      type: args.type,
      title: args.title,
      message: args.message,
    },
  });

  // 2. Real-time event
  const io = getIO();
  io?.to(`user:${userId}`).emit("notification.created", notif);

  // 3. Web Push (fallback: silently skip if unavailable — in-app + socket still delivered)
  const sent = await sendWebPush(user.pushSubscription, args.title, args.message, args.url || "/");
  if (!sent) {
    // fallback log for demo environment
    console.log(`[notify-fallback] user=${user.login} type=${args.type}: ${args.title} — ${args.message}`);
  }

  // 4. Telegram stub
  telegramStub(user.telegramChatId, `${args.title}: ${args.message}`);
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  EMERGENCY: "Аварийный",
  HIGH: "Высокий",
  NORMAL: "Обычный",
  PLANNED: "Плановый",
};
