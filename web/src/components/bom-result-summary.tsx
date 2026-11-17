import { deriveBomSummary } from "../lib/bom-summary";
import { formatNumber } from "../lib/format";
import type { TaskDetail } from "../lib/types";

export function BomResultSummary({ task }: { task: TaskDetail }) {
  const result = deriveBomSummary(task);
  if (result === null) return null;

  const draftMessage = result.draft === "created"
    ? `本次任务记录显示已创建模拟采购草稿 ${result.draftId}${result.readbackConfirmed ? "，当时再次查询已确认" : "；尚无再次查询的确认记录"}。`
    : result.draft === "waiting_approval" ? "采购草稿尚未创建，正在等待写入审批或执行。"
    : result.draft === "rejected" ? "采购写入已被拒绝，没有创建草稿。"
    : result.draft === "unknown" ? "采购写入结果无法确认，需要人工核对；请勿重复执行。"
    : result.draft === "failed" ? "采购写入未成功，没有已确认的草稿。"
    : "尚未发起采购草稿写入。";

  return (
    <section className="rounded-lg border border-[#bfd9d3] bg-[#f2f8f6] p-4 sm:p-5" aria-label="物料核查结果">
      <div className="text-xs font-semibold text-[#0f6d64]">业务结果</div>
      <h3 className="mt-1 text-lg font-semibold text-[#24362f]">物料核查结果</h3>
      <p className="mt-1 text-sm text-[#52645c]">
        {result.complete
          ? result.shortages.length > 0
            ? `已核查 ${result.checkedCount} 种物料，发现 ${result.shortages.length} 种缺料。`
            : `已核查 ${result.checkedCount} 种物料，暂无缺料。`
          : `已核查 ${result.checkedCount}${result.expectedCount === null ? "" : ` / ${result.expectedCount}`} 种物料，结果尚未完整。`}
      </p>
      {result.shortages.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {result.shortages.map((item) => (
            <div key={item.partNumber} className="rounded-md border border-[#e8d5a9] bg-white px-3 py-3 sm:flex sm:items-center sm:justify-between sm:gap-4">
              <div>
                <div className="font-medium text-[#2d3934]">{item.displayName}<span className="ml-2 text-xs font-normal text-[#718078]">{item.partNumber}{item.designator === null ? "" : ` · ${item.designator}`}</span></div>
                <div className="mt-1 text-xs text-[#63706b]">需要 {formatNumber(item.required)} · 可用 {formatNumber(item.available)}{item.leadTimeDays === null ? "" : ` · 模拟交期 ${item.leadTimeDays} 天`}</div>
              </div>
              <div className="mt-2 text-sm font-semibold text-[#98630a] sm:mt-0">缺少 {formatNumber(item.shortage)} 个</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-4 rounded-md bg-white px-3 py-3 text-sm text-[#35423d]">
        <span className="font-semibold">采购进展：</span>{draftMessage}
      </div>
      <p className="mt-3 text-xs text-[#728078]">以上根据本次任务保存的工具结果生成；采购草稿仅存在于本地模拟环境，服务重启后业务草稿可能消失，不会向真实供应商下单。</p>
    </section>
  );
}
