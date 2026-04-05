import { env } from "@my-better-t-app/env/server";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

export type AuthVariables = { userId: string };

/**
 * JWT Bearer middleware.
 * Reads Authorization: Bearer <token>, verifies it, and sets c.var.userId.
 * Returns 401 if the header is missing or the token is invalid/expired.
 */
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const payload = await verify(token, env.JWT_SECRET, "HS256");
      c.set("userId", payload.sub as string);
      await next();
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
  },
);
