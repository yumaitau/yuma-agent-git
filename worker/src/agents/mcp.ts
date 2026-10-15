import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { apiError, errorResponse, readJsonBody } from '../api/errors';
import { getRepoBySlug } from '../db/repos';
import { can } from '../auth/rbac';
import { hasScope, type AppEnv, type Principal } from '../auth/principal';
import { executeTool, toolRegistry, type ToolCtx } from './tools';
import { newBudget, remaining } from './budget';

/**
 * MCP-style surface (issue #18): a JSON-RPC 2.0 subset exposing the SAME tool
 * registry to external agents — the "standardized RPC across forges" from the
 * architecture's ecosystem note. Bearer tokens need `agent:run`; RBAC is
 * enforced identically to the built-in runtime.
 *
 *   POST /api/v1/repos/:repo/agents/mcp   {method, params, id}
 *     initialize | tools/list | tools/call
 */
export const mcpRoutes = new Hono<AppEnv>();

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  method: z.enum(['initialize', 'tools/list', 'tools/call']),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
});

const callParamsSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
  base_cs: z.string().optional(),
  head_cs: z.string().optional(),
});

function jsonRpc(id: string | number | null | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

mcpRoutes.post('/repos/:repo{.+}/agents/mcp', async (c) => {
  try {
    // machine principals only: bearer token with agent:run
    const principal = (c.get('principal') ?? null) as Principal | null;
    if (!principal || principal.kind !== 'token' || !hasScope(principal, 'agent:run')) {
      return apiError(c, 403, 'forbidden', 'agent:run scope required', {
        required_scope: 'agent:run',
      });
    }

    const body = await readJsonBody(c);
    const parsed = rpcSchema.safeParse(body);
    if (!parsed.success) return jsonRpcError(null, -32600, 'invalid request');
    const { method, params, id } = parsed.data;

    if (method === 'initialize') {
      return jsonRpc(id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'yuma-agent-git', version: '0.1.0' },
      });
    }

    if (method === 'tools/list') {
      return jsonRpc(id, {
        tools: [...toolRegistry.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.input_schema),
        })),
      });
    }

    // tools/call
    const repo = await getRepoBySlug(c.env, c.req.param('repo'));
    if (!repo) return jsonRpcError(id, -32602, 'unknown repo');
    const allowed = await can(c.env, repo, principal, 'write');
    if (!allowed) return jsonRpcError(id, -32601, 'forbidden');

    const call = callParamsSchema.safeParse(params);
    if (!call.success) return jsonRpcError(id, -32602, 'invalid params');

    const headCs =
      call.data.head_cs ?? (await readHead(c.env, repo.id, repo.default_branch));
    if (headCs === null) return jsonRpcError(id, -32603, 'empty repository');

    const ctx: ToolCtx = {
      repo_id: repo.id,
      principal,
      base_cs: call.data.base_cs ?? headCs,
      head_cs: headCs,
      budget: newBudget(),
      task_id: 'mcp',
    };
    const result = await executeTool(
      c.env,
      ctx,
      call.data.name,
      call.data.arguments ?? {},
    );
    return jsonRpc(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      budget: remaining(ctx.budget),
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

async function readHead(
  env: Env,
  repoId: string,
  branch: string,
): Promise<string | null> {
  const { readRefHead } = await import('../core/refs');
  return readRefHead(env, repoId, branch);
}
