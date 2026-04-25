import express from "express";
import cors from "cors";
import { prioritizeRouter } from "./routes/prioritize.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "focus3-backend" });
});

app.use("/api/prioritize", prioritizeRouter);

app.listen(PORT, () => {
  console.log(`[focus3-backend] listening on http://localhost:${PORT}`);
});
