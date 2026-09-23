/*
 * models.js —— 漆线雕工坊业务模型
 * 负责：作品、返工令、补线材料、操作者、复核放行结论的数据结构与不变量校验。
 * 不做任何 DOM / 排产运算，排期判定见 scheduling.js，看板交互见 kanban.js。
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "zfl42WorkshopV2";
  const LEGACY_KEY = "zfl42Works";

  const WORK_STATUSES = ["贴线中", "待阴干", "上金粉", "待返工", "待交付"];
  // 返工令状态：待备料 → 待排期 → 已排期 → 返工中 → 待复核 → 已完结；更正派工后旧令置为「已作废」留档
  const ORDER_STATUSES = ["待备料", "待排期", "已排期", "返工中", "待复核", "已完结", "已作废"];
  const RESPONSIBLE_PROCESSES = ["贴线", "盘线塑形", "阴干", "上金粉"];
  const MATERIAL_HINTS = [
    { name: "漆线", unit: "米" },
    { name: "金粉", unit: "克" },
    { name: "桐油", unit: "毫升" },
    { name: "夏布", unit: "块" }
  ];
  const DAILY_CAPACITY = 3; // 同一责任工序每日最多排三件

  class WorkshopError extends Error {}

  function uid(prefix) {
    return (prefix || "") + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function stamp() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function normalizeMaterials(lines) {
    const out = [];
    (lines || []).forEach(raw => {
      const name = (raw.name || "").trim();
      const need = Number(raw.need);
      if (!name) throw new WorkshopError("补线材料名称不能为空");
      if (!Number.isFinite(need) || need <= 0) throw new WorkshopError(`材料「${name}」的需求量必须大于 0`);
      let ready = Number(raw.ready) || 0;
      ready = Math.max(0, Math.min(ready, need));
      out.push({ id: uid("m-"), name, unit: raw.unit || "", need, ready });
    });
    if (!out.length) throw new WorkshopError("返工令至少要登记一种补线材料");
    return out;
  }

  class Store {
    constructor(state) {
      this.state = state;
    }

    static load() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try { return new Store(JSON.parse(raw)); } catch (err) { /* 落库损坏则重建 */ }
      }
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
      return new Store(legacy ? migrate(legacy) : seedState());
    }

    save() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }

    // ---------- 查询 ----------
    getWork(id) {
      return this.state.works.find(w => w.id === id);
    }
    getOrder(id) {
      return this.state.orders.find(o => o.id === id);
    }
    activeOrders() {
      return this.state.orders.filter(o => !o.archived && o.status !== "已作废");
    }
    findActiveOrder(workId) {
      // 一件缺陷作品同时只能有一张未完结返工令
      return this.activeOrders().find(o => o.workId === workId);
    }
    relatedOrders(workId) {
      return this.state.orders
        .filter(o => o.workId === workId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    // ---------- 作品 ----------
    addWork(data) {
      const work = {
        id: uid("w-"),
        base: data.base.trim(),
        theme: data.theme.trim(),
        line: data.line,
        progress: Number(data.progress) || 0,
        dryDate: data.dryDate,
        gold: data.gold,
        defect: (data.defect || "").trim(),
        delivery: data.delivery,
        status: data.status,
        note: (data.note || "").trim(),
        activeOrderId: null,
        logs: [`${stamp()} 创建作品`]
      };
      this.state.works.unshift(work);
      this.save();
      return work;
    }

    recordDefect(workId, text) {
      const work = this.getWork(workId);
      const value = (text || "").trim();
      if (!value) throw new WorkshopError("请填写缺陷位置");
      work.defect = work.defect ? `${work.defect}; ${value}` : value;
      work.logs.push(`${stamp()} 缺陷：${value}`);
      this.save();
    }

    setWorkStatus(workId, status) {
      const work = this.getWork(workId);
      if (status === "待交付" && work.defect) {
        // 缺陷作品必须持有有效放行结论：无令、有未完结令、放行被更正失效，一律不得交付
        const order = this.findActiveOrder(workId);
        if (!order) throw new WorkshopError("缺陷作品尚未开具返工令，不能转入待交付");
        if (!(order.release && order.release.result === "pass" && !order.release.invalidated)) {
          throw new WorkshopError(`返工令 ${order.id} 未经另一人复核放行，不能转入待交付`);
        }
      }
      work.status = status;
      if (status === "待阴干") work.dryDate = todayStr();
      if (status === "上金粉") work.gold = "已上金粉";
      if (status === "待交付") work.progress = 100;
      work.logs.push(`${stamp()} 更新为 ${status}`);
      this.save();
    }

    logWork(workId, text) {
      this.getWork(workId).logs.push(`${stamp()} ${text}`);
    }

    // ---------- 返工令 ----------
    canCreateOrder(workId) {
      const work = this.getWork(workId);
      if (!work) return { ok: false, reason: "作品不存在" };
      if (!work.defect) return { ok: false, reason: "只有缺陷作品才能生成返工令" };
      if (this.findActiveOrder(workId)) return { ok: false, reason: "该作品已有一张未完结返工令" };
      return { ok: true };
    }

    createOrder(input) {
      const check = this.canCreateOrder(input.workId);
      if (!check.ok) throw new WorkshopError(check.reason);
      this.assertDispatch(input);
      const work = this.getWork(input.workId);
      const materials = normalizeMaterials(input.materials);
      const ready = materials.every(m => m.ready >= m.need);
      const order = {
        id: uid("RW"),
        workId: input.workId,
        responsibleProcess: input.responsibleProcess,
        materials,
        operatorId: input.operatorId,
        promisedDate: input.promisedDate,
        status: ready ? "待排期" : "待备料",
        revision: 1,
        supersedes: null,
        supersededBy: null,
        archived: false,
        queue: null,     // { targetDate, reason, state: queued|scheduled|bumped, invalidated }
        release: null,   // { reviewerId, result: pass|reject, comment, reviewedAt, invalidated }
        completedAt: null,
        createdAt: new Date().toISOString(),
        history: [`${stamp()} 开具返工令，责任工序：${input.responsibleProcess}，${ready ? "补线材料已备齐，进入待排期" : "补线材料未备齐，整令暂缓排期"}`]
      };
      this.state.orders.push(order);
      work.status = "待返工";
      work.activeOrderId = order.id;
      work.logs.push(`${stamp()} 开具返工令 ${order.id}`);
      this.save();
      return order;
    }

    assertDispatch(input) {
      if (!RESPONSIBLE_PROCESSES.includes(input.responsibleProcess)) {
        throw new WorkshopError("请选择责任工序");
      }
      if (!this.state.operators.some(o => o.id === input.operatorId)) {
        throw new WorkshopError("请选择操作者");
      }
      if (!input.promisedDate) throw new WorkshopError("请填写承诺完成日");
      normalizeMaterials(input.materials); // 仅做校验
    }

    setMaterialReady(orderId, lineId, ready) {
      const order = this.getOrder(orderId);
      if (order.archived) throw new WorkshopError("旧令已留档，不能再改备料");
      if (order.queue) throw new WorkshopError("已进入排期的令不能再改备料数量，如需调整请更正派工");
      const line = order.materials.find(m => m.id === lineId);
      line.ready = Math.max(0, Math.min(Number(ready) || 0, line.need));
      const readyNow = order.materials.every(m => m.ready >= m.need);
      if (readyNow && order.status === "待备料") {
        order.status = "待排期";
        order.history.push(`${stamp()} 补线材料备齐，转入待排期`);
      } else if (!readyNow && order.status === "待排期") {
        order.status = "待备料";
        order.history.push(`${stamp()} 备料数量被调整，材料未齐，退回待备料`);
      }
      this.save();
    }

    startOrder(orderId) {
      const order = this.getOrder(orderId);
      if (order.status !== "已排期") throw new WorkshopError("只有已排期的令可以开工");
      order.status = "返工中";
      order.history.push(`${stamp()} 操作者开工补线`);
      this.save();
    }

    completeOrder(orderId) {
      const order = this.getOrder(orderId);
      if (!["已排期", "返工中"].includes(order.status)) {
        throw new WorkshopError("当前状态不能报完成");
      }
      order.status = "待复核";
      order.completedAt = new Date().toISOString();
      order.history.push(`${stamp()} 操作者报完成，等待另一人复核`);
      this.save();
    }

    reviewOrder(orderId, input) {
      const order = this.getOrder(orderId);
      if (order.status !== "待复核") throw new WorkshopError("只有待复核的令可以复核");
      if (input.reviewerId === order.operatorId) {
        throw new WorkshopError("复核人必须是操作者之外的另一人");
      }
      if (!this.state.operators.some(o => o.id === input.reviewerId)) {
        throw new WorkshopError("请选择复核人");
      }
      const pass = input.pass === true || input.result === "pass";
      order.release = {
        reviewerId: input.reviewerId,
        result: pass ? "pass" : "reject",
        comment: (input.comment || "").trim(),
        reviewedAt: new Date().toISOString(),
        invalidated: false
      };
      const work = this.getWork(order.workId);
      if (pass) {
        order.status = "已完结";
        order.history.push(`${stamp()} 复核通过并放行（复核人：${this.operatorName(input.reviewerId)}）`);
        work.logs.push(`${stamp()} 返工令 ${order.id} 复核通过`);
      } else {
        order.status = "返工中";
        order.completedAt = null;
        order.history.push(`${stamp()} 复核不通过，退回返工中：${order.release.comment || "（无备注）"}`);
        work.logs.push(`${stamp()} 返工令 ${order.id} 复核不通过，退回返工`);
      }
      this.save();
      return pass;
    }

    /*
     * 更正任一派工字段（责任工序 / 补线材料 / 操作者 / 承诺完成日）：
     * 旧排期与放行结论立即失效，旧令原样留档，并开出续次新令。
     */
    reviseOrder(orderId, patch) {
      // 任何未留档的令都可更正（含已放行件：放行结论同样需要失效并留档）
      const old = this.getOrder(orderId);
      if (!old || old.archived || old.status === "已作废") throw new WorkshopError("旧令已留档，不能再更正");
      this.assertDispatch(patch);

      const merged = {
        responsibleProcess: patch.responsibleProcess,
        operatorId: patch.operatorId,
        promisedDate: patch.promisedDate,
        materials: normalizeMaterials(patch.materials)
      };
      if (old.queue) {
        old.queue.invalidated = true;
        old.history.push(`${stamp()} 派工字段更正，原排期（${old.queue.targetDate}）结论失效`);
      }
      if (old.release) {
        old.release.invalidated = true;
        old.history.push(`${stamp()} 派工字段更正，原复核放行结论失效`);
      }
      const nextId = uid("RW");
      old.archived = true;
      old.status = "已作废";
      old.supersededBy = nextId;
      old.history.push(`${stamp()} 本令留档，续次令：${nextId}`);

      const ready = merged.materials.every(m => m.ready >= m.need);
      const next = {
        id: nextId,
        workId: old.workId,
        responsibleProcess: merged.responsibleProcess,
        materials: merged.materials,
        operatorId: merged.operatorId,
        promisedDate: merged.promisedDate,
        status: ready ? "待排期" : "待备料",
        revision: old.revision + 1,
        supersedes: old.id,
        supersededBy: null,
        archived: false,
        queue: null,
        release: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        history: [`${stamp()} 第 ${old.revision + 1} 次派工（更正自 ${old.id}），旧排期与放行结论已作废，${ready ? "材料备齐待排期" : "材料未齐暂缓排期"}`]
      };
      this.state.orders.push(next);
      const work = this.getWork(old.workId);
      work.activeOrderId = next.id;
      // 旧令即使已放行，更正后作品也回到待返工，凭新令重新排队放行
      work.status = "待返工";
      work.logs.push(`${stamp()} 返工令 ${old.id} 派工更正，旧令留档，续次令 ${nextId}`);
      this.save();
      return next;
    }

    operatorName(id) {
      const op = this.state.operators.find(o => o.id === id);
      return op ? op.name : "未指派";
    }
  }

  // ---------- 种子数据与旧版迁移 ----------
  function migrate(works) {
    const state = seedState();
    state.works = works.map(w => ({
      ...w,
      status: WORK_STATUSES.includes(w.status) ? w.status : "贴线中",
      activeOrderId: null
    }));
    state.orders = [];
    return state;
  }

  function seedState() {
    const t = todayStr();
    const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const works = [
      {
        id: "w-seed1", base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70,
        dryDate: t, gold: "未处理", defect: "", delivery: inDays(6), status: "待阴干",
        note: "边线需保持低浮雕感", activeOrderId: null, logs: ["创建作品"]
      },
      {
        id: "w-seed2", base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 80,
        dryDate: inDays(-3), gold: "试扫粉", defect: "左侧枝干翘线", delivery: inDays(2),
        status: "待返工", note: "客户要求金粉偏暗", activeOrderId: "RW-SEED1", logs: ["创建作品", "记录翘线", `${stamp()} 开具返工令 RW-SEED1`]
      },
      {
        id: "w-seed3", base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40,
        dryDate: inDays(1), gold: "未处理", defect: "", delivery: inDays(7), status: "贴线中",
        note: "", activeOrderId: null, logs: ["创建作品"]
      },
      {
        id: "w-seed4", base: "剔犀捧盒", theme: "缠枝牡丹", line: "粗线", progress: 90,
        dryDate: inDays(-2), gold: "试扫粉", defect: "盒盖回纹断线两处", delivery: inDays(3),
        status: "待返工", note: "", activeOrderId: "RW-SEED2", logs: ["创建作品", "记录断线", `${stamp()} 开具返工令 RW-SEED2`]
      },
      {
        id: "w-seed5", base: "脱胎梅瓶", theme: "龙凤呈祥", line: "细线", progress: 85,
        dryDate: inDays(-4), gold: "已上金粉", defect: "颈部龙鳞翘线", delivery: inDays(1),
        status: "待返工", note: "交付前必补", activeOrderId: "RW-SEED3",
        logs: ["创建作品", "记录翘线", `${stamp()} 返工令 RW-SEED0 派工更正，旧令留档，续次令 RW-SEED3`]
      }
    ];
    const operators = [
      { id: "op-chen", name: "陈师傅" },
      { id: "op-lin", name: "林师傅" },
      { id: "op-huang", name: "黄师傅" },
      { id: "op-wu", name: "吴师傅" }
    ];
    const orders = [
      {
        id: "RW-SEED0", workId: "w-seed5", responsibleProcess: "上金粉",
        materials: [{ id: "m-old", name: "金粉", unit: "克", need: 5, ready: 5 }],
        operatorId: "op-huang", promisedDate: inDays(1), status: "已作废", revision: 1,
        supersedes: null, supersededBy: "RW-SEED3", archived: true,
        queue: { targetDate: inDays(-1), reason: "客户加急", state: "scheduled", invalidated: true },
        release: null, completedAt: null, createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        history: ["旧令留档示例：责任工序填写错误后更正，原排期结论失效"]
      },
      {
        id: "RW-SEED1", workId: "w-seed2", responsibleProcess: "贴线",
        materials: [{ id: "m-s1", name: "漆线", unit: "米", need: 2, ready: 0 }],
        operatorId: "op-chen", promisedDate: inDays(4), status: "待备料", revision: 1,
        supersedes: null, supersededBy: null, archived: false, queue: null, release: null,
        completedAt: null, createdAt: new Date().toISOString(),
        history: ["开具返工令，补线材料未备齐，整令暂缓排期"]
      },
      {
        id: "RW-SEED2", workId: "w-seed4", responsibleProcess: "盘线塑形",
        materials: [
          { id: "m-s2a", name: "漆线", unit: "米", need: 1.5, ready: 1.5 },
          { id: "m-s2b", name: "夏布", unit: "块", need: 1, ready: 1 }
        ],
        operatorId: "op-lin", promisedDate: inDays(3), status: "待排期", revision: 1,
        supersedes: null, supersededBy: null, archived: false, queue: null, release: null,
        completedAt: null, createdAt: new Date().toISOString(),
        history: ["开具返工令，补线材料已备齐，进入待排期"]
      },
      {
        id: "RW-SEED3", workId: "w-seed5", responsibleProcess: "贴线",
        materials: [{ id: "m-s3", name: "漆线", unit: "米", need: 1, ready: 1 }],
        operatorId: "op-chen", promisedDate: inDays(1), status: "已排期", revision: 2,
        supersedes: "RW-SEED0", supersededBy: null, archived: false,
        queue: { targetDate: t, reason: "明日交付，今日必须完成补线", state: "scheduled", invalidated: false },
        release: null, completedAt: null, createdAt: new Date().toISOString(),
        history: ["第 2 次派工（更正自 RW-SEED0），材料备齐待排期", "判定排入今日，获得工位"]
      }
    ];
    return { works, orders, operators };
  }

  global.Workshop = {
    Store,
    WorkshopError,
    WORK_STATUSES,
    ORDER_STATUSES,
    RESPONSIBLE_PROCESSES,
    MATERIAL_HINTS,
    DAILY_CAPACITY,
    uid,
    todayStr
  };
})(window);
