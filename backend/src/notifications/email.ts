import type { FastifyBaseLogger } from "fastify";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

/** Local development: writes each email to the log instead of sending it. */
export class LogEmailSender implements EmailSender {
  private count = 0;
  constructor(
    private readonly log: Pick<FastifyBaseLogger, "info">,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage) {
    const messageId = `log-${Date.now()}-${++this.count}`;
    this.log.info({ email: { from: this.from, ...message }, messageId }, "email (not sent: EMAIL_PROVIDER=log)");
    return { messageId };
  }
}

/** Tests: keeps sent emails in memory and can be told to fail. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failuresLeft = 0;

  async send(message: EmailMessage) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("simulated provider outage");
    }
    this.sent.push(message);
    return { messageId: `mem-${this.sent.length}` };
  }
}
