export const PERMISSION_DENIED = 'permission_denied';
export const SUBSCRIPTION_REQUIRED = 'subscription_required';
export const TOKEN_ISSUER_LOST_ACCESS = 'token_issuer_lost_access';
export const OAUTH_ACCOUNT_NOT_FOUND = 'oauth_account_not_found';
export const WORKSPACE_ACCESS_DENIED = 'workspace_access_denied';

const PAYMENT_REQUIRED = 402;
const TOO_MANY_REQUESTS = 429;

export interface ApiErrorBody {
  statusCode?: number;
  error?: string;
  code?: string;
  requiredPermission?: string;
  role?: string;
  tokenType?: string;
  message?: string | string[];
}

const FINAL = 'Do not retry, do not look for another key.';

const roleName = (role?: string) =>
  role ? role.charAt(0).toUpperCase() + role.slice(1) : 'this role';

const messageOf = (body: ApiErrorBody, fallback: string) =>
  Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? fallback);

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const waitFor = (retryAfter: string | null) =>
  retryAfter && /^\d+$/.test(retryAfter.trim())
    ? `Wait ${retryAfter.trim()} seconds (Retry-After)`
    : retryAfter
      ? `Wait until ${retryAfter} (Retry-After)`
      : 'Wait a minute';

const withCode = (status: number, code?: string) => (code ? `${status}, ${code}` : `${status}`);

function describe(
  status: number,
  body: ApiErrorBody,
  fallback: string,
  retryAfter: string | null,
): string {
  const apiMessage = messageOf(body, fallback);

  if (body.code === PERMISSION_DENIED) {
    const denied = `Permission denied (${status}, ${PERMISSION_DENIED}): the key's role "${body.role ?? 'unknown'}" lacks ${body.requiredPermission ?? 'the required permission'}.`;
    if (
      body.requiredPermission === 'posts.schedule' ||
      body.requiredPermission === 'posts.publish'
    ) {
      return `${denied} This key is ${roleName(body.role)}; save with saveAsDraft: true and ask a workspace member to publish. ${FINAL}`;
    }
    return `${denied} ${sentence(apiMessage)} ${FINAL}`;
  }

  if (body.code === TOKEN_ISSUER_LOST_ACCESS) {
    return `This key no longer works (${status}, ${TOKEN_ISSUER_LOST_ACCESS}): the member who created it lost access to the workspace. Stop and ask the user for a key created by a current member. ${FINAL}`;
  }

  if (body.code === OAUTH_ACCOUNT_NOT_FOUND) {
    return `Wrong sign-in (${status}, ${OAUTH_ACCOUNT_NOT_FOUND}): ${sentence(apiMessage)} Tell the user exactly this. No tool will work until they reconnect. ${FINAL}`;
  }

  if (body.code === WORKSPACE_ACCESS_DENIED) {
    return `Workspace not available (${status}, ${WORKSPACE_ACCESS_DENIED}): ${sentence(apiMessage)} Call list_workspaces and pass one of the returned ids as workspaceId, or leave workspaceId out to act in the workspace list_workspaces marks current.`;
  }

  if (body.code === SUBSCRIPTION_REQUIRED) {
    return `Subscription required (${status}, ${SUBSCRIPTION_REQUIRED}): ${sentence(apiMessage)} Ask the user to renew the workspace's plan. ${FINAL}`;
  }

  if (status === PAYMENT_REQUIRED) {
    return `Out of AI credits (${withCode(status, body.code)}): ${sentence(apiMessage)} Tell the user the workspace has run out of AI credits. ${FINAL}`;
  }

  if (status === TOO_MANY_REQUESTS) {
    return `Rate limited (${withCode(status, body.code)}): ${sentence(apiMessage)} ${waitFor(retryAfter)} before the next call and do not retry in a loop.`;
  }

  return `API error (${withCode(status, body.code)}): ${apiMessage}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requiredPermission?: string;
  readonly role?: string;
  readonly tokenType?: string;
  readonly retryAfter: string | null;
  readonly apiMessage: string;

  constructor(status: number, body: ApiErrorBody, fallback: string, retryAfter: string | null) {
    super(describe(status, body, fallback, retryAfter));
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requiredPermission = body.requiredPermission;
    this.role = body.role;
    this.tokenType = body.tokenType;
    this.retryAfter = retryAfter;
    this.apiMessage = messageOf(body, fallback);
  }
}

export class RestClient {
  constructor(
    private baseUrl: string,
    private apiToken: string,
    private workspaceId?: string,
  ) {}

  credentials(): { token: string; workspaceId?: string } {
    return { token: this.apiToken, workspaceId: this.workspaceId };
  }

  forWorkspace(workspaceId: string | undefined): RestClient {
    return workspaceId
      ? new RestClient(this.baseUrl, this.apiToken, workspaceId)
      : this;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
        ...(this.workspaceId ? { 'X-Workspace-Id': this.workspaceId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const fallback = `${response.status} ${response.statusText}`;
      let errorBody: ApiErrorBody = {};
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') {
          errorBody = parsed as ApiErrorBody;
        } else {
          errorBody = { message: JSON.stringify(parsed) };
        }
      } catch {
        errorBody = {};
      }
      throw new ApiError(response.status, errorBody, fallback, response.headers.get('retry-after'));
    }

    return (await response.json()) as T;
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    let queryString = '';
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) {
            searchParams.append(key, String(v));
          }
        } else {
          searchParams.append(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) queryString = `?${qs}`;
    }
    return this.request<T>('GET', `${path}${queryString}`);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
