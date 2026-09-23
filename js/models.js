/*
 * models.js — 漆线雕工坊返工令业务模型
 *
 * 职责：定义作品、返工令、补线材料等实体与不变量，负责 localStorage 持久化。
 * 不做排期计算（见 scheduler.js），不做 DOM 渲染（见 kanban.js）。
 *
 * 核心不变量：
 * 1. 一件缺陷作品同一时刻只能持有一张「未完结」返工令；字段更正时旧令归档、另立新令。
 * 2. 返工令必须记录责任工序、补线材料、操作者、承诺完成日。
 * 3. 材料逐项标记备齐状态；任何一项未备齐，整令不得进入排期（由 scheduler 判定）。
 * 4. 完成返工后须由另一人复核；复核人不得与操作者相同。
 */
(function (global) {
  "use strict";

  const WORK_KEY = "zfl42Works";
  const ORDER_KEY = "zfl42ReworkOrders";

  const PROCESSES = ["贴线", "阴干", "上金粉", "补金修色"];
  const ORDER_STATUS = { UNFINISHED: "未完成", COMPLETED: "已完成", ARCHIVED: "已归档" };
  const REVIEW_STATUS = { PENDING: "未复核", DONE: "已复核" };
  const MAX_PER_PROCESS_PER_DAY = 3;

  let works = [];
  let orders = [];
  let orderSeq = 1;

  // ---------- 工具 ----------
  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }
  function now() { return new Date().toLocaleString("zh-CN", { hour12: false }); }
  function nowIso() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // ---------- 种子数据 ----------
  function seedData() {
    const t = todayStr();
    works = [
      {
        id: uid(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70,
        dryDate: t, gold: "未处理", defect: "右下浪尖断线", delivery: "2026-10-02",
        status: "上金粉", note: "边线需保持低浮雕感",
        logs: [{ time: now(), text: "创建作品" }]
      },
      {
        id: uid(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95,
        dryDate: "2026-09-20", gold: "试扫粉", defect: "左侧枝干翘线",
        delivery: "2026-09-28", status: "贴线中", note: "客户要求金粉偏暗",
        logs: [{ time: now(), text: "创建作品" }, { time: now(), text: "记录翘线" }]
      },
      {
        id: uid(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40,
        dryDate: "2026-09-26", gold: "未处理", defect: "", delivery: "2026-10-10",
        status: "贴线中", note: "",
        logs: [{ time: now(), text: "创建作品" }]
      }
    ];

    const defective = works.filter(w => w.defect);
    orders = [
      {
        id: uid(), orderNo: "RG-0001", workId: defective[0].id,
        responsibleProcess: "贴线",
        materials: [
          { id: uid(), name: "朱红漆线（细）", quantity: "2 支", prepared: true },
          { id: uid(), name: "瓦灰调漆", quantity: "30g", prepared: true }
        ],
        operator: "阿珍", promisedCompletionDate: "2026-09-25",
        status: ORDER_STATUS.UNFINISHED, reviewStatus: REVIEW_STATUS.PENDING,
        reviewer: null, reviewedAt: null, startedAt: null, completedAt: null, completedAtIso: null,
        archivedReason: null, revisionOf: null,
        createdAt: now(), updatedAt: now(),
        logs: [{ time: now(), text: "开具返工令，责任工序：贴线" }]
      },
      {
        id: uid(), orderNo: "RG-0002", workId: defective[1].id,
        responsibleProcess: "贴线",
        materials: [
          { id: uid(), name: "黑漆线（混合）", quantity: "3 支", prepared: false },
          { id: uid(), name: "细砂纸", quantity: "2 张", prepared: true }
        ],
        operator: "阿强", promisedCompletionDate: "2026-09-24",
        status: ORDER_STATUS.UNFINISHED, reviewStatus: REVIEW_STATUS.PENDING,
        reviewer: null, reviewedAt: null, startedAt: null, completedAt: null, completedAtIso: null,
        archivedReason: null, revisionOf: null,
        createdAt: now(), updatedAt: now(),
        logs: [{ time: now(), text: "开具返工令，责任工序：贴线" }]
      }
    ];
    orderSeq = orders.length + 1;
  }

  // ---------- 持久化 ----------
  function load() {
    try {
      const w = JSON.parse(localStorage.getItem(WORK_KEY) || "null");
      const o = JSON.parse(localStorage.getItem(ORDER_KEY) || "null");
      if (Array.isArray(w) && Array.isArray(o)) {
        works = w;
        orders = o;
        orderSeq = orders.reduce((m, x) => {
          const n = parseInt(String(x.orderNo || "").replace(/\D/g, ""), 10);
          return Number.isFinite(n) && n >= m ? n + 1 : m;
        }, 1);
        return;
      }
    } catch (e) { /* 数据损坏则重建 */ }
    seedData();
    persist();
  }
  function persist() {
    localStorage.setItem(WORK_KEY, JSON.stringify(works));
    localStorage.setItem(ORDER_KEY, JSON.stringify(orders));
  }

  // ---------- 作品 ----------
  function listWorks() { return clone(works); }
  function getWork(id) {
    const w = works.find(x => x.id === id);
    return w ? clone(w) : null;
  }
  function addWork(data) {
    const w = {
      id: uid(),
      base: data.base, theme: data.theme, line: data.line,
      progress: Number(data.progress) || 0,
      dryDate: data.dryDate, gold: data.gold, defect: data.defect || "",
      delivery: data.delivery, status: data.status, note: data.note || "",
      logs: [{ time: now(), text: "创建作品" }]
    };
    works.unshift(w);
    persist();
    return clone(w);
  }
  function updateWorkStatus(id, status) {
    const w = works.find(x => x.id === id);
    if (!w) return;
    w.status = status;
    if (status === "待阴干") w.dryDate = todayStr();
    if (status === "上金粉") w.gold = "已上金粉";
    if (status === "待交付") w.progress = 100;
    w.logs.push({ time: now(), text: "更新为 " + status });
    persist();
  }
  function recordDefect(id, text) {
    const w = works.find(x => x.id === id);
    if (!w || !text) return;
    w.defect = w.defect ? w.defect + "；" + text : text;
    w.logs.push({ time: now(), text: "缺陷：" + text });
    persist();
  }
  function appendWorkLog(id, text) {
    const w = works.find(x => x.id === id);
    if (!w) return;
    w.logs.push({ time: now(), text });
    persist();
  }

  // ---------- 返工令查询 ----------
  function listOrders() { return clone(orders); }
  function getOrder(id) {
    const o = orders.find(x => x.id === id);
    return o ? clone(o) : null;
  }
  function ordersOfWork(workId) {
    return clone(orders.filter(o => o.workId === workId));
  }
  /** 一件作品当前是否已有未完结返工令（未完成且未归档）。 */
  function activeOrderOfWork(workId) {
    const o = orders.find(x => x.workId === workId && x.status === ORDER_STATUS.UNFINISHED);
    return o ? clone(o) : null;
  }

  // ---------- 校验 ----------
  const ValidationError = function (msg) { this.message = msg; this.name = "ValidationError"; };
  ValidationError.prototype = Object.create(Error.prototype);

  function assert(cond, msg) { if (!cond) throw new ValidationError(msg); }

  function validateDraft(draft) {
    assert(draft.responsibleProcess && PROCESSES.includes(draft.responsibleProcess),
      "请选择责任工序");
    assert(draft.operator && draft.operator.trim(), "请填写操作者");
    assert(draft.promisedCompletionDate, "请选择承诺完成日");
    assert(Array.isArray(draft.materials) && draft.materials.length > 0,
      "至少登记一项补线材料");
    draft.materials.forEach((m, i) => {
      assert(m.name && m.name.trim(), "第 " + (i + 1) + " 项材料名称为空");
    });
  }

  function nextOrderNo() {
    const no = "RG-" + String(orderSeq).padStart(4, "0");
    orderSeq += 1;
    return no;
  }

  // ---------- 返工令生命周期 ----------

  /**
   * 为缺陷作品开具返工令。
   * 若该作品已有未完结返工令则拒绝（一件缺陷作品只能有一张未完结令）。
   */
  function createOrder(workId, draft) {
    const work = works.find(w => w.id === workId);
    assert(work, "作品不存在");
    assert(work.defect && work.defect.trim(), "只有登记了缺陷的作品才能开具返工令");
    assert(!activeOrderOfWork(workId), "该作品已有未完结返工令，不能重复开具");
    validateDraft(draft);

    const o = {
      id: uid(), orderNo: nextOrderNo(), workId,
      responsibleProcess: draft.responsibleProcess,
      materials: draft.materials.map(m => ({
        id: uid(), name: m.name.trim(),
        quantity: (m.quantity || "").toString().trim(),
        prepared: !!m.prepared
      })),
      operator: draft.operator.trim(),
      promisedCompletionDate: draft.promisedCompletionDate,
      status: ORDER_STATUS.UNFINISHED,
      reviewStatus: REVIEW_STATUS.PENDING,
      reviewer: null, reviewedAt: null,
      startedAt: null, completedAt: null, completedAtIso: null,
      archivedReason: null, revisionOf: null,
      createdAt: now(), updatedAt: now(),
      logs: [{ time: now(), text: "开具返工令，责任工序：" + draft.responsibleProcess }]
    };
    orders.unshift(o);
    work.logs.push({ time: now(), text: "开具返工令 " + o.orderNo });
    persist();
    return clone(o);
  }

  /**
   * 更正派工字段（责任工序/材料/操作者/承诺完成日之一）。
   * 对未完结或已完成（含已放行）的令均可更正：旧排期与放行结论立即失效，
   * 旧令原样归档留档，另立一张新令承接更正内容、重新排期。
   */
  function reviseOrder(orderId, draft) {
    const old = orders.find(o => o.id === orderId);
    assert(old, "返工令不存在");
    assert(old.status !== ORDER_STATUS.ARCHIVED, "留档旧令不能再更正");
    validateDraft(draft);

    // 旧令归档：保留当时全部字段、排期与放行痕迹
    old.status = ORDER_STATUS.ARCHIVED;
    old.archivedReason = "派工字段更正，旧令留档";
    old.updatedAt = now();
    old.logs.push({ time: now(), text: "派工字段更正，旧令归档（排期与放行结论失效）" });

    const neo = {
      id: uid(), orderNo: nextOrderNo(), workId: old.workId,
      responsibleProcess: draft.responsibleProcess,
      materials: draft.materials.map(m => ({
        id: uid(), name: m.name.trim(),
        quantity: (m.quantity || "").toString().trim(),
        prepared: !!m.prepared
      })),
      operator: draft.operator.trim(),
      promisedCompletionDate: draft.promisedCompletionDate,
      status: ORDER_STATUS.UNFINISHED,
      reviewStatus: REVIEW_STATUS.PENDING,
      reviewer: null, reviewedAt: null,
      startedAt: null, completedAt: null, completedAtIso: null,
      archivedReason: null,
      revisionOf: old.id,
      createdAt: now(), updatedAt: now(),
      logs: [{ time: now(), text: "由 " + old.orderNo + " 更正后新立返工令" }]
    };
    orders.unshift(neo);
    const work = works.find(w => w.id === old.workId);
    if (work) {
      work.logs.push({ time: now(), text: old.orderNo + " 更正归档，新立 " + neo.orderNo });
    }
    persist();
    return { archived: clone(old), current: clone(neo) };
  }

  /** 切换某项材料的备齐状态。 */
  function toggleMaterial(orderId, materialId) {
    const o = orders.find(x => x.id === orderId);
    assert(o, "返工令不存在");
    assert(o.status === ORDER_STATUS.UNFINISHED, "返工令已结束，不能改材料");
    const m = o.materials.find(x => x.id === materialId);
    assert(m, "材料不存在");
    m.prepared = !m.prepared;
    o.updatedAt = now();
    o.logs.push({ time: now(), text: (m.prepared ? "备齐材料：" : "材料退回未齐：") + m.name });
    persist();
    return clone(o);
  }

  /** 操作者开始返工。 */
  function startRework(orderId) {
    const o = orders.find(x => x.id === orderId);
    assert(o, "返工令不存在");
    assert(o.status === ORDER_STATUS.UNFINISHED, "返工令已结束");
    assert(o.materials.every(m => m.prepared), "材料未备齐，不能开工");
    if (!o.startedAt) {
      o.startedAt = now();
      o.logs.push({ time: now(), text: o.operator + " 开始返工" });
    }
    persist();
    return clone(o);
  }

  /** 操作者完成返工，进入待复核；不能自行放行。 */
  function completeRework(orderId) {
    const o = orders.find(x => x.id === orderId);
    assert(o, "返工令不存在");
    assert(o.status === ORDER_STATUS.UNFINISHED, "返工令已结束");
    assert(o.startedAt, "尚未开工");
    o.status = ORDER_STATUS.COMPLETED;
    o.reviewStatus = REVIEW_STATUS.PENDING;
    o.completedAt = now();
    o.completedAtIso = nowIso();
    o.logs.push({ time: now(), text: o.operator + " 完成返工，等待他人复核" });
    persist();
    const work = works.find(w => w.id === o.workId);
    if (work) work.logs.push({ time: now(), text: o.orderNo + " 返工完成，待复核" });
    return clone(o);
  }

  /**
   * 另一人复核放行。
   * 复核人必须与操作者不同；未复核对不得切到待交付（由 kanban 在转态前调用）。
   */
  function reviewOrder(orderId, reviewer) {
    const o = orders.find(x => x.id === orderId);
    assert(o, "返工令不存在");
    assert(o.status === ORDER_STATUS.COMPLETED, "返工尚未完成，不能复核");
    assert(o.reviewStatus === REVIEW_STATUS.PENDING, "该令已复核");
    assert(reviewer && reviewer.trim(), "请填写复核人");
    assert(reviewer.trim() !== o.operator,
      "复核人不得与操作者为同一人（操作者：" + o.operator + "）");
    o.reviewStatus = REVIEW_STATUS.DONE;
    o.reviewer = reviewer.trim();
    o.reviewedAt = now();
    o.logs.push({ time: now(), text: "复核人 " + o.reviewer + " 放行通过" });
    const work = works.find(w => w.id === o.workId);
    if (work) work.logs.push({ time: now(), text: o.orderNo + " 经 " + o.reviewer + " 复核放行" });
    persist();
    return clone(o);
  }

  /** 复核驳回：退回未完成，须重新返工。 */
  function rejectReview(orderId, reviewer, reason) {
    const o = orders.find(x => x.id === orderId);
    assert(o, "返工令不存在");
    assert(o.status === ORDER_STATUS.COMPLETED, "返工尚未完成");
    assert(reviewer && reviewer.trim(), "请填写复核人");
    assert(reviewer.trim() !== o.operator, "复核人不得与操作者为同一人");
    o.status = ORDER_STATUS.UNFINISHED;
    o.reviewStatus = REVIEW_STATUS.PENDING;
    o.reviewer = null;
    o.reviewedAt = null;
    o.completedAt = null;
    o.completedAtIso = null;
    o.updatedAt = now();
    o.logs.push({
      time: now(),
      text: "复核人 " + reviewer.trim() + " 驳回：" + (reason || "未通过，需返工")
    });
    persist();
    return clone(o);
  }

  /**
   * 作品能否切到待交付：其未完结/已完成返工令必须全部经他人复核通过。
   * 返回 { ok, reason }。
   */
  function canDeliver(workId) {
    const work = works.find(w => w.id === workId);
    if (!work) return { ok: false, reason: "作品不存在" };
    const linked = orders.filter(o => o.workId === workId);
    if (work.defect && linked.length === 0) {
      return { ok: false, reason: "缺陷作品尚未开具返工令" };
    }
    const blocking = linked.filter(o =>
      o.status !== ORDER_STATUS.ARCHIVED &&
      !(o.status === ORDER_STATUS.COMPLETED && o.reviewStatus === REVIEW_STATUS.DONE)
    );
    if (blocking.length > 0) {
      return {
        ok: false,
        reason: "还有 " + blocking.length + " 张返工令未完成或未经他人复核，不能待交付"
      };
    }
    return { ok: true, reason: "返工均已复核放行" };
  }

  function resetAll() {
    seedData();
    persist();
  }

  // ---------- 导出 ----------
  global.WorkshopModel = {
    PROCESSES, ORDER_STATUS, REVIEW_STATUS,
    MAX_PER_PROCESS_PER_DAY, ValidationError,
    load, persist,
    listWorks, getWork, addWork, updateWorkStatus, recordDefect, appendWorkLog,
    listOrders, getOrder, ordersOfWork, activeOrderOfWork,
    createOrder, reviseOrder, toggleMaterial,
    startRework, completeRework, reviewOrder, rejectReview, canDeliver,
    resetAll, todayStr, now, uid
  };
})(window);
