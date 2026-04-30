import "dotenv/config";
import express from "express";
import cors from "cors";
import { prioritizeRouter } from "./routes/prioritize.js";
import { parseTasksRouter } from "./routes/parseTasks.js";
import { googleRouter } from "./routes/google.js";
import { suggestDueDatesRouter } from "./routes/suggestDueDates.js";
import { suggestGoalTasksRouter } from "./routes/suggestGoalTasks.js";
import { companiesHouseRouter } from "./routes/companiesHouse.js";
import { scanPlannerRouter } from "./routes/scanPlanner.js";
import { storeRouter } from "./routes/store.js";
import { metricsRouter } from "./routes/metrics.js";
import { authMiddleware } from "./middleware/auth.js";
import { aiRateLimit } from "./middleware/aiRateLimit.js";
import { isMultiUser } from "./db.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

// CORS — wide open in dev, locked down to ALLOWED_ORIGINS (comma-separated) in prod.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  }),
);
// 10mb so the scan-planner route can accept a base64-encoded phone photo
// of the printed planner (~3-4mb image → ~4-5mb base64).
app.use(express.json({ limit: "10mb" }));

// Public health check — no auth.
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "focus3-backend",
    multiUser: isMultiUser(),
  });
});

// Google router gates its own auth internally: /callback is public (Google
// bounces back without an Authorization header), all other paths require a
// Supabase JWT. The middleware registration lives inside the router itself
// so it runs BEFORE the route handlers in stack order.
app.use("/api/google", googleRouter);
// Legacy alias — early .env.example used /auth/google/callback as the redirect URI.
app.use("/auth/google", googleRouter);

// Auth-gated routes
app.use("/api/prioritize", authMiddleware, aiRateLimit, prioritizeRouter);
app.use("/api/parse-tasks", authMiddleware, aiRateLimit, parseTasksRouter);
app.use("/api/suggest-due-dates", authMiddleware, aiRateLimit, suggestDueDatesRouter);
app.use("/api/suggest-goal-tasks", authMiddleware, aiRateLimit, suggestGoalTasksRouter);
app.use("/api/scan-planner", authMiddleware, aiRateLimit, scanPlannerRouter);
app.use("/api/companies-house", authMiddleware, companiesHouseRouter);
app.use("/api/store", authMiddleware, storeRouter);
app.use("/api/metrics", authMiddleware, metricsRouter);

app.listen(PORT, () => {
  console.log(
    `[focus3-backend] listening on http://localhost:${PORT}  ·  multiUser=${isMultiUser()}`,
  );
});
