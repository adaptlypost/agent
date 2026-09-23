export const PERMISSION_DENIED = 'permission_denied';
export const SUBSCRIPTION_REQUIRED = 'subscription_required';
export const TOKEN_ISSUER_LOST_ACCESS = 'token_issuer_lost_access';
export const OAUTH_ACCOUNT_NOT_FOUND = 'oauth_account_not_found';

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

function describe(status: number, body: ApiErrorBody, fallback: string): string {
  const apiMessage = messageOf(body, fallback);

  if (body.code === PERMISSION_DENIED) {
    const denied = `Permission denied (403): the key's role "${body.role ?? 'unknown'}" lacks ${body.requiredPermission ?? 'the required permission'}.`;
    if (
      body.requiredPermission === 'posts.schedule' ||
      body.requiredPermission === 'posts.publish'
    ) {
      return `${denied} This key is ${roleName(body.role)}; save with saveAsDraft: true and ask a workspace member to publish. ${FINAL}`;
    }
    return `${denied} ${sentence(apiMessage)} ${FINAL}`;
  }

  if (body.code === TOKEN_ISSUER_LOST_ACCESS) {
    return `This key no longer works (401, ${TOKEN_ISSUER_LOST_ACCESS}): the member who created it lost access to the workspace. Stop and ask the user for a key created by a current member. ${FINAL}`;
  }

  if (body.code === OAUTH_ACCOUNT_NOT_FOUND) {
    return `Wrong sign-in (401, ${OAUTH_ACCOUNT_NOT_FOUND}): ${sentence(apiMessage)} Tell the user exactly this. No tool will work until they reconnect. ${FINAL}`;
  }

  if (body.code === SUBSCRIPTION_REQUIRED) {
    return `Subscription required (403, ${SUBSCRIPTION_REQUIRED}): ${sentence(apiMessage)} Ask the user to renew the workspace's plan. ${FINAL}`;
  }

  return `API error (${status}): ${apiMessage}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requiredPermission?: string;
  readonly role?: string;
  readonly tokenType?: string;
  readonly apiMessage: string;

  constructor(status: number, body: ApiErrorBody, fallback: string) {
    super(describe(status, body, fallback));
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requiredPermission = body.requiredPermission;
    this.role = body.role;
    this.tokenType = body.tokenType;
    this.apiMessage = messageOf(body, fallback);
  }
}

export class RestClient {
  constructor(
    private baseUrl: string,
    private apiToken: string,
  ) {}

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
      throw new ApiError(response.status, errorBody, fallback);
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
