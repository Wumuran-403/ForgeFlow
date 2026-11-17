const labels: Record<string, string> = {
  "STM32 BOM Recovery": "STM32 物料清单与采购演示",
  "STM32 Inventory Audit": "STM32 库存核查",
  "STM32 MCP Inventory Audit": "STM32 MCP 库存核查",
  "Check the STM32F103C8T6 development-board BOM for 2,000 boards, identify shortages, and create a simulated procurement draft when required.": "检查 2,000 块 STM32F103C8T6 开发板的物料清单与库存，识别缺料，并在需要时创建模拟采购草稿。",
  "Audit the STM32F103C8T6 BOM and simulated inventory for 2,000 boards without performing any write.": "核查 2,000 块 STM32F103C8T6 开发板的物料清单和模拟库存，不执行写入。",
  "Search the allowlisted MCP demo inventory for STM32 parts and report available stock without performing any write.": "通过预设的 MCP 库存服务查询 STM32 零件现货，不执行写入。",
  "The allowlisted local MCP inventory query completed. The persisted ToolRun contains the verified structured inventory result.": "已完成预设本地 MCP 库存查询。结构化结果保存在工具执行记录中。",
  "Create a local simulated procurement draft. This is a write tool and requires approval.": "创建本地模拟采购草稿。此操作属于写入，需要先审批。",
  "Inspect BOM and stock, identify shortages, and create an approval-gated simulated procurement draft.": "检查物料清单与库存，识别缺料，并在审批后创建模拟采购草稿。",
  "Read the BOM and simulated inventory, calculate shortages, and produce a read-only readiness report.": "读取物料清单和模拟库存，计算缺口并生成只读报告。",
  "Query the allowlisted local MCP inventory server through a real stdio connection and persisted Scheduler path.": "通过受信任的本地 MCP 服务查询库存，执行过程会保存记录。",
  queued: "排队中", running: "运行中", waiting_approval: "等待审批", waiting_review: "需要人工核对",
  completed: "已完成", failed: "失败", error: "错误", interrupted: "已中断", cancelled: "已取消",
  pause_requested: "正在暂停", paused: "已暂停", cancel_requested: "正在取消",
  succeeded: "成功", skipped: "已跳过", unknown: "结果未知", awaiting_approval: "等待审批", passed: "通过",
  provider: "模型实际用量", estimated: "估算用量", mixed: "混合用量", read: "读取", write: "写入",
  "normal": "正常", "invalid input": "输入无效", "inventory shortage": "库存不足",
  "spec or tool error": "规格或工具错误", "loop or recovery": "循环或恢复",
  "repeat": "重复调用", "short_cycle": "短周期循环", "no_progress_failure": "重复失败",
};

export function zh(value: string): string {
  return labels[value] ?? labels[value.toLowerCase()] ?? value;
}

export function zhReport(value: string): string {
  return zh(value)
    .replace(/STM32F103C8T6 BOM readiness report for ([\d,]+) boards:/g, "STM32F103C8T6 开发板物料核查报告（$1 块）：")
    .replace("- No inventory shortages were found.", "- 库存中未发现缺料。")
    .replace("- The simulated procurement write succeeded.", "- 模拟采购写入已完成。")
    .replace("- Procurement approval was rejected, so the simulated write was skipped.", "- 采购审批被拒绝，因此跳过了模拟写入。")
    .replace("- The simulated procurement write did not report success.", "- 模拟采购写入未确认成功。")
    .replace("- Draft re-read did not return a confirmed count.", "- 再次查询草稿时未得到确认数量。")
    .replace(/- ([^:\n]+): required (\d+), available (\d+), short (\d+); (\d+)-day demo lead time\./g, "- $1：需求 $2，现货 $3，缺口 $4；模拟交期 $5 天。")
    .replace(/- Re-reading confirmed (\d+) simulated procurement draft\(s\)\./g, "- 再次查询确认有 $1 份模拟采购草稿。")
    .replace("- No external inventory or procurement system was contacted.", "- 未连接外部库存或采购系统。");
}
