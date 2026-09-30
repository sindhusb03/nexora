import type { Logger } from "../observability.js";

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Provider boundary. Production can swap in SES or another transport without changing the routes. */
export interface EmailSender {
  send(message: OutboundEmail): Promise<void>;
}

export interface MailboxMessage extends OutboundEmail {
  readonly createdAt: string;
}

/** In-memory mailbox for the dev transport. The API exposes it only outside production. */
export class MemoryMailbox {
  private readonly messages: MailboxMessage[] = [];

  push(message: OutboundEmail): void {
    this.messages.push({ ...message, createdAt: new Date().toISOString() });
    if (this.messages.length > 50) this.messages.shift();
  }

  list(): readonly MailboxMessage[] {
    return this.messages;
  }
}

/**
 * Dev transport. The full message, including a magic-link token, stays in the mailbox.
 * The log line records that a message was queued and redacts the address.
 */
export function consoleEmailSender(logger: Logger, mailbox: MemoryMailbox): EmailSender {
  return {
    async send(message) {
      mailbox.push(message);
      logger.info("email.dev", { subject: message.subject, to: "[redacted]" });
    },
  };
}
