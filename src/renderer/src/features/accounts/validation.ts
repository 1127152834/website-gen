import { z } from "zod";
export const accountSchema = z.object({ label: z.string().trim().min(1, "请输入账号名称"), token: z.string().trim().min(1, "请输入 API Token") });
