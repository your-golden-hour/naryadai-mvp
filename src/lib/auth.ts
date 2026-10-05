import { cookies } from "next/headers";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { Role, WorkerStatus, type User } from "@prisma/client";

const COOKIE_NAME = "naryadai_session";

export interface SessionUser {
  id: string;
  login: string;
  fullName: string;
  role: Role;
  specialty: string | null;
  currentStatus: WorkerStatus;
}

// --- signed stateless session token: base64(json).hmac ---
function sign(payload: string): string {
  const secret = process.env.SESSION_SECRET || "dev-secret";
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeToken(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function parseToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return data as SessionUser;
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  const user = parseToken(token);
  if (!user) return null;
  // refresh live fields (role stable, status may change)
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (!fresh) return null;
  return toSessionUser(fresh);
}

export function toSessionUser(u: User): SessionUser {
  return { id: u.id, login: u.login, fullName: u.fullName, role: u.role, specialty: u.specialty, currentStatus: u.currentStatus };
}

export function setSessionCookie(user: SessionUser) {
  cookies().set(COOKIE_NAME, makeToken(user), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });
}

export function clearSessionCookie() {
  cookies().delete(COOKIE_NAME);
}

export async function verifyPin(login: string, pin: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { login } });
  if (!user) return null;
  const ok = await bcrypt.compare(pin, user.pinHash);
  return ok ? user : null;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export function requireRole(user: SessionUser | null, roles: Role[]): boolean {
  return !!user && roles.includes(user.role);
}
