// 店铺的默认经营规则（方案 4.2.2）。写进政策页的承诺、运费设置、定价都从这里取，界面确认弹窗也列这些。
// 改这里会影响以后新建的所有站；已建好的站要在对话里让 pi 改。
import type { EntityForm } from "./forms.ts";

export const RULES = {
  freeShippingOver: 49,
  flatRate: 4.99,
  /** 配送范围：美国本土 48 州 + DC */
  region: "the contiguous United States (48 states and Washington, D.C.)",
  returnDays: 30,
  refundDays: [5, 7] as [number, number],
  /** 售价 = 成本 × 倍率，尾数 .99 */
  markup: 2.5,
};

/** 免邮以折后商品小计计算，包含恰好 $49；不把税费和运费计入门槛。 */
export const PAYMENT_WORDING = "Available payment methods are shown at checkout.";
export const CONTIGUOUS_STATES = "AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

/** 伴侣插件的短代码和政策提示词共用此处规则，不能让主题再声明另一套承诺。 */
export function companionRules(entity: Pick<EntityForm, "processingDays" | "transitDays">) {
  return {
    free_shipping_over: RULES.freeShippingOver,
    flat_rate: RULES.flatRate,
    return_days: RULES.returnDays,
    refund_days: RULES.refundDays,
    processing_days: entity.processingDays,
    transit_days: entity.transitDays,
    region: RULES.region,
  };
}

/** 由代码定价，AI 不参与：成本 × 2.5 取整再加 .99（毛利约 60%）。 */
export const retailPrice = (cost: number): number => Math.floor(cost * RULES.markup) + 0.99;

export const range = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`);

/** 对买家的关键承诺：提交前在确认弹窗里列出，生成的政策页也必须包含这些事实。 */
export function promises(entity: Pick<EntityForm, "processingDays" | "transitDays">): string[] {
  return [
    `处理时效 ${range(entity.processingDays)} 个工作日，运输时效 ${range(entity.transitDays)} 个工作日`,
    `满 $${RULES.freeShippingOver} 包邮，否则运费 $${RULES.flatRate}；只配送美国本土 48 州和 DC`,
    `收货 ${RULES.returnDays} 天内可退；质量问题由商家承担退货运费`,
    `收到退货后 ${range(RULES.refundDays)} 个工作日原路退款；不支持换货`,
  ];
}
