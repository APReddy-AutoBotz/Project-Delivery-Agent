import { z } from "zod";

export const roles = [
  "leadership",
  "project_manager",
  "portfolio_manager",
  "contributor",
  "pmo_admin",
  "system_admin",
] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;
export interface Actor {
  subject: string;
  roles: Role[];
  customerId: string;
}
