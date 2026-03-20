import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { env } from "./config/env.js";
import { getDb } from "./db/database.js";
import { logger } from "./lib/logger.js";
import { syncIfStale } from "./modules/data/syncService.js";
import { startBackgroundJobs } from "./modules/runtime/backgroundJobs.js";
import { handleApiRequest } from "./routes/apiRouter.js";
import { handlePageRequest } from "./routes/pageRouter.js";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStaticFile(response, pathname) {
  const filePath = path.join(process.cwd(), pathname);

  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream"
  });
  response.end(fs.readFileSync(filePath));
}

getDb();

syncIfStale().catch((error) => {
  logger.warn("Startup sync skipped", { message: error.message });
});
startBackgroundJobs();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith("/public/")) {
    serveStaticFile(response, url.pathname);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApiRequest(request, response, url);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/matches/"))) {
    handlePageRequest(response, url.pathname);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Route not found.");
});

server.listen(env.port, () => {
  logger.info("Server started", { port: env.port });
});
