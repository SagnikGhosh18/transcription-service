import { db, users } from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { z } from "zod";

export const authRoute = new Hono();

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const credentialsSchema = z.object({
  username: z.string().min(3).max(32).regex(/^\w+$/, "Username may only contain letters, numbers and underscores"),
  password: z.string().min(8),
});

function makeToken(userId: string): Promise<string> {
  return sign(
    {
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    },
    env.JWT_SECRET,
    "HS256",
  );
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────

authRoute.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
  }

  const { username, password } = parsed.data;

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const passwordHash = await Bun.password.hash(password);

  const [user] = await db
    .insert(users)
    .values({ username, passwordHash })
    .returning({ id: users.id, username: users.username });

  if (!user) return c.json({ error: "Failed to create user" }, 500);

  const token = await makeToken(user.id);
  return c.json({ token, username: user.username }, 201);
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

authRoute.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid username or password" }, 400);
  }

  const { username, password } = parsed.data;

  const [user] = await db
    .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  const valid = await Bun.password.verify(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  const token = await makeToken(user.id);
  return c.json({ token, username: user.username });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Returns the current user. Used by the frontend to validate a stored token.

authRoute.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const { verify } = await import("hono/jwt");
  try {
    const payload = await verify(authHeader.slice(7), env.JWT_SECRET, "HS256");
    const userId = payload.sub as string;

    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json(user);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
});
