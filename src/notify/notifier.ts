/** Sends notices to the owner. Which one runs is chosen by settings (see makeNotifier). */

export type NoticeKind = "request" | "refusal" | "recap";

export interface NoticeAction {
  label: string;
  url: string;
}

export interface Notice {
  kind: NoticeKind;
  title: string;
  /** Plain text, a few short lines. */
  body: string;
  /** Opened when the owner taps the notice itself. */
  url: string;
  /** Up to three links, shown as buttons. */
  actions: NoticeAction[];
  priority: "high" | "default" | "low";
  /** The facts behind the notice, for webhook consumers. */
  data: Record<string, unknown>;
}

export interface Notifier {
  readonly name: string;
  send(notice: Notice): Promise<void>;
}

const TIMEOUT_MS = 10_000;

/** No notifier configured: write the notice to the log. */
export class LogNotifier implements Notifier {
  readonly name = "none";
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(notice: Notice) {
    this.log(`notice (${notice.kind}): ${notice.title}`);
  }
}

/** Push to a phone through an ntfy topic, using ntfy's JSON publish API and view actions for the links. */
export class NtfyNotifier implements Notifier {
  readonly name = "ntfy";

  constructor(
    private readonly opts: { url: string; topic: string; token?: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(notice: Notice) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const res = await this.fetcher(`${this.opts.url}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(ntfyMessage(this.opts.topic, notice)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

export function ntfyMessage(topic: string, notice: Notice) {
  return {
    topic,
    title: notice.title,
    message: notice.body,
    priority: { high: 4, default: 3, low: 2 }[notice.priority],
    tags: [{ request: "moneybag", refusal: "no_entry", recap: "receipt" }[notice.kind]],
    click: notice.url,
    // ntfy shows at most three buttons. A view action opens the link in the browser.
    actions: notice.actions.slice(0, 3).map((a) => ({ action: "view", label: a.label, url: a.url, clear: true })),
  };
}

/** POST each notice as JSON to a URL of the owner's choosing. */
export class WebhookNotifier implements Notifier {
  readonly name = "webhook";

  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(notice: Notice) {
    const res = await this.fetcher(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Remit" },
      body: JSON.stringify({ source: "remit", sentAt: this.now().toISOString(), ...notice }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Webhook answered ${res.status}.`);
  }
}

/** Sends to each notifier; one failing doesn't stop the others. */
export class FanoutNotifier implements Notifier {
  readonly name: string;
  constructor(private readonly notifiers: Notifier[]) {
    this.name = notifiers.map((n) => n.name).join("+");
  }
  async send(notice: Notice) {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(notice)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) throw new Error(failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join("; "));
  }
}

export interface NotifySettings {
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken: string;
  webhookUrl: string;
}

/** ntfy when NTFY_TOPIC is set, a webhook when NOTIFY_WEBHOOK_URL is set, both if both, else log only. */
export function makeNotifier(s: NotifySettings): Notifier {
  const list: Notifier[] = [];
  if (s.ntfyTopic) list.push(new NtfyNotifier({ url: s.ntfyUrl, topic: s.ntfyTopic, token: s.ntfyToken || undefined }));
  if (s.webhookUrl) list.push(new WebhookNotifier(s.webhookUrl));
  if (!list.length) return new LogNotifier();
  return list.length === 1 ? list[0]! : new FanoutNotifier(list);
}
