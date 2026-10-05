"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";

export interface SessionUser {
  id: string;
  login: string;
  fullName: string;
  role: "MASTER" | "WORKER" | "MANAGER" | "ADMIN";
  specialty: string | null;
  currentStatus: string;
}

// Глобальный сокет-синглтон для всего клиента
let socketRef: Socket | null = null;
export function getSocket(): Socket | null {
  return socketRef;
}

export function connectSocket(user: SessionUser): Socket {
  if (socketRef?.connected && (socketRef as any).__authUser === user.id) return socketRef;
  if (socketRef) socketRef.disconnect();
  socketRef = io({ auth: { userId: user.id, role: user.role }, transports: ["websocket", "polling"] });
  (socketRef as any).__authUser = user.id;
  return socketRef;
}

const ROLE_HOME: Record<string, string> = {
  MASTER: "/master/dashboard",
  WORKER: "/worker/orders",
  MANAGER: "/manager/analytics",
  ADMIN: "/master/dashboard",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [notifCount, setNotifCount] = useState(0);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const u: SessionUser | null = data?.user ?? null;
        setUser(u);
        setLoading(false);
        if (u) {
          const s = connectSocket(u);
          s.on("notification.created", () => refreshNotifCount());
          refreshNotifCount();
        }
      })
      .catch(() => setLoading(false));

    // service worker для Web Push
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  async function refreshNotifCount() {
    try {
      const r = await fetch("/api/notifications?unread=1");
      if (r.ok) {
        const d = await r.json();
        setNotifCount(d.unread ?? 0);
      }
    } catch {}
  }

  // редирект неавторизованных с защищённых страниц
  useEffect(() => {
    if (!loading && !user && pathname !== "/login") router.replace("/login");
    if (!loading && user && pathname === "/") router.replace(ROLE_HOME[user.role] || "/login");
  }, [loading, user, pathname, router]);

  const isAuthed = !!user && pathname !== "/login" && pathname !== "/";

  return (
    <div className="min-h-screen flex flex-col">
      {isAuthed && (
        <header className="sticky top-0 z-40 bg-slate-900 text-white shadow">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href={ROLE_HOME[user!.role]} className="flex items-center gap-2 font-bold">
              <span className="text-xl">⚙️</span> НарядAI
            </Link>
            <div className="flex items-center gap-3">
              <Link href="/notifications" className="relative p-2" aria-label="Уведомления">
                🔔
                {notifCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold">
                    {notifCount}
                  </span>
                )}
              </Link>
              <span className="hidden text-sm sm:block">{user!.fullName}</span>
              <button
                className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm"
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST" });
                  router.replace("/login");
                }}
              >
                Выйти
              </button>
            </div>
          </div>
        </header>
      )}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-4 pb-24">{children}</main>

      {isAuthed && user!.role === "MASTER" && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl justify-around py-2 text-sm font-medium">
            <NavLink href="/master/dashboard" label="Доска" icon="📋" />
            <NavLink href="/master/orders/new" label="Создать" icon="➕" />
            <NavLink href="/master/shift-report" label="Смена" icon="📊" />
            <NavLink href="/master/rating" label="Рейтинг" icon="🏅" />
          </div>
        </nav>
      )}
      {isAuthed && user!.role === "WORKER" && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl justify-around py-2 text-sm font-medium">
            <NavLink href="/worker/orders" label="Наряды" icon="🔧" />
            <NavLink href="/worker/queue" label="Очередь" icon="📆" />
            <NavLink href="/worker/rating" label="Мой рейтинг" icon="🏅" />
          </div>
        </nav>
      )}
      {isAuthed && user!.role === "MANAGER" && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl justify-around py-2 text-sm font-medium">
            <NavLink href="/manager/analytics" label="Аналитика" icon="📈" />
          </div>
        </nav>
      )}
    </div>
  );
}

function NavLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  const pathname = usePathname();
  const active = pathname.startsWith(href);
  return (
    <Link href={href} className={`flex flex-col items-center gap-0.5 rounded-xl px-3 py-1 ${active ? "text-blue-600" : "text-slate-500"}`}>
      <span className="text-xl">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}
