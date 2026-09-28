import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type JsonSchema = Record<string, unknown>;
type ListedTool = { inputSchema?: JsonSchema; outputSchema?: JsonSchema };

const withoutDialect = (schema?: JsonSchema): JsonSchema | undefined => {
  if (!schema) return schema;
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
};

const dropSchemaDialect = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!('result' in message) || !Array.isArray(message.result.tools)) return message;
  const tools = (message.result.tools as ListedTool[]).map((tool) => ({
    ...tool,
    inputSchema: withoutDialect(tool.inputSchema),
    outputSchema: withoutDialect(tool.outputSchema),
  }));
  return { ...message, result: { ...message.result, tools } };
};

// The SDK stamps draft-07 on every tool schema; clients on the 2025-11-25 spec validate against 2020-12 and reject it.
export const withoutSchemaDialect = <T extends Transport>(transport: T): T => {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(dropSchemaDialect(message), options);
  return transport;
};
