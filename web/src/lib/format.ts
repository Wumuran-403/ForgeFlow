export function formatDate(value: string | null): string {
  if (value === null) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatNumber(value: number | undefined): string {
  return value === undefined ? "0" : new Intl.NumberFormat().format(value);
}

export function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) return "暂无";
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 })
    .format(numerator / denominator);
}

export function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} 毫秒`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

export function truncate(value: string, length = 120): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}...`;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
