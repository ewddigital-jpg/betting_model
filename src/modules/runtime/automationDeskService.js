import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTOMATION_IDS = ["project-reviewer", "project-implementer"];
const WORKSPACE_ROOT = process.cwd();
const CODE_DIRECTORIES = new Set(["src", "public", "scripts", "tests", "docs"]);
const STANDALONE_FILES = new Set(["package.json", "package-lock.json", "README.md"]);

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseTomlValue(raw) {
  const value = raw.trim();

  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replaceAll("\\n", "\n");
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^"(.*)"$/u, "$1"));
  }

  return value;
}

function parseAutomationToml(contents) {
  const data = {};

  for (const line of contents.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/u);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    data[key] = parseTomlValue(rawValue);
  }

  return data;
}

function getAutomationConfig(automationId) {
  const automationPath = path.join(os.homedir(), ".codex", "automations", automationId, "automation.toml");
  const contents = readTextIfExists(automationPath);
  if (!contents) {
    return null;
  }

  const stats = fs.statSync(automationPath);
  const parsed = parseAutomationToml(contents);

  return {
    id: parsed.id ?? automationId,
    name: parsed.name ?? automationId,
    prompt: parsed.prompt ?? "",
    status: parsed.status ?? "UNKNOWN",
    schedule: parsed.rrule ?? null,
    executionEnvironment: parsed.execution_environment ?? null,
    cwd: Array.isArray(parsed.cwds) ? parsed.cwds[0] ?? null : null,
    updatedAt: parsed.updated_at ? new Date(Number(parsed.updated_at)).toISOString() : stats.mtime.toISOString()
  };
}

function getAuditSnapshot() {
  const auditPath = path.join(WORKSPACE_ROOT, "reports", "project-audit-latest.json");
  const contents = readTextIfExists(auditPath);
  if (!contents) {
    return null;
  }

  try {
    const audit = JSON.parse(contents);
    return {
      generatedAt: audit.generatedAt ?? null,
      healthScore: audit.scoreboard?.trustPercent ?? null,
      blindLeanAccuracy: audit.scoreboard?.blindLeanAccuracy ?? null,
      topFindings: (audit.findings ?? []).slice(0, 3).map((finding) => ({
        priority: finding.priority,
        title: finding.title,
        detail: finding.detail,
        action: finding.action
      })),
      bestNextPrompt: audit.recommendedTasks?.[0]?.prompt ?? audit.prompts?.[0] ?? null
    };
  } catch {
    return null;
  }
}

function shouldTrackFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const [topLevel] = normalized.split("/");
  return CODE_DIRECTORIES.has(topLevel) || STANDALONE_FILES.has(normalized);
}

function listRecentProjectChanges(limit = 12) {
  const results = [];
  const stack = [WORKSPACE_ROOT];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "data" || entry.name === "reports") {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(WORKSPACE_ROOT, fullPath);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!shouldTrackFile(relativePath)) {
        continue;
      }

      const stats = fs.statSync(fullPath);
      results.push({
        path: relativePath.replaceAll("\\", "/"),
        modifiedAt: stats.mtime.toISOString(),
        size: stats.size
      });
    }
  }

  return results
    .sort((left, right) => new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime())
    .slice(0, limit);
}

export function getAutomationDesk() {
  const automations = Object.fromEntries(
    AUTOMATION_IDS.map((automationId) => [automationId, getAutomationConfig(automationId)])
  );

  return {
    generatedAt: new Date().toISOString(),
    reviewer: automations["project-reviewer"],
    implementer: automations["project-implementer"],
    audit: getAuditSnapshot(),
    recentProjectChanges: listRecentProjectChanges()
  };
}
