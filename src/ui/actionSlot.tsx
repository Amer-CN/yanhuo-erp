import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/*
 * 「动作行」槽（2026-11-12）。
 *
 * 为什么需要它：`.app-shell` 是「一屏高 + 内容区自己滚」的网格。任何
 * `position: sticky / fixed` 的动作条本质都是**浮在内容上**，加多少
 * `padding-bottom` 也只能保护「滚到底」那一帧，滚动中间照样穿过内容 ——
 * 这正是底栏当年被量出 1623 / 10798px² 相交的同源问题（见
 * docs/dock-belt-20261112.md）。唯一结构上恒为 0 的解法是让动作条拿到
 * **真实占位**：在网格里多开第 4 行（底栏顺延为第 5 行），动作条用
 * portal 渲染进这一行。内容区的滚动视口到第 4 行上沿为止，两者物理上
 * 不共面，不需要任何「留白够不够」的魔法数。
 *
 * 补充：portal 而不是「先把动作条写在 AppShell 里」——动作条的状态
 * （合计金额、saving 禁用态、回调）全在页面组件里，搬出去就要把状态
 * 抬升到 Shell，页面与 Shell 会耦合、弹层（Sheet）里也无法复用。
 * portal 只搬 DOM 位置，React 树、事件冒泡、state 一律不变。
 */

/** 槽节点；`null` = 当前没有槽（单测环境、弹层里、Shell 之外）。 */
const ActionSlotContext = createContext<HTMLElement | null>(null);

export function ActionSlotProvider({
  value,
  children
}: {
  value: HTMLElement | null;
  children: ReactNode;
}) {
  return <ActionSlotContext.Provider value={value}>{children}</ActionSlotContext.Provider>;
}

/** 拿动作行槽节点；没有槽时返回 null，调用方必须降级为流内渲染。 */
export function useActionSlot(): HTMLElement | null {
  return useContext(ActionSlotContext);
}

/**
 * 动作条的渲染入口：有槽就 portal 进去，没有槽就**原地渲染**。
 *
 * 原地降级是刻意的：单测里只挂载 <PurchasePage /> / <RecordPage /> 而没有
 * AppShell，槽为 null；这时宁可让动作条留在原来的流内位置（样式已不是
 * fixed/sticky，不会盖住任何东西），也不能让它整块消失。
 */
export function ActionBar({ children }: { children: ReactNode }) {
  const slot = useActionSlot();
  if (!slot) return <>{children}</>;
  return createPortal(children, slot);
}