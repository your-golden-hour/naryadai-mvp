import { prisma } from "../prisma";
import { notifyUser, PRIORITY_LABEL } from "../realtime";

// ============================================================================
// ИИ-МОДУЛЬ НАРЯДАЙ
// Все решения объяснимы: каждый вердикт содержит чек-лист checks[] с
// человеческим описанием. LLM используется только если задан AI_API_KEY,
// иначе — детерминированные правила (fallback обязателен для демо).
// ============================================================================

export interface EvalCheck {
  key: string;
  passed: boolean;
  severity: "blocker" | "warn" | "info";
  message: string;
}

export interface ClosureEvaluation {
  verdict: "ACCEPTED" | "ACCEPTED_WITH_NOTES" | "REWORK";
  score: number; // 0..100
  explanation: string;
  issues: string[];
  recommendations: string[];
  checks: EvalCheck[];
  modelUsed: string;
}

const STOPWORDS = new Set([
  "и","в","во","на","с","со","к","от","до","из","по","для","или","а","но","что","это",
  "не","как","был","была","было","есть","очень","уже","ещё","еще","при","об","за","над","под",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s-]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------- LLM helper (OpenAI-compatible, optional) ----------
async function llm(prompt: string, maxTokens = 600): Promise<string | null> {
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${process.env.AI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

export function aiAvailable(): boolean {
  return !!process.env.AI_API_KEY;
}

// ============================================================================
// 1. Проверка закрытия наряда
// ============================================================================
export async function evaluateOrderClosure(orderId: string): Promise<ClosureEvaluation> {
  const order = await prisma.workOrder.findUnique({
    where: { id: orderId },
    include: {
      materials: { include: { material: true } },
      photos: true,
      faultCode: true,
      equipment: true,
      assignedUser: true,
    },
  });
  if (!order) throw new Error("Наряд не найден");

  const checks: EvalCheck[] = [];
  const isEmergency = order.type === "UNPLANNED_EMERGENCY";

  // --- полнота данных ---
  const workDone = (order.workDone || "").trim();
  checks.push({
    key: "work_done",
    passed: workDone.length >= 15,
    severity: "blocker",
    message: workDone.length >= 15
      ? `Описание выполненных работ заполнено (${workDone.length} симв.)`
      : "Не заполнено описание выполненных работ (минимум 15 символов)",
  });

  checks.push({
    key: "fault_code",
    passed: !!order.faultCodeId,
    severity: "blocker",
    message: order.faultCode ? `Шифр неисправности указан: ${order.faultCode.code} — ${order.faultCode.name}` : "Не указан шифр неисправности",
  });

  // --- материалы для внеплановых ---
  if (isEmergency) {
    checks.push({
      key: "materials",
      passed: order.materials.length > 0,
      severity: "warn",
      message: order.materials.length > 0
        ? `Списаны материалы: ${order.materials.map((m) => `${m.material.name} ${m.quantity}${m.material.unit}`).join(", ")}`
        : "Для внепланового аварийного наряда не указаны списанные материалы (если ремонт без материалов — укажите в комментарии)",
    });
  } else {
    checks.push({ key: "materials", passed: true, severity: "info", message: "Плановый наряд: материалы не обязательны" });
  }

  // --- фото «после» обязательно для внеплановых ---
  const afterPhotos = order.photos.filter((p) => p.type === "AFTER");
  checks.push({
    key: "photo_after",
    passed: afterPhotos.length > 0 || !isEmergency,
    severity: isEmergency ? "blocker" : "info",
    message: afterPhotos.length > 0
      ? `Фото «после» загружено (${afterPhotos.length} шт.)`
      : isEmergency
        ? "Нет фото «после» ремонта — обязательно для внеплановых аварийных работ"
        : "Фото «после» не загружено (для плановых работ не обязательно)",
  });

  // --- проверка фото: дубликаты по hash и свежесть ---
  if (afterPhotos.length > 0) {
    const hashes = new Map<string, number>();
    for (const p of order.photos) hashes.set(p.sha256Hash, (hashes.get(p.sha256Hash) || 0) + 1);
    const dupCount = [...hashes.values()].filter((c) => c > 1).length;
    checks.push({
      key: "photo_dupes",
      passed: dupCount === 0,
      severity: dupCount > 0 ? "blocker" : "info",
      message: dupCount === 0 ? "Дубликаты фотографий не обнаружены (sha256)" : `Обнаружено дубликатов фото: ${dupCount} — одно и то же фото не подтверждает разные работы`,
    });

    const stale = afterPhotos.filter((p) => {
      const taken = p.takenAtMetadata ?? p.uploadedAt;
      const ref = order.startedAt ?? order.acceptedAt ?? order.createdAt;
      return taken.getTime() < ref.getTime() - 5 * 60e3;
    });
    checks.push({
      key: "photo_fresh",
      passed: stale.length === 0,
      severity: stale.length > 0 ? "warn" : "info",
      message: stale.length === 0
        ? "Время фото соответствует моменту выполнения работ"
        : `${stale.length} фото датировано раньше начала работ — возможно, снято заранее или это старое фото`,
    });
  }

  // --- соответствие работ проблеме ---
  const descT = tokens(order.description);
  const doneT = tokens(workDone);
  const sim = jaccard(descT, doneT);
  let codeBonus = 0;
  if (order.faultCode) {
    const codeT = tokens(order.faultCode.name);
    let hit = 0;
    for (const t of codeT) if (doneT.has(t) || descT.has(t)) hit++;
    codeBonus = codeT.size ? hit / codeT.size : 0;
  }
  const relevance = Math.max(sim, codeBonus * 0.5);
  checks.push({
    key: "relevance",
    passed: relevance >= 0.12,
    severity: "warn",
    message:
      relevance >= 0.12
        ? `Выполненные работы соответствуют описанию проблемы (сходство ${Math.round(relevance * 100)}%)`
        : `Низкое сходство описания работ (${Math.round(relevance * 100)}%) с проблемой "${order.description.slice(0, 80)}" — проверьте, тот ли дефект устранён`,
  });

  // --- логичность материалов: превышение норматива ---
  const suspicious: string[] = [];
  for (const om of order.materials) {
    const norm = om.material.normalConsumptionPerOrder;
    if (norm && om.quantity > norm * 3) {
      suspicious.push(`${om.material.name}: ${om.quantity}${om.material.unit} при норме ${norm}${om.material.unit} за наряд`);
    }
  }
  checks.push({
    key: "material_logic",
    passed: suspicious.length === 0,
    severity: "warn",
    message: suspicious.length === 0 ? "Количества материалов в пределах разумного" : `Подоздительный расход материалов: ${suspicious.join("; ")}`,
  });

  // --- время выполнения против норматива ---
  let timeOk = true;
  let timeMsg = "";
  if (order.startedAt && order.submittedAt) {
    const actualMin = (order.submittedAt.getTime() - order.startedAt.getTime()) / 60e3;
    const ratio = actualMin / Math.max(order.normTimeMinutes, 1);
    timeOk = ratio <= 2.0;
    timeMsg = `Фактически ${Math.round(actualMin)} мин при нормативе ${order.normTimeMinutes} мин (${Math.round(ratio * 100)}% норматива)`;
    if (ratio < 0.2 && actualMin < 10) {
      timeOk = false;
      timeMsg += " — подозрительно быстро, проверьте качество";
    }
  } else {
    timeMsg = "Нет отметок начала/завершения для расчёта времени";
  }
  checks.push({ key: "norm_time", passed: timeOk, severity: "warn", message: timeMsg });

  // --- подсчёт очков ---
  let score = 100;
  const blockers = checks.filter((c) => !c.passed && c.severity === "blocker");
  const warns = checks.filter((c) => !c.passed && c.severity === "warn");
  score -= blockers.length * 30 + warns.length * 12;
  score = Math.max(0, Math.min(100, score));

  const verdict: ClosureEvaluation["verdict"] =
    blockers.length > 0 ? "REWORK" : warns.length > 0 ? "ACCEPTED_WITH_NOTES" : "ACCEPTED";

  const issues = checks.filter((c) => !c.passed).map((c) => c.message);
  const recommendations: string[] = [];
  if (issues.some((i) => i.includes("фото"))) recommendations.push("Загрузите свежее фото «после» ремонта с места работ");
  if (issues.some((i) => i.includes("шифр"))) recommendations.push("Укажите шифр неисправности из справочника");
  if (issues.some((i) => i.includes("расход"))) recommendations.push("Уточните или уменьшите списание материалов либо поясните причину перерасхода");
  if (issues.some((i) => i.includes("сходство"))) recommendations.push("Дополните описание работ: свяжите их с формулировкой неисправности в наряде");
  if (recommendations.length === 0) recommendations.push("Замечаний нет — наряд можно закрывать");

  let explanation =
    verdict === "ACCEPTED"
      ? "Все проверки пройдены: данные полные, работы соответствуют проблеме, материалы в норме, фото подтверждают результат."
      : verdict === "ACCEPTED_WITH_NOTES"
        ? `Данные в целом корректны, но есть замечания: ${issues.join("; ")}`
        : `Наряд требует доработки: ${issues.join("; ")}`;

  const llmOut = await llm(
    `Ты — эксперт по приёмке ремонтных нарядов горно-обогатительного комбината. Опиши кратко (3-4 предложения, по-русски) вердикт "${verdict}" для мастера смены. Проверки: ${checks.map((c) => `${c.passed ? "+" : "-"}.${c.message}`).join(" | ")}. Не используй имена людей.`
  );
  if (llmOut) explanation = llmOut.trim();

  const modelUsed = llmOut ? process.env.AI_MODEL || "llm" : "rules-v1";

  await prisma.aIEvaluation.create({
    data: { orderId, verdict, score, explanation, checksJson: checks as object, modelUsed },
  });

  // Уведомляем исполнителя и мастера о вердикте
  const verdictLabel = verdict === "ACCEPTED" ? "принят" : verdict === "ACCEPTED_WITH_NOTES" ? "принят с замечаниями" : "требует доработки";
  if (order.assignedUserId) {
    await notifyUser(order.assignedUserId, {
      type: verdict === "REWORK" ? "REWORK" : "CLOSED",
      title: `ИИ-проверка наряда №${order.number}: ${verdictLabel} (${score}/100)`,
      message: explanation,
      orderId,
      url: `/worker/orders/${orderId}`,
    });
  }
  await notifyUser(order.masterUserId, {
    type: verdict === "REWORK" ? "REWORK" : "CLOSED",
    title: `Наряд №${order.number} отправлен на закрытие — ИИ: ${verdictLabel}`,
    message: `Оценка ${score}/100. ${issues.length ? "Замечания: " + issues.join("; ") : "Замечаний нет"}`,
    orderId,
    url: `/master/orders/${orderId}`,
  });

  return { verdict, score, explanation, issues, recommendations, checks, modelUsed };
}

// ============================================================================
// 2. Контроль сроков (планировщик каждые 60 секунд)
// ============================================================================
const reminderSent = new Set<string>();
const overdueNotified = new Set<string>();
const escalated = new Set<string>();

export async function checkDeadlines() {
  const now = Date.now();

  const active = await prisma.workOrder.findMany({
    where: { status: { in: ["ISSUED", "ACCEPTED", "QUEUED", "IN_PROGRESS", "PAUSED", "REWORK"] } },
    include: { assignedUser: true, masterUser: true },
  });

  for (const o of active) {
    const due = o.dueAt.getTime();

    // а) напоминание за 30 минут до срока
    if (due - now > 0 && due - now <= 30 * 60e3 && !reminderSent.has(o.id)) {
      reminderSent.add(o.id);
      const mins = Math.max(1, Math.round((due - now) / 60e3));
      if (o.assignedUserId) {
        await notifyUser(o.assignedUserId, {
          type: "REMINDER",
          title: `⏰ До срока по наряду №${o.number} осталось ${mins} мин`,
          message: `"${o.description.slice(0, 100)}". Срок: ${o.dueAt.toLocaleString("ru-RU")}. Завершите или приостановьте с причиной.`,
          orderId: o.id,
          url: `/worker/orders/${o.id}`,
        });
      }
    }

    // б) просрочка
    if (now > due && !overdueNotified.has(o.id)) {
      overdueNotified.add(o.id);
      if (!o.isOverdue) {
        await prisma.workOrder.update({ where: { id: o.id }, data: { isOverdue: true } });
      }
      const msg = `Наряд №${o.number} просрочен (${PRIORITY_LABEL[o.priority]}). "${o.description.slice(0, 80)}"`;
      if (o.assignedUserId) {
        await notifyUser(o.assignedUserId, { type: "OVERDUE", title: `🔴 Просрочен наряд №${o.number}`, message: msg, orderId: o.id, url: `/worker/orders/${o.id}` });
      }
      await notifyUser(o.masterUserId, { type: "OVERDUE", title: `🔴 Просрочен наряд №${o.number}`, message: msg, orderId: o.id, url: `/master/orders/${o.id}` });
    }

    // в) эскалация: наряд выдан, но не принят (аварийный — 3 мин, обычный — 10 мин)
    const escWindow = o.priority === "EMERGENCY" ? 3 * 60e3 : 10 * 60e3;
    if (o.status === "ISSUED" && o.issuedAt && now - o.issuedAt.getTime() > escWindow && !escalated.has(o.id)) {
      escalated.add(o.id);
      const suggestion = await suggestWorker(o.id);
      await notifyUser(o.masterUserId, {
        type: "ESCALATION",
        title: `⚠️ Эскалация: наряд №${o.number} не принят`,
        message:
          `${PRIORITY_LABEL[o.priority]} наряд висит без принятия более ${escWindow / 60e3} мин. ` +
          (suggestion ? `Рекомендуемый исполнитель: ${suggestion.fullName} (${suggestion.reason})` : "Свободных исполнителей нужной специальности не найдено"),
        orderId: o.id,
        url: `/master/orders/${o.id}`,
      });
    }
  }
}

// ============================================================================
// 3. Подбор исполнителя (эвристика, объяснимая)
// ============================================================================
export async function suggestWorker(orderId: string): Promise<{ userId: string; fullName: string; reason: string } | null> {
  const order = await prisma.workOrder.findUnique({ where: { id: orderId }, include: { equipment: true } });
  if (!order) return null;
  return suggestWorkerFor(order.equipmentId, order.priority);
}

export async function suggestWorkerFor(
  equipmentId: string,
  priority: string
): Promise<{ userId: string; fullName: string; reason: string } | null> {
  const eq = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!eq) return null;

  const wantedSpecialty = /насос|гидро|трубопровод|клапан/i.test(eq.type + eq.name)
    ? "Слесарь-ремонтник"
    : /двигатель|шкаф|кабель|питание|электр/i.test(eq.type + eq.name)
      ? "Электрик"
      : "Слесарь-ремонтник";

  const candidates = await prisma.user.findMany({
    where: { role: "WORKER", currentStatus: { in: ["FREE", "QUEUED"] } },
    include: {
      ratings: { orderBy: { createdAt: "desc" }, take: 1 },
      workOrders: { where: { status: { in: ["QUEUED", "IN_PROGRESS", "ACCEPTED"] } }, select: { id: true } },
    },
  });

  const scored = candidates
    .map((c) => {
      let pts = 0;
      const reasons: string[] = [];
      if (c.specialty === wantedSpecialty) { pts += 40; reasons.push(`специальность «${c.specialty}»`); }
      if (c.currentStatus === "FREE") { pts += 30; reasons.push("свободен"); }
      else { pts += Math.max(0, 30 - c.workOrders.length * 10); reasons.push(`в очереди ${c.workOrders.length} наряд(ов)`); }
      const rating = c.ratings[0]?.totalScore ?? 50;
      pts += rating * 0.2;
      reasons.push(`рейтинг ${rating.toFixed(0)}`);
      if (priority === "EMERGENCY" && (c.rank ?? 3) >= 4) { pts += 15; reasons.push("высокая квалификация для аварии"); }
      return { userId: c.id, fullName: c.fullName, reason: reasons.join(", "), pts };
    })
    .sort((a, b) => b.pts - a.pts);

  if (!scored.length) return null;
  const best = scored[0];
  return { userId: best.userId, fullName: best.fullName, reason: best.reason };
}

// ============================================================================
// 4. Предложение шифра неисправности по описанию
// ============================================================================
const KEYWORD_MAP: Record<string, string[]> = {
  M: ["подшипник", "вибрац", "износ", "разрушен", "обрыв", "ремень", "цепь", "болт", "крепеж", "корпус", "вал", "муфта", "конвейер", "дробилк", "лента"],
  E: ["двигатель", "обмотк", "коротк", "питани", "кабель", "шкаф", "автомат", "контактор", "искрит", "сгорел", "ток"],
  G: ["теч", "масло", "давлен", "гидро", "пневмо", "трубопровод", "клапан", "насос", "утечк", "загрязнен"],
  P: ["датчик", "контроллер", "показан", "калибровк", "автоматик", "управлен", "сигнал", "кип"],
  S: ["огражден", "креплен", "люк", "сетк", "обслуживан", "смазк", "чистк"],
};

export async function suggestFaultCode(description: string): Promise<{ code: string; name: string; confidence: number } | null> {
  const codes = await prisma.faultCode.findMany();
  const desc = description.toLowerCase();

  const catScores: Record<string, number> = {};
  for (const [cat, words] of Object.entries(KEYWORD_MAP)) {
    catScores[cat] = words.reduce((s, w) => s + (desc.includes(w) ? 1 : 0), 0);
  }
  const bestCat = Object.entries(catScores).sort((a, b) => b[1] - a[1])[0];

  let best: { code: string; name: string; confidence: number } | null = null;
  for (const fc of codes) {
    const fcT = tokens(fc.name);
    let hit = 0;
    for (const t of fcT) if (desc.includes(t)) hit++;
    const conf = fcT.size ? hit / fcT.size : 0;
    const catBoost = bestCat && bestCat[1] > 0 && fc.category === bestCat[0] ? 0.15 : 0;
    if (!best || conf + catBoost > best.confidence) best = { code: fc.code, name: fc.name, confidence: Math.min(1, conf + catBoost) };
  }

  if (aiAvailable() && best) {
    const out = await llm(
      `По описанию неисправности "${description}" выбери наиболее подходящий шифр из списка и верни ТОЛЬКО код. Список: ${codes.map((c) => `${c.code}=${c.name}`).join("; ")}`,
      20
    );
    if (out) {
      const found = codes.find((c) => out.toUpperCase().includes(c.code.toUpperCase()));
      if (found) return { code: found.code, name: found.name, confidence: 0.9 };
    }
  }
  return best && best.confidence > 0.1 ? best : null;
}

// ============================================================================
// 5. Отчёт по наряду (исполнителю и мастеру)
// ============================================================================
export async function generateOrderReport(orderId: string): Promise<{ forWorker: string; forMaster: string }> {
  const order = await prisma.workOrder.findUnique({
    where: { id: orderId },
    include: {
      events: { include: { user: true }, orderBy: { createdAt: "asc" } },
      materials: { include: { material: true } },
      photos: true,
      evaluations: { orderBy: { createdAt: "desc" }, take: 1 },
      equipment: true,
      assignedUser: true,
      faultCode: true,
    },
  });
  if (!order) throw new Error("Наряд не найден");

  const ev = order.evaluations[0];
  const durMin = order.startedAt && order.closedAt ? Math.round((order.closedAt.getTime() - order.startedAt.getTime()) / 60e3) : null;
  const reworkCount = order.events.filter((e) => e.toStatus === "REWORK").length;

  const timeline = order.events.map((e) => `${e.createdAt.toLocaleString("ru-RU")} — ${e.action}${e.user ? ` (${e.user.fullName})` : ""}`).join("\n");

  const quality = ev?.score ?? 0;
  let forWorker: string;
  if (ev) {
    const goodParts: string[] = [];
    const improveParts: string[] = [];
    for (const c of (ev.checksJson as unknown as EvalCheck[])) {
      if (c.passed && c.severity !== "info") goodParts.push(c.message);
      if (!c.passed) improveParts.push(c.message);
    }
    forWorker =
      `Наряд №${order.number}: оценка качества ${quality}/100, вердикт ИИ — ${ev.verdict === "ACCEPTED" ? "принято" : ev.verdict === "ACCEPTED_WITH_NOTES" ? "принято с замечаниями" : "требует доработки"}.\n` +
      `Что хорошо: ${goodParts.join("; ") || "замечаний нет"}.\n` +
      `Что улучшить: ${improveParts.join("; ") || "нет замечаний — так держать!"}` +
      (durMin != null ? `\nВремя выполнения: ${durMin} мин при нормативе ${order.normTimeMinutes} мин.` : "");
  } else {
    forWorker = `Наряд №${order.number}: ИИ-оценка ещё не выполнена.`;
  }

  const downtime = order.downtimeMinutes ?? (order.startedAt && order.closedAt ? Math.round((order.closedAt.getTime() - order.createdAt.getTime()) / 60e3) : 0);
  const forMaster =
    `Хронология:\n${timeline || "нет событий"}\n\n` +
    `Оборудование: ${order.equipment.name} (${order.equipment.inventoryNumber}), простой ≈ ${downtime} мин.\n` +
    `Шифр: ${order.faultCode ? `${order.faultCode.code} — ${order.faultCode.name}` : "не указан"}.\n` +
    `Материалы: ${order.materials.map((m) => `${m.material.name} ${m.quantity}${m.material.unit}`).join(", ") || "нет"}.\n` +
    `Фото: до ${order.photos.filter((p) => p.type === "BEFORE").length}, после ${order.photos.filter((p) => p.type === "AFTER").length}.\n` +
    `Возвратов на доработку: ${reworkCount}.\n` +
    `Вердикт ИИ: ${ev ? `${ev.verdict}, ${ev.score}/100 — ${ev.explanation}` : "нет оценки"}`;

  if (aiAvailable()) {
    const out = await llm(`Сделай краткий профессиональный отчёт мастера по наряду (5 предложений, русский, без имён): ${forMaster.slice(0, 1500).replace(/\n/g, " ")}`);
    if (out) return { forWorker, forMaster: out.trim() + "\n\n" + forMaster };
  }
  return { forWorker, forMaster };
}

// ============================================================================
// 6. Рейтинг исполнителей
// Веса: качество 40% + сроки 30% + отсутствие доработок 20% + объём/сложность 10% − штраф за отказы
// ============================================================================
export async function calculateUserRating(userId: string, days = 90) {
  const since = new Date(Date.now() - days * 864e5);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Пользователь не найден");

  const closed = await prisma.workOrder.findMany({
    where: { assignedUserId: userId, status: "CLOSED", closedAt: { gte: since } },
    include: { evaluations: { orderBy: { createdAt: "desc" }, take: 1 }, equipment: true },
  });
  const rejected = await prisma.workOrder.count({
    where: { assignedUserId: userId, status: "CANCELLED", rejectionReason: { not: null }, updatedAt: { gte: since } },
  });
  const totalAssigned = await prisma.workOrder.count({ where: { assignedUserId: userId, createdAt: { gte: since } } });

  const n = closed.length;
  const avgQuality = n ? closed.reduce((s, o) => s + (o.evaluations[0]?.score ?? 70), 0) / n : 0;
  const onTimeRate = n ? (closed.filter((o) => !o.isOverdue).length / n) * 100 : 0;

  const reworkOrders = await prisma.workOrder.findMany({
    where: { assignedUserId: userId, createdAt: { gte: since }, events: { some: { toStatus: "REWORK" } } },
    select: { id: true },
  });
  const reworkRate = totalAssigned ? (reworkOrders.length / totalAssigned) * 100 : 0;

  const criticalShare = n ? closed.filter((o) => ["HIGH", "CRITICAL"].includes(o.equipment.criticality)).length / n : 0;
  const workloadScore = Math.min(100, (n / 20) * 70 + criticalShare * 30);

  const refusalPenalty = Math.min(20, rejected * 2);

  const noReworkScore = 100 - reworkRate;
  const total = Math.max(0, Math.min(100,
    avgQuality * 0.4 + onTimeRate * 0.3 + noReworkScore * 0.2 + workloadScore * 0.1 - refusalPenalty
  ));

  const explanation =
    `Качество закрытий ${avgQuality.toFixed(0)}/100 (вес 40%), в срок ${onTimeRate.toFixed(0)}% (вес 30%), ` +
    `без доработок ${noReworkScore.toFixed(0)}% (доработки: ${reworkRate.toFixed(0)}%, вес 20%), ` +
    `загрузка/сложность ${workloadScore.toFixed(0)} (закрыто ${n}, вес 10%), ` +
    `штраф за необоснованные отказы −${refusalPenalty.toFixed(0)}.`;

  await prisma.ratingSnapshot.create({
    data: {
      userId, periodStart: since, periodEnd: new Date(),
      averageQualityScore: avgQuality, onTimeRate, reworkRate, workloadScore, refusalPenalty, totalScore: total, explanation,
    },
  });

  return { userId, fullName: user.fullName, specialty: user.specialty, total, avgQuality, onTimeRate, reworkRate, workloadScore, refusalPenalty, closedCount: n, explanation };
}

export async function allRatings(days = 90) {
  const workers = await prisma.user.findMany({ where: { role: "WORKER" } });
  const rows = await Promise.all(workers.map((w) => calculateUserRating(w.id, days)));
  return rows.sort((a, b) => b.total - a.total);
}

// ============================================================================
// 7. Отчёт за смену
// ============================================================================
export async function generateShiftReport(masterId: string, date?: Date) {
  const dayStart = new Date(date ?? new Date());
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const orders = await prisma.workOrder.findMany({
    where: { masterUserId: masterId, createdAt: { gte: dayStart, lt: dayEnd } },
    include: { assignedUser: true, equipment: true },
  });

  const issuedCount = orders.length;
  const completedCount = orders.filter((o) => o.status === "CLOSED").length;
  const overdueCount = orders.filter((o) => o.isOverdue).length;
  const rejectedCount = orders.filter((o) => o.status === "CANCELLED").length;
  const downtimeMinutes = orders.reduce(
    (s, o) => s + (o.downtimeMinutes ?? (o.closedAt ? Math.round((o.closedAt.getTime() - o.createdAt.getTime()) / 60e3) : 0)),
    0
  );

  const byWorker = new Map<string, number>();
  orders.forEach((o) => {
    if (o.assignedUser) byWorker.set(o.assignedUser.fullName, (byWorker.get(o.assignedUser.fullName) || 0) + 1);
  });
  const loadList = [...byWorker.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const summaryTemplate =
    `Смена ${dayStart.toLocaleDateString("ru-RU")}: выдано ${issuedCount}, закрыто ${completedCount}, просрочено ${overdueCount}, отклонено ${rejectedCount}. ` +
    `Суммарный простой оборудования ≈ ${downtimeMinutes} мин. ` +
    (overdueCount > 0 ? `Есть ${overdueCount} просроченных нарядов — требуется разбор причин. ` : "Просроченных нарядов нет. ") +
    (loadList.length ? `Загрузка исполнителей: ${loadList.map(([n, c]) => `${n} — ${c}`).join(", ")}.` : "");

  let summaryText = summaryTemplate;
  if (aiAvailable()) {
    const out = await llm(`Напиши управляющую сводку за смену ГОКа (4 предложения, русский, без имён): ${summaryTemplate}`);
    if (out) summaryText = out.trim();
  }

  const existing = await prisma.shiftReport.findFirst({ where: { masterId, date: dayStart } });
  const report = existing
    ? await prisma.shiftReport.update({
        where: { id: existing.id },
        data: { issuedCount, completedCount, overdueCount, rejectedCount, downtimeMinutes, summaryText },
      })
    : await prisma.shiftReport.create({
        data: { masterId, date: dayStart, issuedCount, completedCount, overdueCount, rejectedCount, downtimeMinutes, summaryText },
      });

  return { report, metrics: { issuedCount, completedCount, overdueCount, rejectedCount, downtimeMinutes }, loadList, summaryText };
}
