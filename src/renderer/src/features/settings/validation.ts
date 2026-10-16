import { z } from "zod";
export const providerSchema = z.object({
  id: z.number().optional(), originalProtocol: z.enum(["openai", "anthropic"]).optional(), originalBaseUrl: z.string().optional(), presetId: z.string(), name: z.string().trim().min(1, "请输入厂商名称"), protocol: z.enum(["openai", "anthropic"]), baseUrl: z.url("请输入有效的 Base URL"), apiKey: z.string(), hasKey: z.boolean(), keyHint: z.string().nullable(),
  models: z.array(z.object({ id: z.string().trim().min(1, "请输入模型 ID"), name: z.string(), vision: z.boolean(), thinkingLevels: z.array(z.string()), contextWindow: z.number().int().positive("上下文窗口必须大于 0"), maxOutputTokens: z.number().int().positive("最大输出必须大于 0"), price: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() }).optional() })),
});
export const cjKeySchema = z.object({ apiKey: z.string().trim().min(1, "请输入 CJ API Key") });
export const mailboxPasswordSchema = z.object({ password: z.string().min(8, "默认邮箱密码至少需要 8 位") });
