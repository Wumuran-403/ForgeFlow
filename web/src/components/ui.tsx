import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  LoaderCircle,
  XCircle,
} from "lucide-react";

import { prettyJson } from "../lib/format";
import type { TaskStatus } from "../lib/types";

export function cn(
  ...values: Array<
    string | false | null | undefined | Record<string, boolean>
  >
): string {
  return values
    .flatMap((value) =>
      typeof value === "object" && value !== null
        ? Object.entries(value)
            .filter(([, enabled]) => enabled)
            .map(([className]) => className)
        : value,
    )
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "icon";
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]/40 disabled:cursor-not-allowed disabled:opacity-50",
        {
          "bg-[#17211f] text-white hover:bg-[#26342f]": variant === "primary",
          "border border-[#d6dcd8] bg-white text-[#28332f] hover:bg-[#f4f6f4]":
            variant === "secondary",
          "bg-[#b42318] text-white hover:bg-[#912018]": variant === "danger",
          "text-[#52605a] hover:bg-[#eef1ee] hover:text-[#17211f]":
            variant === "ghost",
          "h-8 px-3 text-sm": size === "sm",
          "h-10 px-4 text-sm": size === "md",
          "size-9 p-0": size === "icon",
        },
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Panel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[#dfe4e1] bg-white shadow-[0_1px_2px_rgba(23,33,31,0.04)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#0f766e]">
          {eyebrow}
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#17211f]">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[#63706b]">
          {description}
        </p>
      </div>
      {actions}
    </header>
  );
}

 export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[#63706b]">
      <LoaderCircle className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNotice({
  title = "请求失败",
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[#f1c6c1] bg-[#fff7f6] p-4 text-sm text-[#7a271f]">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="mt-1 leading-5">{message}</div>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-[#eef3f1] text-[#42605a]">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-[#26312d]">{title}</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-[#6a7671]">
        {description}
      </p>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}

const statusStyle: Record<
  TaskStatus,
  { label: string; className: string; icon: ReactNode }
> = {
  queued: {
    label: "排队中",
    className: "border-[#d6dcd8] bg-[#f4f6f4] text-[#52605a]",
    icon: <Clock3 className="size-3" />,
  },
  running: {
    label: "运行中",
    className: "border-[#b9dcd6] bg-[#ecf8f5] text-[#0f766e]",
    icon: <CircleDashed className="size-3 animate-spin" />,
  },
  waiting_approval: {
    label: "等待审批",
    className: "border-[#efd39a] bg-[#fff8e8] text-[#855a0a]",
    icon: <Clock3 className="size-3" />,
  },
  waiting_review: {
    label: "需要人工核对",
    className: "border-[#efd39a] bg-[#fff8e8] text-[#855a0a]",
    icon: <Clock3 className="size-3" />,
  },
  completed: {
    label: "已完成",
    className: "border-[#b8dcc0] bg-[#f0f8f2] text-[#276738]",
    icon: <CheckCircle2 className="size-3" />,
  },
  failed: {
    label: "失败",
    className: "border-[#f1c6c1] bg-[#fff4f3] text-[#9f2f24]",
    icon: <XCircle className="size-3" />,
  },
  error: {
    label: "错误",
    className: "border-[#f1c6c1] bg-[#fff4f3] text-[#9f2f24]",
    icon: <XCircle className="size-3" />,
  },
  interrupted: {
    label: "已中断 · 请检查",
    className: "border-[#efd39a] bg-[#fff8e8] text-[#855a0a]",
    icon: <Clock3 className="size-3" />,
  },
  cancelled: {
    label: "已取消",
    className: "border-[#d6dcd8] bg-[#f4f6f4] text-[#52605a]",
    icon: <XCircle className="size-3" />,
  },
  pause_requested: {
    label: "正在暂停",
    className: "border-[#efd39a] bg-[#fff8e8] text-[#855a0a]",
    icon: <Clock3 className="size-3" />,
  },
  paused: {
    label: "已暂停",
    className: "border-[#d6dcd8] bg-[#f4f6f4] text-[#52605a]",
    icon: <Clock3 className="size-3" />,
  },
  cancel_requested: {
    label: "正在取消",
    className: "border-[#efd39a] bg-[#fff8e8] text-[#855a0a]",
    icon: <Clock3 className="size-3" />,
  },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const style = statusStyle[status] ?? statusStyle.failed;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        style.className,
      )}
    >
      {style.icon}
      {style.label}
    </span>
  );
}

export function Progress({
  value,
  maximum,
  label,
}: {
  value: number;
  maximum: number;
  label: string;
}) {
  const percentage =
    maximum <= 0 ? 0 : Math.min(100, Math.round((value / maximum) * 100));
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-[#52605a]">{label}</span>
        <span className="tabular-nums text-[#7a8580]">
          {value} / {maximum}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#e9eeeb]">
        <div
          className="h-full rounded-full bg-[#0f766e] transition-[width]"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export function JsonBlock({
  value,
  maxHeight = "18rem",
}: {
  value: unknown;
  maxHeight?: string;
}) {
  return (
    <pre
      className="overflow-auto rounded-md border border-[#e2e7e4] bg-[#f7f8f7] p-3 font-mono text-[11px] leading-5 text-[#35423d]"
      style={{ maxHeight }}
    >
      {prettyJson(value)}
    </pre>
  );
}
