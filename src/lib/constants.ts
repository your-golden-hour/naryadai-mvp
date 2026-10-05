import { OrderStatus, Priority } from "@prisma/client";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  CREATED: "Создан",
  ISSUED: "Выдан",
  ACCEPTED: "Принят",
  QUEUED: "В очереди",
  IN_PROGRESS: "В работе",
  PAUSED: "Приостановлен",
  SUBMITTED: "На закрытии",
  REWORK: "Требует доработки",
  CLOSED: "Закрыт",
  CANCELLED: "Отменён",
};

export const STATUS_COLOR: Record<OrderStatus, string> = {
  CREATED: "bg-slate-100 text-slate-700 border-slate-300",
  ISSUED: "bg-sky-100 text-sky-800 border-sky-300",
  ACCEPTED: "bg-teal-100 text-teal-800 border-teal-300",
  QUEUED: "bg-blue-100 text-blue-800 border-blue-300",
  IN_PROGRESS: "bg-amber-100 text-amber-800 border-amber-300",
  PAUSED: "bg-orange-100 text-orange-800 border-orange-300",
  SUBMITTED: "bg-violet-100 text-violet-800 border-violet-300",
  REWORK: "bg-rose-100 text-rose-800 border-rose-300",
  CLOSED: "bg-green-100 text-green-800 border-green-300",
  CANCELLED: "bg-gray-200 text-gray-600 border-gray-400",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  EMERGENCY: "Аварийный",
  HIGH: "Высокий",
  NORMAL: "Обычный",
  PLANNED: "Плановый",
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  EMERGENCY: "bg-red-600 text-white",
  HIGH: "bg-orange-500 text-white",
  NORMAL: "bg-sky-600 text-white",
  PLANNED: "bg-slate-500 text-white",
};

export const WORKER_STATUS_META = {
  FREE: { label: "Свободен", dot: "bg-green-500" },
  BUSY: { label: "В работе", dot: "bg-yellow-400" },
  QUEUED: { label: "Есть очередь", dot: "bg-blue-500" },
  OFF_SHIFT: { label: "Не на смене", dot: "bg-gray-400" },
} as const;

export const CATEGORY_LABEL: Record<string, string> = {
  M: "М — Механика",
  E: "Э — Электрика",
  G: "Г — Гидравлика/пневматика",
  P: "П — Приборы/автоматика",
  S: "С — Прочее",
};

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtFullDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeLeft(dueAt: Date | string, now = Date.now()): { text: string; overdue: boolean; soon: boolean } {
  const due = (typeof dueAt === "string" ? new Date(dueAt) : dueAt).getTime();
  const diff = due - now;
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600e3);
  const m = Math.floor((abs % 3600e3) / 60e3);
  const text = overdue ? `просрочен ${h > 0 ? `${h} ч ` : ""}${m} мин` : `осталось ${h > 0 ? `${h} ч ` : ""}${m} мин`;
  return { text, overdue, soon: !overdue && diff < 30 * 60e3 };
}
