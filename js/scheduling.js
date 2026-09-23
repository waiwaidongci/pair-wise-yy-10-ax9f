/*
 * scheduling.js —— 补线工位排期判定
 * 纯判定模块：只读写 Store 中返工令的 queue / status，不碰 DOM。
 *
 * 规则：
 * 1) 材料未备齐，整令不得进入排期（状态停留在「待备料」）。
 * 2) 同一责任工序每日最多 3 件；候选按作品交付日期近者先，承诺完成日次之。
 * 3) 超出容量被挤下的件保留原排期原因，回到待排期（state=bumped），可再次参与判定。
 * 4) 派工更正后旧令 queue.invalidated=true，不再占用任何容量；新令重新走判定。
 */
(function (global) {
  "use strict";

  const { DAILY_CAPACITY, WorkshopError } = global.Workshop;

  function materialsReady(order) {
    return order.materials.length > 0 && order.materials.every(m => m.ready >= m.need);
  }

  /* 可以参与某日判定的候选令：材料备齐、处于待排期，且当日尚无仍有效的已排期结论。
   * 被挤下（state=bumped）或旧结论已被派工更正失效（invalidated）的令可再次参与。
   */
  function candidatesFor(store, date) {
    return store.activeOrders()
      .filter(o => materialsReady(o))
      .filter(o => {
        if (o.status !== "待排期") return false;
        // 当日已判定且结论仍有效，不再重复判定
        if (o.queue && !o.queue.invalidated &&
            o.queue.targetDate === date && o.queue.state === "scheduled") {
          return false;
        }
        return true;
      })
      .map(o => ({
        order: o,
        work: store.getWork(o.workId)
      }))
      .sort((a, b) =>
        (a.work.delivery || "").localeCompare(b.work.delivery || "") ||
        a.order.promisedDate.localeCompare(b.order.promisedDate) ||
        a.order.createdAt.localeCompare(b.order.createdAt)
      );
  }

  /* 当日某工序已占工位数：只统计结论有效（未被更正失效）的已排期/返工中/待复核令。
   * 已完结的令不再占用补线工位。
   */
  function occupiedSlots(store, process, date) {
    return store.activeOrders().filter(o =>
      o.responsibleProcess === process &&
      o.queue &&
      !o.queue.invalidated &&
      o.queue.targetDate === date &&
      o.queue.state === "scheduled" &&
      ["已排期", "返工中", "待复核"].includes(o.status)
    );
  }

  /*
   * planDay：对指定日期所有工序执行一次容量判定。
   * 返回报告 { date, rows: [{ process, order, result: 'scheduled'|'bumped', reason }] }。
   * 被挤下的件保留原排期原因（queue.reason 不覆盖），仅把 state 置为 bumped。
   */
  function planDay(store, date, reasons) {
    const rows = [];
    const byProcess = new Map();
    candidatesFor(store, date).forEach(c => {
      const list = byProcess.get(c.order.responsibleProcess) || [];
      list.push(c);
      byProcess.set(c.order.responsibleProcess, list);
    });

    byProcess.forEach((cands, process) => {
      const used = occupiedSlots(store, process, date).length;
      let remaining = DAILY_CAPACITY - used;
      cands.forEach(c => {
        const o = c.order;
        const reason = (reasons && reasons[o.id]) || (o.queue && o.queue.reason) || "按交付日期就近排入";
        if (remaining > 0) {
          o.queue = { targetDate: date, reason, state: "scheduled", invalidated: false };
          o.status = "已排期";
          o.history.push(`${new Date().toLocaleString("zh-CN", { hour12: false })} 判定排入 ${date}（${process}工位），原因：${reason}`);
          rows.push({ process, order: o, result: "scheduled", reason });
          remaining -= 1;
        } else {
          // 保留原排期原因：若此前已有原因则不覆盖，记录被挤下
          const keptReason = (o.queue && o.queue.reason) ? o.queue.reason : reason;
          o.queue = { targetDate: date, reason: keptReason, state: "bumped", invalidated: false };
          o.status = "待排期";
          o.history.push(`${new Date().toLocaleString("zh-CN", { hour12: false })} ${date} ${process}工位已满（每日${DAILY_CAPACITY}件），交付日期较晚被挤下，保留排期原因：${keptReason}`);
          rows.push({ process, order: o, result: "bumped", reason: keptReason });
        }
      });
    });

    store.save();
    return { date, rows };
  }

  /* 单令排入指定日期（带原因）。容量满时同样按「交付近者先」当场比较：
   * 若新令比工位上交付最晚的一件更近，则新令顶入，最晚的那件被挤下并保留原因。
   */
  function enqueue(store, orderId, date, reason) {
    const order = store.getOrder(orderId);
    if (!order || order.archived) throw new WorkshopError("返工令不存在或已留档");
    if (!materialsReady(order)) throw new WorkshopError("补线材料未备齐，整令不得进入排期");
    if (order.status !== "待排期") throw new WorkshopError("只有待排期的令可以申请排期");
    reason = (reason || "").trim() || "按交付日期就近排入";

    const occupied = occupiedSlots(store, order.responsibleProcess, date);
    if (occupied.length < DAILY_CAPACITY) {
      order.queue = { targetDate: date, reason, state: "scheduled", invalidated: false };
      order.status = "已排期";
      order.history.push(`${new Date().toLocaleString("zh-CN", { hour12: false })} 判定排入 ${date}，原因：${reason}`);
      store.save();
      return { bumpedOut: [] };
    }

    // 满员：与工位上交付最晚者比较
    const withWorks = occupied.map(o => ({ order: o, work: store.getWork(o.workId) }));
    withWorks.sort((a, b) =>
      (b.work.delivery || "").localeCompare(a.work.delivery || "") ||
      b.order.promisedDate.localeCompare(a.order.promisedDate));
    const weakest = withWorks[0].order;
    const newDelivery = store.getWork(order.workId).delivery || "";
    const weakDelivery = store.getWork(weakest.workId).delivery || "";
    const nearer = newDelivery.localeCompare(weakDelivery) < 0 ||
      (newDelivery === weakDelivery && order.promisedDate.localeCompare(weakest.promisedDate) < 0);
    if (!nearer) {
      // 新令自己被挤下，同样保留其申报原因
      order.queue = { targetDate: date, reason, state: "bumped", invalidated: false };
      order.status = "待排期";
      order.history.push(`${new Date().toLocaleString("zh-CN", { hour12: false })} ${date} ${order.responsibleProcess}工位已满（每日${DAILY_CAPACITY}件），交付日期较晚被挤下，保留排期原因：${reason}`);
      store.save();
      return { bumpedOut: [order] };
    }

    const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
    // 顶入：最晚者被挤下，保留它原有的排期原因
    const keptReason = weakest.queue.reason;
    weakest.queue = { targetDate: date, reason: keptReason, state: "bumped", invalidated: false };
    weakest.status = "待排期";
    weakest.history.push(`${ts()} 被交付日期更近的令顶下工位，保留原排期原因：${keptReason}`);

    order.queue = { targetDate: date, reason, state: "scheduled", invalidated: false };
    order.status = "已排期";
    order.history.push(`${ts()} 判定排入 ${date}（顶下交付较晚件），原因：${reason}`);
    store.save();
    return { bumpedOut: [weakest] };
  }

  /* 从已排期撤回到待排期（不改派工字段）。 */
  function dequeue(store, orderId) {
    const order = store.getOrder(orderId);
    if (!order || order.archived) throw new WorkshopError("返工令不存在或已留档");
    if (!["已排期", "返工中", "待复核"].includes(order.status)) {
      throw new WorkshopError("当前状态不能撤回排期");
    }
    order.status = materialsReady(order) ? "待排期" : "待备料";
    order.history.push(`${new Date().toLocaleString("zh-CN", { hour12: false })} 撤回原排期（${order.queue ? order.queue.targetDate : "-"}），回到${order.status}`);
    order.queue = null;
    order.release = null;
    order.completedAt = null;
    store.save();
  }

  function dayLoad(store, process, date) {
    return occupiedSlots(store, process, date).length;
  }

  global.Workshop.scheduling = {
    materialsReady,
    candidatesFor,
    occupiedSlots,
    planDay,
    enqueue,
    dequeue,
    dayLoad,
    DAILY_CAPACITY
  };
})(window);
