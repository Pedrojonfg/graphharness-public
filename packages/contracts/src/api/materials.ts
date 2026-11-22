// Subject materials (REST parity with MCP import_class_notes / import_material).
import { z } from "zod";
import { IdSchema } from "./common.ts";

/** Result per file imported into LH (reduced). */
export const ImportFileResultSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  outcome: z.string(),
  error: z.string().nullable(),
  code: z.string().nullable(),
  notice: z.string().nullable(),
});
export type ImportFileResult = z.infer<typeof ImportFileResultSchema>;

export const MaterialFileSchema = z.object({
  /** Path relative to MATERIALS_DIR (identity in LH). */
  relative: z.string().min(1),
  /** File name. */
  name: z.string().min(1),
});
export type MaterialFile = z.infer<typeof MaterialFileSchema>;

export const MaterialsListSchema = z.object({ files: z.array(MaterialFileSchema) });
export type MaterialsList = z.infer<typeof MaterialsListSchema>;

export const ImportClassNotesBodySchema = z.object({
  subjectId: IdSchema,
  title: z.string().trim().min(1).max(200),
  markdown: z.string().min(1).max(200_000),
});
export type ImportClassNotesBody = z.infer<typeof ImportClassNotesBodySchema>;

export const ImportClassNotesResponseSchema = z.object({
  path: z.string(),
  result: ImportFileResultSchema,
});
export type ImportClassNotesResponse = z.infer<typeof ImportClassNotesResponseSchema>;

/** Absolute (MCP) or relative to MATERIALS_DIR (PWA); no `..`. */
export const ImportMaterialPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.split(/[/\\]/).includes(".."), "no '..' segments");

export const ImportMaterialBodySchema = z.object({
  subjectId: IdSchema,
  paths: z.array(ImportMaterialPathSchema).min(1).max(20),
});
export type ImportMaterialBody = z.infer<typeof ImportMaterialBodySchema>;

export const ImportMaterialResponseSchema = z.object({ results: z.array(ImportFileResultSchema) });
export type ImportMaterialResponse = z.infer<typeof ImportMaterialResponseSchema>;
