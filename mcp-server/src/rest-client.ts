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
      let errorMessage: string;
      try {
        const errorBody = await response.json();
        errorMessage =
          (errorBody as { message?: string }).message ??
          JSON.stringify(errorBody);
      } catch {
        errorMessage = `${response.status} ${response.statusText}`;
      }
      throw new Error(`API error: ${errorMessage}`);
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
