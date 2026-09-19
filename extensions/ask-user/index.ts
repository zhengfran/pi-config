/**
 * ask_user - Lets the model ask one multiple-choice question.
 *
 * Pi's SelectList owns navigation, scrolling, rendering, and key handling.
 * Selecting the final option opens Pi's built-in editor for a free-form reply.
 */

import {
  DynamicBorder,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const CUSTOM_VALUE = "__custom__";

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

interface DisplayOption {
  label: string;
  description?: string;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        text: string,
        answer: string | null = null,
        wasCustom = false,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((option) => option.label),
          answer,
          wasCustom,
          cancelled: answer === null,
        } satisfies AskUserDetails,
      });

      if (
        params.options.length < MIN_OPTIONS ||
        params.options.length > MAX_OPTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showOptions = () =>
        ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
          let settled = false;
          const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", cancel);
            done(value);
          };
          const cancel = () => finish(null);

          const items: SelectItem[] = [
            ...params.options.map((option, index) => ({
              value: String(index),
              label: option.label,
              description: option.description,
            })),
            {
              value: CUSTOM_VALUE,
              label: "Write my own answer…",
              description: "Open a text editor",
            },
          ];
          const list = new SelectList(items, items.length, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          list.onSelect = (item) => finish(item.value);
          list.onCancel = cancel;

          const container = new Container();
          container.addChild(
            new DynamicBorder((text: string) => theme.fg("accent", text)),
          );
          container.addChild(
            new Text(theme.fg("accent", theme.bold(params.question)), 1, 0),
          );
          container.addChild(list);
          container.addChild(
            new Text(
              theme.fg("dim", "↑↓ select • Enter confirm • Esc dismiss"),
              1,
              0,
            ),
          );
          container.addChild(
            new DynamicBorder((text: string) => theme.fg("accent", text)),
          );

          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) queueMicrotask(cancel);

          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              list.handleInput(data);
              tui.requestRender();
            },
            dispose: () => signal?.removeEventListener("abort", cancel),
          };
        });

      while (!signal?.aborted) {
        const selection = await showOptions();
        if (selection === null) {
          return reply(buildAskUserResultMessage({ kind: "dismissed" }));
        }

        if (selection === CUSTOM_VALUE) {
          const answer = (await ctx.ui.editor("Your answer"))?.trim();
          if (signal?.aborted) {
            return reply(buildAskUserResultMessage({ kind: "cancelled" }));
          }
          if (!answer) continue;
          return reply(
            buildAskUserResultMessage({ kind: "custom", answer }),
            answer,
            true,
          );
        }

        const index = Number(selection);
        const answer = params.options[index]?.label;
        if (answer === undefined) {
          throw new Error(`ask_user received an invalid option: ${selection}`);
        }
        return reply(
          buildAskUserResultMessage({
            kind: "selected",
            answer,
            index: index + 1,
          }),
          answer,
        );
      }

      return reply(buildAskUserResultMessage({ kind: "cancelled" }));
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        typeof args.question === "string" ? args.question : "",
      );
      const options = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      if (options.length > 0) {
        const numbered = options.map(
          (option, index) => `${index + 1}. ${option.label}`,
        );
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const index = details.options.indexOf(details.answer) + 1;
      const display =
        index > 0 ? `${index}. ${details.answer}` : details.answer;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", display),
        0,
        0,
      );
    },
  });
}
