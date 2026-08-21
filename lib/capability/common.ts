import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const IdentifierSchema = z.string().trim().min(1).max(200);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "must be a sha256 hex digest");

export const PrincipalRefSchema = z
  .object({
    id: IdentifierSchema,
    type: z.enum(["user", "agent", "service"]),
    tenantId: IdentifierSchema.optional(),
  })
  .strict();
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;

export const EntityRefSchema = z
  .object({
    id: IdentifierSchema,
    type: IdentifierSchema,
    name: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const PeriodRefSchema = z
  .object({
    start: z.iso.date(),
    end: z.iso.date(),
    label: z.string().trim().min(1).max(200).optional(),
    calendar: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((period) => period.start <= period.end, {
    message: "period.start must be before or equal to period.end",
    path: ["end"],
  });
export type PeriodRef = z.infer<typeof PeriodRefSchema>;

export const CurrencyRefSchema = z
  .object({
    code: z.string().regex(/^[A-Z]{3}$/, "currency code must be ISO-4217 style"),
    scale: z.number().int().min(0).max(12).default(2),
  })
  .strict();
export type CurrencyRef = z.infer<typeof CurrencyRefSchema>;

export const UnitRefSchema = z
  .object({
    code: IdentifierSchema,
    label: z.string().trim().min(1).max(100).optional(),
    factor: z.number().positive().finite().default(1),
  })
  .strict();
export type UnitRef = z.infer<typeof UnitRefSchema>;

export const VersionedProducerSchema = z
  .object({
    capabilityId: IdentifierSchema,
    version: IdentifierSchema,
    attemptId: IdentifierSchema,
  })
  .strict();
export type VersionedProducer = z.infer<typeof VersionedProducerSchema>;
