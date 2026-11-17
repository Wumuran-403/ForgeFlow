import {
  Activity,
  Bot,
  History,
  LayoutDashboard,
  ShieldCheck,
  FlaskConical,
} from "lucide-react";
import {
  NavLink,
  Outlet,
  useLocation,
} from "react-router-dom";

import { cn } from "./ui";

const navigation = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/workspace", label: "任务工作台", icon: Bot },
  { to: "/approvals", label: "审批中心", icon: ShieldCheck },
  { to: "/history", label: "执行历史", icon: History },
  { to: "/evaluations", label: "评测中心", icon: FlaskConical },
];

const pageTitles: Record<string, string> = {
  "/": "运行概览",
  "/workspace": "任务工作台",
  "/approvals": "审批中心",
  "/history": "执行历史",
  "/evaluations": "评测中心",
};

export function AppLayout() {
  const location = useLocation();
  const title = pageTitles[location.pathname] ?? "ForgeFlow";

  return (
    <div className="min-h-screen bg-[#f4f6f4] text-[#17211f]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-[#dce2de] bg-[#fbfcfb] lg:flex lg:flex-col">
        <div className="flex h-16 items-center border-b border-[#e1e6e3] px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-md bg-[#17211f] text-white">
              <Activity className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[-0.01em]">ForgeFlow</div>
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#7b8681]">
                智能体运行平台
              </div>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-[#e8f0ed] text-[#145e57]"
                    : "text-[#5b6863] hover:bg-[#f0f3f1] hover:text-[#27332f]",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#e1e6e3] p-3">
          <div className="mb-2 rounded-md bg-[#f1f4f2] px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7b8681]">
              专属工作区
            </div>
            <div className="mt-1 text-sm font-medium text-[#34413c]">匿名访客</div>
            <div className="mt-1 text-[10px] leading-4 text-[#7b8681]">任务仅供当前浏览器会话查看。</div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 border-b border-[#dce2de] bg-[#fbfcfb]/95 backdrop-blur">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-md bg-[#17211f] text-white lg:hidden">
                <Activity className="size-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-[#27332f]">{title}</div>
                <div className="hidden text-xs text-[#7a8580] sm:block">
                  查看任务执行与恢复进度
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-1.5 rounded-full border border-[#bfd9d3] bg-[#eff8f5] px-2.5 py-1 text-xs font-medium text-[#0f6d64] sm:inline-flex">
                <span className="size-1.5 rounded-full bg-[#0f766e]" />
                服务运行中
              </span>
              <span className="rounded-full border border-[#dce2de] bg-white px-2.5 py-1 text-[11px] font-medium text-[#63706b]">访客</span>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t border-[#e5e9e7] px-3 py-2 lg:hidden">
            {navigation.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-medium",
                    isActive
                      ? "bg-[#e8f0ed] text-[#145e57]"
                      : "text-[#63706b]",
                  )
                }
              >
                <Icon className="size-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
