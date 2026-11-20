// Streaming over XMLHttpRequest: RN's XHR delivers incremental responseText via onprogress,
// which works for both SSE (Circe /events) and OpenAI-compatible streamed completions.

export interface StreamHandle {
  abort: () => void;
}

/** Feed each complete SSE `data:` payload to onData. */
export function sseRequest(opts: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  onData: (data: string) => void;
  onDone: (err?: string) => void;
}): StreamHandle {
  const xhr = new XMLHttpRequest();
  let seen = 0;
  let buf = "";
  let finished = false;
  const finish = (err?: string) => {
    if (finished) return;
    finished = true;
    opts.onDone(err);
  };
  const pump = () => {
    const text = xhr.responseText ?? "";
    buf += text.slice(seen);
    seen = text.length;
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) opts.onData(data);
    }
  };
  xhr.open(opts.method ?? "GET", opts.url);
  for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
  xhr.onprogress = pump;
  xhr.onreadystatechange = () => {
    if (xhr.readyState === 4) {
      pump();
      if (xhr.status >= 200 && xhr.status < 300) finish();
      else finish(`HTTP ${xhr.status || "error"} ${(xhr.responseText ?? "").slice(0, 200)}`);
    }
  };
  xhr.onerror = () => finish("network error");
  xhr.send(opts.body ?? null);
  return {
    abort: () => {
      finished = true;
      xhr.abort();
    },
  };
}

export function chatStream(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  onToken: (t: string) => void;
  onDone: (err?: string) => void;
}): StreamHandle {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  return sseRequest({
    url: opts.baseUrl.replace(/\/+$/, "") + "/chat/completions",
    method: "POST",
    headers,
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
    onData: (data) => {
      if (data.trim() === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const t = j?.choices?.[0]?.delta?.content;
        if (typeof t === "string" && t) opts.onToken(t);
      } catch {
        /* ignore keep-alives */
      }
    },
    onDone: opts.onDone,
  });
}

export async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  return j;
}
