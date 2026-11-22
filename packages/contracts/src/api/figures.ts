// Educational TikZ figures (ADR 108).
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.ts";

export const FigureModeSchema = z.enum(["teaching", "research"]);
export type FigureMode = z.infer<typeof FigureModeSchema>;

export const FigureFamilySchema = z.enum([
  "geometry",
  "axes",
  "venn",
  "tree",
  "flowchart",
  "custom",
]);
export type FigureFamily = z.infer<typeof FigureFamilySchema>;

export const FigureSchema = z
  .object({
    id: IdSchema,
    conceptId: IdSchema.nullable(),
    family: FigureFamilySchema,
    mode: FigureModeSchema,
    title: z.string().nullable(),
    sourceTikz: z.string(),
    svgPath: z.string().nullable(),
    pdfPath: z.string().nullable(),
    libraries: z.array(z.string()),
    createdBy: z.enum(["agent", "hub", "llm"]),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Figure = z.infer<typeof FigureSchema>;

export const CompileTikzBodySchema = z
  .object({
    tikz: z.string().trim().min(1).max(8000),
    libraries: z.array(z.string().max(40)).max(12).default([]),
    mode: FigureModeSchema.default("teaching"),
  })
  .strict();
export type CompileTikzBody = z.infer<typeof CompileTikzBodySchema>;

export const CompileTikzResultSchema = z
  .object({
    ok: z.boolean(),
    log: z.string(),
    pdfPath: z.string().optional(),
    svgPath: z.string().optional(),
    timedOut: z.boolean().optional(),
  })
  .strict();
export type CompileTikzResult = z.infer<typeof CompileTikzResultSchema>;

export const SaveFigureBodySchema = z
  .object({
    tikz: z.string().trim().min(1).max(8000),
    conceptId: IdSchema.optional(),
    family: FigureFamilySchema.default("custom"),
    mode: FigureModeSchema.default("teaching"),
    title: z.string().trim().max(200).optional(),
    libraries: z.array(z.string().max(40)).max(12).default([]),
    createdBy: z.enum(["agent", "hub", "llm"]).default("agent"),
  })
  .strict();
export type SaveFigureBody = z.infer<typeof SaveFigureBodySchema>;

export const FigureTemplateSchema = z
  .object({
    id: z.string(),
    family: FigureFamilySchema,
    title: z.string(),
    description: z.string(),
    libraries: z.array(z.string()),
    tikz: z.string(),
  })
  .strict();
export type FigureTemplate = z.infer<typeof FigureTemplateSchema>;
