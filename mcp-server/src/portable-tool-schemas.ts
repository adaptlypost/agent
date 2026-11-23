import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type JsonSchema = Record<string, unknown>;
type ListedTool = { inputSchema?: JsonSchema; outputSchema?: JsonSchema };

const isObject = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolvePointer = (root: JsonSchema, ref: string): unknown =>
  ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>(
      (node, key) => (isObject(node) || Array.isArray(node) ? (node as JsonSchema)[key] : undefined),
      root,
    );

const inlineRefs = (node: unknown, root: JsonSchema, seen: ReadonlySet<string>): unknown => {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, root, seen));
  if (!isObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/') && !seen.has(ref)) {
    const { $ref: _ref, ...siblings } = node;
    const target = resolvePointer(root, ref);
    if (isObject(target)) return inlineRefs({ ...target, ...siblings }, root, new Set([...seen, ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inlineRefs(value, root, seen)]));
};

const portableInputSchema = (schema?: JsonSchema): JsonSchema | undefined => {
  if (!schema) return schema;
  const { $schema: _dialect, ...rest } = schema;
  return inlineRefs(rest, rest, new Set()) as JsonSchema;
};

const portableToolList = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!('result' in message) || !Array.isArray(message.result.tools)) return message;
  const tools = (message.result.tools as ListedTool[]).map(({ outputSchema: _output, ...tool }) => ({
    ...tool,
    inputSchema: portableInputSchema(tool.inputSchema),
  }));
  return { ...message, result: { ...message.result, tools } };
};

// 2025-11-25 clients reject the SDK's draft-07 stamp, and the Gemini app returns an empty turn for the raw tool list.
export const withPortableToolSchemas = <T extends Transport>(transport: T): T => {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(portableToolList(message), options);
  return transport;
};
