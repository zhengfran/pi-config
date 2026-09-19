import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_BODY_LINES = 22;

class RoutingDiagnosticsView {
  private offset = 0;

  constructor(
    private readonly theme: Theme,
    private readonly lines: string[],
    private readonly done: () => void,
    private readonly requestRender: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
      return;
    }
    const maxOffset = Math.max(0, this.lines.length - MAX_BODY_LINES);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, Key.down)) {
      this.offset = Math.min(maxOffset, this.offset + 1);
    }
    if (matchesKey(data, Key.home)) this.offset = 0;
    if (matchesKey(data, Key.end)) this.offset = maxOffset;
    this.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const maxOffset = Math.max(0, this.lines.length - MAX_BODY_LINES);
    this.offset = Math.min(this.offset, maxOffset);
    const body = this.lines.slice(this.offset, this.offset + MAX_BODY_LINES);
    const pad = (value: string) => {
      const truncated = truncateToWidth(
        value,
        innerWidth,
        this.theme.fg("dim", "…"),
      );
      return (
        truncated +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))
      );
    };
    const row = (value: string) =>
      `${this.theme.fg("border", "│")}${pad(value)}${this.theme.fg("border", "│")}`;
    const position =
      this.lines.length > MAX_BODY_LINES
        ? ` · ${this.offset + 1}-${Math.min(this.lines.length, this.offset + MAX_BODY_LINES)}/${this.lines.length}`
        : "";
    return [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("Subagent Routing"))}`),
      row(""),
      ...body.map((line) => row(` ${line}`)),
      row(""),
      row(` ${this.theme.fg("dim", `↑↓ scroll · esc close${position}`)}`),
      this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  invalidate(): void {}
}

export async function showRoutingDiagnostics(
  ctx: ExtensionCommandContext,
  lines: string[],
): Promise<void> {
  if (ctx.mode !== "tui") {
    const text = lines.join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else console.error(text);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RoutingDiagnosticsView(
        theme,
        lines,
        () => done(undefined),
        () => tui.requestRender(),
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        minWidth: 64,
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}
