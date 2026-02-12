import { execSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
// No runtime dependencies — tool parameters use plain JSON Schema objects

// --- Auth ---
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function getAccessToken(): string {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  try {
    cachedToken = execSync(
      "gcloud auth application-default print-access-token 2>/dev/null",
      { encoding: "utf8" }
    ).trim();
    tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return cachedToken;
  } catch {
    throw new Error(
      "Failed to get ADC token. Run: gcloud auth application-default login"
    );
  }
}

// --- Config ---
const BASE = "https://LOCATION-aiplatform.googleapis.com/v1beta1";

interface MemoryBankConfig {
  projectId: string;
  location: string;
  reasoningEngineId: string;
  scope?: Record<string, string>;
  autoRecall?: boolean;
  autoCapture?: boolean;
  autoSyncFiles?: boolean;
  autoSyncTopics?: boolean;
  memoryTopics?: Array<any>;
  perspective?: "first" | "third";
  topK?: number;
  maxDistance?: number;
  backgroundGenerate?: boolean;
  // TTL: duration in seconds. Applied to generated memories on the instance.
  ttlSeconds?: number;
  // Introspection: what metadata to include in auto-recalled memories
  // "off" = just facts, "scores" = facts + similarity score (default)
  introspection?: "off" | "scores";
}

// --- Default memory topics ---
const DEFAULT_TOPICS = [
  { managed_memory_topic: { managed_topic_enum: "USER_PREFERENCES" } },
  { managed_memory_topic: { managed_topic_enum: "EXPLICIT_INSTRUCTIONS" } },
  { managed_memory_topic: { managed_topic_enum: "KEY_CONVERSATION_DETAILS" } },
  {
    custom_memory_topic: {
      label: "technical_decisions",
      description:
        "Architecture choices, tool evaluations, technology selections, and their rationale. Do NOT include routine debugging steps, temporary error messages, or operational status checks.",
    },
  },
  {
    custom_memory_topic: {
      label: "project_context",
      description:
        "Project names, repository URLs, team members, roles, system configurations, and relationships. Do NOT include transient operational details like 'gateway restarted' or 'build succeeded'.",
    },
  },
  {
    custom_memory_topic: {
      label: "action_items",
      description:
        "Tasks assigned, deadlines, commitments, follow-ups, and their completion status. Do NOT include routine status checks or acknowledgments like 'done' or 'checking'.",
    },
  },
];

// --- Few-shot examples: teach Memory Bank what to ignore ---
const DEFAULT_FEW_SHOTS = [
  // Negative: short status check, no memory
  {
    conversationSource: {
      events: [
        { content: { role: "user", parts: [{ text: "done?" }] } },
        { content: { role: "model", parts: [{ text: "Yes, the build succeeded and gateway restarted." }] } },
      ],
    },
    generatedMemories: [],
  },
  // Negative: debugging chatter, no memory
  {
    conversationSource: {
      events: [
        { content: { role: "user", parts: [{ text: "what's in the logs?" }] } },
        { content: { role: "model", parts: [{ text: "I see a 400 error on the config field. Let me fix the REST API field name." }] } },
      ],
    },
    generatedMemories: [],
  },
  // Positive: real decision worth remembering
  {
    conversationSource: {
      events: [
        { content: { role: "user", parts: [{ text: "I don't want my memories to go away after 90 days" }] } },
        { content: { role: "model", parts: [{ text: "You're right. TTL removed from config. Memories persist forever by default." }] } },
      ],
    },
    generatedMemories: [
      { fact: "The user does not want memories to expire. TTL should not be enabled by default." },
    ],
  },
  // Positive: user preference
  {
    conversationSource: {
      events: [
        { content: { role: "user", parts: [{ text: "no version bump is needed" }] } },
        { content: { role: "model", parts: [{ text: "Got it. Skipping version bump." }] } },
      ],
    },
    generatedMemories: [
      { fact: "The user prefers not to bump versions for incremental changes." },
    ],
  },
];

// --- File sync state ---
interface SyncIndex {
  version: number;
  entries: Record<string, { hash: string; syncedAt: string }>;
}

let syncIndex: SyncIndex = { version: 1, entries: {} };
let syncIndexPath = "";

function loadSyncIndex(workspaceDir: string): void {
  syncIndexPath = join(workspaceDir, ".memorybank-sync.json");
  if (existsSync(syncIndexPath)) {
    try {
      syncIndex = JSON.parse(readFileSync(syncIndexPath, "utf8"));
    } catch {
      syncIndex = { version: 1, entries: {} };
    }
  }
}

function saveSyncIndex(): void {
  if (!syncIndexPath) return;
  try {
    writeFileSync(syncIndexPath, JSON.stringify(syncIndex, null, 2));
  } catch (e: any) {
    console.error(`[memory-vertex] failed to save sync index: ${e.message}`);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- Collect memory files ---
interface MemoryFile {
  path: string;
  relativePath: string;
  content: string;
  hash: string;
}

function collectMemoryFiles(workspaceDir: string): MemoryFile[] {
  const files: MemoryFile[] = [];
  const topLevel = ["MEMORY.md", "USER.md", "SOUL.md", "TOOLS.md"];

  for (const name of topLevel) {
    const fullPath = join(workspaceDir, name);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf8");
      files.push({ path: fullPath, relativePath: name, content, hash: hashContent(content) });
    }
  }

  const memoryDir = join(workspaceDir, "memory");
  if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith(".md")) continue;
      const fullPath = join(memoryDir, name);
      if (!statSync(fullPath).isFile()) continue;
      const content = readFileSync(fullPath, "utf8");
      files.push({ path: fullPath, relativePath: `memory/${name}`, content, hash: hashContent(content) });
    }
  }

  return files;
}

function getChangedFiles(files: MemoryFile[]): MemoryFile[] {
  return files.filter((f) => {
    const existing = syncIndex.entries[f.relativePath];
    return !existing || existing.hash !== f.hash;
  });
}

// --- API ---
function parentName(cfg: MemoryBankConfig): string {
  return `projects/${cfg.projectId}/locations/${cfg.location}/reasoningEngines/${cfg.reasoningEngineId}`;
}

function apiBase(cfg: MemoryBankConfig): string {
  return BASE.replace("LOCATION", cfg.location);
}

async function apiCall(cfg: MemoryBankConfig, path: string, body: any, method = "POST"): Promise<any> {
  const token = getAccessToken();
  const url = `${apiBase(cfg)}/${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Memory Bank API ${res.status}: ${text}`);
  }
  return res.json();
}
