import { z } from 'zod';

/**
 * MCP wire shapes shared by the server and the API contract. Kept apart from
 * mcp/server.ts because the tool catalogue imports the contract.
 */

/** Newest first; older clients negotiate down. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** One JSON-RPC 2.0 message. Batches are not accepted. */
export const mcpMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.int()]).optional(),
  method: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
