import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoute } from "./routes/auth";
import { chunksRoute } from "./routes/chunks";
import { recordingsRoute } from "./routes/recordings";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/", (c) => c.text("OK"));

app.route("/api/auth", authRoute);
app.route("/api/recordings", recordingsRoute);
app.route("/api/chunks", chunksRoute);

export default {
  port: 8080,
  fetch: app.fetch,
};
