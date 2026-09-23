/*
 * scheduler.js — 补线工位排期判定
 *
 * 职责：读取 models 中的作品与返工令，纯函数式地计算每张返工令的排期结论。
 * 不持久化任何排期结果——每次刷新都从作品履历/返工令重算，保证
 * 「刷新后队列与作品履历一致」。字段更正后旧令已归档，自然退出队列。
 *
 * 排期规则：
 * 1. 材料未备齐（任一项 prepared=false）→ blocked，整令不得进入排期。
 * 2. 同一责任工序每天最多排 MAX_PER_PROCESS_PER_DAY(=3) 件。
 * 3. 超额时交付日期近者优先；被挤下的件顺延到下一可用日期，
 *    但保留原排期原因（承诺完成日），只在排期说明里标注顺延。
 * 4. 已完成/已归档令不参与排期。
 *
 * 结论结构：
 *   { orderId, phase, scheduledDate|null, reason, materialPending:[...],
 *     overflow:boolean, originalDate|null }
 *   phase: "blocked" | "scheduled" | "working" | "pendingReview" | "released"
 */
(function (global) {
  "use strict";

  const M = global.WorkshopModel;
  const DAILY_CAP = M.MAX_PER_PROCESS_PER_DAY;

  function workDelivery(workId, workMap) {
    const w = workMap.get(workId);
    return w ? w.delivery : "9999-12-31";
  }

  /** 给指定工序从 startDate 起找第一个未满的日期（startDate 当天也算）。 */
  function nextOpenDate(process, startDate, usedByProcess) {
    const used = usedByProcess[process] || (usedByProcess[process] = {});
    let d = new Date(startDate + "T00:00:00");
    for (let i = 0; i < 3660; i++) {
      const key = d.toISOString().slice(0, 10);
      if ((used[key] || 0) < DAILY_CAP) return key;
      d.setDate(d.getDate() + 1);
    }
    return null;
  }
  function occupy(process, date, usedByProcess) {
    const used = usedByProcess[process] || (usedByProcess[process] = {});
    used[date] = (used[date] || 0) + 1;
  }

  /**
   * 计算全部返工令的排期结论。
   * @param {Array} orders  models.listOrders() 结果
   * @param {Map}   workMap id -> work
   * @returns {{rows: Array, queue: Array, blocked: Array, byDate: Object}}
   */
  function evaluate(orders, workMap) {
    const usedByProcess = {};
    const rows = [];

    // 已完成 / 已归档：直接给阶段，不占工位容量
    orders.forEach(o => {
      if (o.status === M.ORDER_STATUS.ARCHIVED) {
        rows.push({
          orderId: o.id, phase: "archived", scheduledDate: null,
          reason: "旧令留档：" + (o.archivedReason || "派工更正"),
          materialPending: [], overflow: false, originalDate: null
        });
      } else if (o.status === M.ORDER_STATUS.COMPLETED) {
        const released = o.reviewStatus === M.REVIEW_STATUS.DONE;
        rows.push({
          orderId: o.id, phase: released ? "released" : "pendingReview",
          scheduledDate: o.completedAtIso ? o.completedAtIso.slice(0, 10) : null,
          reason: released
            ? "已由 " + o.reviewer + " 复核放行，可转待交付"
            : "返工已完成，等待他人复核",
          materialPending: [], overflow: false, originalDate: null
        });
      }
    });

    // 未完成令：先判材料闸门
    const active = orders.filter(o => o.status === M.ORDER_STATUS.UNFINISHED);
    const blockedRows = [];
    const candidates = [];

    active.forEach(o => {
      const pending = o.materials.filter(m => !m.prepared).map(m => m.name);
      if (pending.length > 0) {
        blockedRows.push({
          orderId: o.id, phase: "blocked", scheduledDate: null,
          reason: "补线材料未备齐，整令不得进入排期",
          materialPending: pending, overflow: false, originalDate: null
        });
      } else {
        candidates.push(o);
      }
    });

    /*
     * 容量分配：
     * - 先按承诺完成日升序，同日按作品交付日升序（交付近者先）。
     * - 每件尝试排入「承诺完成日当天」；该工序当天已满则顺延，
     *   顺延件保留原排期原因（承诺完成日），并标注 overflow。
     * - 顺延占用后续日期时也计入容量，因此前一日挤下的件
     *   相对后来者天然优先（先处理先占位）。
     */
    candidates
      .map(o => ({
        o,
        promised: o.promisedCompletionDate,
        delivery: workDelivery(o.workId, workMap)
      }))
      .sort((a, b) =>
        a.promised.localeCompare(b.promised) ||
        a.delivery.localeCompare(b.delivery) ||
        a.o.orderNo.localeCompare(b.o.orderNo)
      )
      .forEach(({ o, promised, delivery }) => {
        const used = usedByProcess[o.responsibleProcess] ||
          (usedByProcess[o.responsibleProcess] = {});
        const onDay = used[promised] || 0;

        if (onDay < DAILY_CAP) {
          occupy(o.responsibleProcess, promised, usedByProcess);
          rows.push({
            orderId: o.id, phase: "scheduled", scheduledDate: promised,
            reason: "按承诺完成日排入 " + promised,
            materialPending: [], overflow: false, originalDate: null,
            delivery
          });
        } else {
          // 被挤下：交付近者已先占位；本件顺延但保留原排期原因
          const moved = nextOpenDate(o.responsibleProcess, promised, usedByProcess);
          if (moved) occupy(o.responsibleProcess, moved, usedByProcess);
          rows.push({
            orderId: o.id, phase: "scheduled", scheduledDate: moved,
            reason: "承诺日 " + promised + " 该工序已满 3 件，按交付日（" +
              delivery + "）排序后顺延；保留原排期原因：按承诺完成日 " + promised,
            materialPending: [], overflow: true, originalDate: promised, delivery
          });
        }
      });

    blockedRows.forEach(r => rows.push(r));

    // ---------- 看板队列 ----------
    const orderMap = new Map(orders.map(o => [o.id, o]));
    const rowMap = new Map(rows.map(r => [r.orderId, r]));

    const queueRows = rows
      .filter(r => r.phase !== "archived")
      .map(r => ({ ...r, order: orderMap.get(r.orderId) }))
      .filter(r => r.order);

    // 未开工但材料齐 -> scheduled；已开工 -> working
    queueRows.forEach(r => {
      if (r.phase === "scheduled" && r.order.startedAt) {
        r.phase = "working";
        r.reason = "已开工（" + r.order.operator + "），排期日 " +
          (r.scheduledDate || "—") +
          (r.overflow ? "；原排期原因：按承诺完成日 " + r.originalDate : "");
      }
    });

    const queue = queueRows
      .filter(r => r.phase === "scheduled" || r.phase === "working")
      .sort((a, b) =>
        (a.scheduledDate || "9999").localeCompare(b.scheduledDate || "9999") ||
        (a.delivery || "").localeCompare(b.delivery || ""));

    const blocked = queueRows.filter(r => r.phase === "blocked");
    const pendingReview = queueRows.filter(r => r.phase === "pendingReview");
    const released = queueRows.filter(r => r.phase === "released");

    // 日期 -> 工序 -> 行（供工位日历使用）
    const byDate = {};
    queueRows.forEach(r => {
      if (!r.scheduledDate) return;
      const p = r.order.responsibleProcess;
      (byDate[r.scheduledDate] || (byDate[r.scheduledDate] = {}));
      const bucket = byDate[r.scheduledDate][p] || (byDate[r.scheduledDate][p] = []);
      bucket.push(r);
    });

    return { rows: rows.map(r => ({ ...r })), queue, blocked, pendingReview, released, byDate, rowMap };
  }

  /** 便捷入口：直接从 model 快照重算。 */
  function recompute() {
    const orders = M.listOrders();
    const workMap = new Map(M.listWorks().map(w => [w.id, w]));
    return evaluate(orders, workMap);
  }

  /** 某工序某日已排件数与剩余容量。 */
  function capacityOf(result, process, date) {
    const used = result.byDate[date] && result.byDate[date][process];
    const count = used ? used.length : 0;
    return { process, date, used: count, cap: DAILY_CAP, remaining: DAILY_CAP - count };
  }

  global.WorkshopScheduler = {
    DAILY_CAP, evaluate, recompute, capacityOf
  };
})(window);
