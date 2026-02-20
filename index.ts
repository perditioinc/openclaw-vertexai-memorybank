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

// --- Core operations ---

async function retrieveMemories(cfg: MemoryBankConfig, query: string): Promise<any[]> {
  const parent = parentName(cfg);
  const scope = cfg.scope || { agent_name: "openclaw" };
  const topK = cfg.topK || 10;
  try {
    const result = await apiCall(cfg, `${parent}/memories:retrieve`, {
      scope,
      similaritySearchParams: { searchQuery: query, topK },
    });
    const memories = result.retrievedMemories || [];
    const maxDist = cfg.maxDistance;
    if (maxDist != null) {
      const filtered = memories.filter((m: any) => m.distance != null && m.distance <= maxDist);
      if (filtered.length < memories.length) {
        console.log(`[memory-vertex] relevance filter: ${filtered.length}/${memories.length} memories passed (maxDistance=${maxDist})`);
      }
      return filtered;
    }
    return memories;
  } catch (e: any) {
    console.error(`[memory-vertex] retrieve error: ${e.message}`);
    return [];
  }
}

// Send last message pair to Memory Bank. It handles extraction + consolidation.
async function captureFromConversation(
  cfg: MemoryBankConfig,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  const parent = parentName(cfg);
  const scope = cfg.scope || { agent_name: "openclaw" };

  // Only send the last user+assistant pair (not the whole conversation)
  const lastPair = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-2);

  if (lastPair.length === 0) return;

  const events = lastPair.map((m) => ({
    content: {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 4000) }],
    },
  }));

  try {
    const result = await apiCall(cfg, `${parent}/memories:generate`, {
      scope,
      direct_contents_source: { events },
      revision_labels: { source: "capture" },
    });
    // Log what Memory Bank returned
    const generated = result.generatedMemories || [];
    if (generated.length > 0) {
      const created = generated.filter((m: any) => m.action === "CREATED").length;
      const updated = generated.filter((m: any) => m.action === "UPDATED").length;
      const deleted = generated.filter((m: any) => m.action === "DELETED").length;
      const facts = generated
        .filter((m: any) => m.action === "CREATED" || m.action === "UPDATED")
        .map((m: any) => m.memory?.fact || "")
        .filter((f: string) => f);
      console.log(
        `[memory-vertex] captured: ${created} new, ${updated} updated, ${deleted} deleted`
      );
      if (facts.length > 0) {
        console.log(`[memory-vertex] facts: ${facts.join(" | ")}`);
      }
    } else {
      console.log("[memory-vertex] capture queued (async generation)");
    }
  } catch (e: any) {
    console.error(`[memory-vertex] capture error: ${e.message}`);
  }
}

async function syncFiles(cfg: MemoryBankConfig, files: MemoryFile[]): Promise<void> {
  const parent = parentName(cfg);
  const scope = cfg.scope || { agent_name: "openclaw" };

  for (const file of files) {
    const chunks: string[] = [];
    for (let i = 0; i < file.content.length; i += 2000) {
      chunks.push(file.content.slice(i, i + 2000));
    }

    const events = chunks.map((chunk) => ({
      content: {
        role: "user" as const,
        parts: [{ text: `[File: ${file.relativePath}]\n${chunk}` }],
      },
    }));

    try {
      await apiCall(cfg, `${parent}/memories:generate`, {
        scope,
        direct_contents_source: { events },
        revision_labels: { source: "file-sync", file: file.relativePath },
      });
      syncIndex.entries[file.relativePath] = {
        hash: file.hash,
        syncedAt: new Date().toISOString(),
      };
      saveSyncIndex();
      console.log(`[memory-vertex] synced file: ${file.relativePath}`);
    } catch (e: any) {
      console.error(`[memory-vertex] file sync error (${file.relativePath}): ${e.message}`);
    }
  }
}

async function syncInstanceConfig(cfg: MemoryBankConfig): Promise<void> {
  const parent = parentName(cfg);
  const topics = cfg.memoryTopics || DEFAULT_TOPICS;
  const perspective = cfg.perspective || "third";

  try {
    const token = getAccessToken();
    const url = `${apiBase(cfg)}/${parent}?updateMask=contextSpec.memoryBankConfig`;

    const customizationConfig: any = {
      memory_topics: topics,
      enable_third_person_memories: perspective !== "first",
    };

    // Add few-shot examples if using default topics
    if (!cfg.memoryTopics) {
      customizationConfig.generate_memories_examples = DEFAULT_FEW_SHOTS;
    }

    const memoryBankConfig: any = {
      customization_configs: [customizationConfig],
    };

    // TTL: auto-expire memories after configured duration
    if (cfg.ttlSeconds && cfg.ttlSeconds > 0) {
      memoryBankConfig.ttl_config = {
        generateCreatedTtl: `${cfg.ttlSeconds}s`,
        generateUpdatedTtl: `${cfg.ttlSeconds}s`,
      };
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        context_spec: { memory_bank_config: memoryBankConfig },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Memory Bank API ${res.status}: ${text}`);
    }

    const parts = [`${topics.length} topics`, `${perspective}-person`];
    if (cfg.ttlSeconds) parts.push(`TTL ${Math.round(cfg.ttlSeconds / 86400)}d`);
    console.log(`[memory-vertex] synced config: ${parts.join(", ")}`);
  } catch (e: any) {
    console.error(`[memory-vertex] config sync error: ${e.message}`);
  }
}

// --- Lightweight context for memory generation (avoids passing full config) ---
interface GenerateContext {
  location: string;
  parent: string;
  scope: Record<string, string>;
}

function toGenerateContext(cfg: MemoryBankConfig): GenerateContext {
  return {
    location: cfg.location,
    parent: parentName(cfg),
    scope: cfg.scope || { agent_name: "openclaw" },
  };
}

// --- Fire-and-forget API call (no response parsing, no LRO wait) ---
async function fireAndForget(ctx: GenerateContext, path: string, body: any): Promise<void> {
  const token = getAccessToken();
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1beta1/${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[memory-vertex] fire-and-forget ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.error(`[memory-vertex] fire-and-forget error: ${e.message}`);
  }
}

// --- Direct memory creation (via consolidation pipeline) ---
interface CreateMemoryOptions {
  /** If true, await the full response. If false (default), fire-and-forget. */
  waitForResult?: boolean;
  /** Source label for tracing (e.g. "capture", "file-sync", "cli-remember") */
  source?: string;
}

async function createMemory(
  cfg: MemoryBankConfig,
  fact: string,
  options: CreateMemoryOptions = {},
): Promise<void> {
  const ctx = toGenerateContext(cfg);
  const { waitForResult = false, source = "unknown" } = options;
  const body: any = {
    scope: ctx.scope,
    direct_memories_source: {
      direct_memories: [{ fact }],
    },
    revision_labels: { source },
  };

  if (!waitForResult) {
    // Fire-and-forget: don't block the agent
    await fireAndForget(ctx, `${ctx.parent}/memories:generate`, body);
    console.log(`[memory-vertex] remember fired (bg): ${fact}`);
    return;
  }

  // Synchronous: wait for consolidation result
  try {
    const result = await apiCall(cfg, `${ctx.parent}/memories:generate`, body);
    const generated = result.generatedMemories || [];
    const created = generated.filter((m: any) => m.action === "CREATED").length;
    const updated = generated.filter((m: any) => m.action === "UPDATED").length;
    if (created > 0 || updated > 0) {
      console.log(`[memory-vertex] remembered (${created} new, ${updated} updated): ${fact}`);
    } else if (generated.length === 0) {
      console.log(`[memory-vertex] remember queued/deduped: ${fact}`);
    } else {
      console.log(`[memory-vertex] remembered: ${fact}`);
    }
  } catch (e: any) {
    console.error(`[memory-vertex] create memory error: ${e.message}`);
    throw e;
  }
}

// --- Delete a memory ---
async function deleteMemory(cfg: MemoryBankConfig, memoryId: string): Promise<void> {
  const parent = parentName(cfg);
  const token = getAccessToken();
  const url = `https://${cfg.location}-aiplatform.googleapis.com/v1beta1/${parent}/memories/${memoryId}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Memory Bank API ${resp.status}: ${body}`);
  }
  console.log(`[memory-vertex] deleted memory: ${memoryId}`);
}

// --- Memory counting ---
//
// TODO(google-api): The memories.list endpoint does NOT return a totalSize field,
// and there is no memories:count RPC. We verified this by:
//   1. Requesting $fields=totalSize — returns "Cannot find matching fields for path 'totalSize'"
//   2. Checking discovery doc — only list/get/create/patch/delete/generate/retrieve/rollback/purge
//   3. Checking v1alpha1 — returns 404 (does not exist)
//   4. Max pageSize is 100 even when requesting 1000
//
// This means counting requires paginating through ALL memories. We mitigate this by:
//   - Using $fields=memories/name,nextPageToken to return only resource names (~12KB/page)
//   - Caching the count in-memory with a 5-minute TTL
//   - Auto-incrementing/decrementing on create/delete within the session
//
// When Google adds totalSize or a count RPC to the memories.list response,
// this pagination loop should be replaced with a single API call.
// Track: https://google.aip.dev/132 (standard List should include totalSize)

interface CountCache {
  count: number;
  fetchedAt: number;
}

const COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let countCache: CountCache | null = null;

/**
 * Count memories using field-masked pagination (lightweight, no LLM calls).
 * Returns only resource names to minimize payload (~120 bytes/memory vs full objects).
 */
async function countMemories(cfg: MemoryBankConfig, opts?: { force?: boolean }): Promise<number> {
  // Return cached count if fresh
  if (!opts?.force && countCache && (Date.now() - countCache.fetchedAt) < COUNT_CACHE_TTL_MS) {
    return countCache.count;
  }

  const parent = parentName(cfg);
  const scope = cfg.scope || { agent_name: "openclaw" };
  let total = 0;
  let pageToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("filter", `scope="${JSON.stringify(scope).replace(/"/g, '\\"')}"`);
      // Field mask: only return memory names + pagination token (no facts, topics, timestamps)
      params.set("$fields", "memories/name,nextPageToken");
      if (pageToken) params.set("pageToken", pageToken);

      const token = getAccessToken();
      const url = `${apiBase(cfg)}/${parent}/memories?${params.toString()}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Memory Bank API ${res.status}: ${text}`);
      }
      const result = await res.json();
      total += (result.memories || []).length;
      pageToken = result.nextPageToken;
    } while (pageToken);

    countCache = { count: total, fetchedAt: Date.now() };
    return total;
  } catch (e: any) {
    console.error(`[memory-vertex] count error: ${e.message}`);
    // Return stale cache if available, otherwise 0
    return countCache?.count ?? 0;
  }
}

/** Adjust cached count without re-fetching (call after create/delete). */
function adjustCachedCount(delta: number): void {
  if (countCache) {
    countCache.count = Math.max(0, countCache.count + delta);
  }
}

/**
 * List all memories in scope with full details (paginated).
 * Use countMemories() instead when you only need the count.
 */
async function listMemories(
  cfg: MemoryBankConfig,
  scope?: Record<string, string>
): Promise<any[]> {
  const parent = parentName(cfg);
  const effectiveScope = scope || cfg.scope || { agent_name: "openclaw" };
  const all: any[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("filter", `scope="${JSON.stringify(effectiveScope).replace(/"/g, '\\"')}"`);
      if (pageToken) params.set("pageToken", pageToken);

      const token = getAccessToken();
      const url = `${apiBase(cfg)}/${parent}/memories?${params.toString()}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Memory Bank API ${res.status}: ${text}`);
      }
      const result = await res.json();
      const memories = result.memories || [];
      all.push(...memories.map((m: any) => ({ memory: m })));
      pageToken = result.nextPageToken;
    } while (pageToken);

    // Update count cache as a side effect
    countCache = { count: all.length, fetchedAt: Date.now() };
    return all;
  } catch (e: any) {
    console.error(`[memory-vertex] list error: ${e.message}`);
    return all;
  }
}

// --- Plugin ---
const plugin = {
  id: "openclaw-vertex-memorybank",
  name: "Memory (Vertex AI Memory Bank)",
  kind: "general" as const,

  register(api: any) {
    const config = api.pluginConfig as MemoryBankConfig;
    const autoRecall = config.autoRecall !== false;
    const autoCapture = config.autoCapture !== false;
    const autoSyncFiles = config.autoSyncFiles !== false;
    const autoSyncTopics = config.autoSyncTopics !== false;
    const backgroundGenerate = config.backgroundGenerate !== false;

    const workspaceDir =
      api.workspaceDir ||
      process.env.OPENCLAW_WORKSPACE ||
      join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw", "workspace");

    // --- Startup service ---
    api.registerService({
      id: "memorybank-sync",
      async start() {
        if (autoSyncTopics) await syncInstanceConfig(config);
        if (autoSyncFiles) {
          loadSyncIndex(workspaceDir);
          const files = collectMemoryFiles(workspaceDir);
          const changed = getChangedFiles(files);
          if (changed.length > 0) {
            console.log(`[memory-vertex] startup: ${changed.length} changed file(s) to sync`);
            await syncFiles(config, changed);
          } else {
            console.log("[memory-vertex] startup: all files in sync");
          }
        }
      },
    });

    // --- Auto-recall ---
    if (autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const query = event.prompt || "";
        if (!query || query.length < 5) return;

        const memories = await retrieveMemories(config, query);
        if (memories.length === 0) return;

        const introspection = config.introspection || "scores";
        const formatted = memories
          .map((m: any, i: number) => {
            const fact = m.memory?.fact || m.fact || JSON.stringify(m);
            if (introspection === "off") {
              return `${i + 1}. ${fact}`;
            }
            // "scores" (default) — include similarity score
            const score = m.score ?? m.similarity ?? m.distance ?? null;
            const scoreStr = score != null ? ` [score: ${(typeof score === "number" ? score.toFixed(3) : score)}]` : "";
            return `${i + 1}. ${fact}${scoreStr}`;
          })
          .join("\n");

        return {
          prependContext: `<vertex_memory_bank>\nRelevant memories from prior sessions:\n${formatted}\n</vertex_memory_bank>`,
        };
      });
    }

    // --- Auto-capture ---
    if (autoCapture) {
      api.on("agent_end", async (event: any) => {
        if (!event.success) return;

        // 1. Capture last message pair
        const messages = (event.messages || [])
          .filter((m: any) => m.role === "user" || m.role === "assistant")
          .map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));

        // Skip capture if messages are too short (noise filter)
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant");
        const userLen = lastUserMsg?.content?.length || 0;
        const totalLen = (lastUserMsg?.content?.length || 0) + (lastAssistantMsg?.content?.length || 0);

        if (userLen < 20 || totalLen < 100) {
          console.log(`[memory-vertex] skipped capture: too short (user=${userLen}, total=${totalLen})`);
        } else if (messages.length > 0) {
          const capture = captureFromConversation(config, messages);
          if (!backgroundGenerate) await capture;
          else capture.catch((e) => console.error(`[memory-vertex] bg capture error: ${e}`));
        }

        // 2. Sync changed files
        if (autoSyncFiles) {
          try {
            const files = collectMemoryFiles(workspaceDir);
            const changed = getChangedFiles(files);
            if (changed.length > 0) {
              console.log(`[memory-vertex] agent_end: ${changed.length} changed file(s) to sync`);
              const sync = syncFiles(config, changed);
              if (!backgroundGenerate) await sync;
              else sync.catch((e) => console.error(`[memory-vertex] bg file sync error: ${e}`));
            }
          } catch (e: any) {
            console.error(`[memory-vertex] file change detection error: ${e.message}`);
          }
        }
      });
    }

    // --- Agent tools ---

    // memory_search — Search memories by semantic similarity
    api.registerTool({
      name: "memory_search",
      description: "Search the Memory Bank for memories semantically similar to a query. Returns matching facts with similarity scores, topics, and timestamps.",
      label: "Memory Search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic search query" },
          top_k: { type: "number", description: "Max results to return (default: 10)" },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: { query: string; top_k?: number }) {
        const searchConfig = { ...config, topK: params.top_k || config.topK || 10 };
        const memories = await retrieveMemories(searchConfig, params.query);
        const results = memories.map((m: any, i: number) => {
          const mem = m.memory || m;
          return {
            index: i + 1,
            id: mem.name || mem.id || null,
            fact: mem.fact || JSON.stringify(mem),
            score: m.score ?? m.similarity ?? m.distance ?? null,
            topic: mem.topics || mem.topic || mem.memoryTopic || null,
            created: mem.createTime || mem.createdAt || null,
            updated: mem.updateTime || mem.updatedAt || null,
          };
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: results.length, memories: results }, null, 2) }],
          details: { count: results.length },
        };
      },
    });

    // memory_forget — Delete a memory by ID
    api.registerTool({
      name: "memory_forget",
      description: "Delete (forget) a specific memory by its ID. Permanently removes it from the Memory Bank.",
      label: "Memory Forget",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "The memory ID (resource name) to delete" },
        },
        required: ["memory_id"],
      },
      async execute(_toolCallId: string, params: { memory_id: string }) {
        const parent = parentName(config);
        const memoryName = params.memory_id.includes("/") ? params.memory_id : `${parent}/memories/${params.memory_id}`;
        try {
          const token = getAccessToken();
          const url = `${apiBase(config)}/${memoryName}`;
          const res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            const text = await res.text();
            return {
              content: [{ type: "text" as const, text: `Failed to delete memory: ${res.status} ${text}` }],
              details: { deleted: false },
            };
          }
          adjustCachedCount(-1);
          return {
            content: [{ type: "text" as const, text: `Memory deleted: ${params.memory_id}` }],
            details: { deleted: true },
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error deleting memory: ${e.message}` }],
            details: { deleted: false, error: e.message },
          };
        }
      },
    });
