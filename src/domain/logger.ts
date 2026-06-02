export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  debug(message: string, data?: unknown): void {
    this.add("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.add("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.add("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.add("error", message, data);
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  toText(): string {
    return this.entries
      .map((entry) => {
        const data = entry.data === undefined ? "" : `\n${safeJson(entry.data)}`;
        return `[${entry.at}] ${entry.level.toUpperCase()} ${entry.message}${data}`;
      })
      .join("\n\n");
  }

  private add(level: LogLevel, message: string, data?: unknown): void {
    this.entries.push({ at: new Date().toISOString(), level, message, data });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
