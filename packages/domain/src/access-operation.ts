export type AccessOperation = {
  id: string;
  event: "access.granted" | "access.revoked";
  actor: string;
  occurredAt: Date;
};
