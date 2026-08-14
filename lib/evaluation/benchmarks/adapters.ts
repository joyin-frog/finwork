import {
  NormalizedBenchmarkCaseSchema,
  type BenchmarkAdapter,
  type BenchmarkAdapterContext,
  type BenchmarkCitation,
  type NormalizedBenchmarkCase,
} from "./contracts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstValue(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const candidate = atPath(value, path);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function stringValue(value: unknown, paths: string[], fallback = ""): string {
  const candidate = firstValue(value, paths);
  if (typeof candidate === "string") return candidate.trim();
  if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item === "number" || typeof item === "boolean") return [String(item)];
      return [];
    });
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [];
}

function identifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._:-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || fallback;
  return normalized.slice(0, 200);
}

function upstreamId(record: unknown, context: BenchmarkAdapterContext, suffix?: string): string {
  const raw = stringValue(record, ["id", "uid", "question_id", "financebench_id", "case_id", "task_id"], String(context.sourceRecordIndex));
  return identifier(suffix ? `${raw}-${suffix}` : raw, String(context.sourceRecordIndex));
}

function normalizedId(context: BenchmarkAdapterContext, caseId: string): string {
  return identifier(`${context.descriptor.id}:${context.datasetVersion}:${caseId}`, `${context.descriptor.id}:${context.sourceRecordIndex}`);
}

function numericAnswers(values: string[]): number[] {
  const results = new Set<number>();
  for (const value of values) {
    const normalized = value.replace(/[$,%\s]/g, "").replace(/\(([-+]?\d)/, "-$1").replace(/\)$/, "");
    const direct = Number(normalized);
    if (Number.isFinite(direct)) {
      results.add(value.includes("%") ? direct / 100 : direct);
      continue;
    }
    const matches = value.match(/[-+]?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
    for (const match of matches) {
      const numeric = Number(match.replace(/[,\s%]/g, ""));
      if (Number.isFinite(numeric)) results.add(match.includes("%") ? numeric / 100 : numeric);
    }
  }
  return [...results];
}

function tableFrom(value: unknown, id = "table") {
  const raw = isRecord(value) ? value.table : value;
  if (!Array.isArray(raw)) return [];
  const matrix = raw
    .filter(Array.isArray)
    .map((row) => (row as unknown[]).map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
  if (matrix.length === 0) return [];
  return [{ id: identifier(id, "table"), columns: matrix[0] ?? [], rows: matrix.slice(1) }];
}

function textBlocks(values: unknown[], prefix: string) {
  return values.flatMap((value, index) => {
    if (typeof value === "string" && value.trim()) {
      return [{ id: identifier(`${prefix}_${index}`, `${prefix}-${index}`), text: value }];
    }
    if (isRecord(value)) {
      const text = stringValue(value, ["text", "content", "paragraph", "evidence_text", "evidence_text_full_page"]);
      if (!text) return [];
      return [{
        id: identifier(
          stringValue(value, ["uid", "id", "source_id", "evidence_doc_name", "doc_name"], `${prefix}_${index}`),
          `${prefix}-${index}`,
        ),
        text,
        ...(stringValue(value, ["title"]) ? { title: stringValue(value, ["title"]) } : {}),
        ...(normalizePageLocator(firstValue(value, ["evidence_page_num", "page"]))
          ? { locator: normalizePageLocator(firstValue(value, ["evidence_page_num", "page"])) }
          : {}),
      }];
    }
    return [];
  });
}

function citationsFrom(value: unknown): BenchmarkCitation[] {
  if (isRecord(value)) {
    return Object.entries(value).map(([sourceId, quote]) => ({
      sourceId: identifier(sourceId, "source"),
      ...(typeof quote === "string" ? { quote } : {}),
    }));
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (typeof item === "string") return [{ sourceId: identifier(item, `source-${index}`) }];
    if (!isRecord(item)) return [];
    const sourceId = stringValue(item, ["source_id", "sourceId", "uid", "id", "evidence_doc_name", "doc_name"], `source-${index}`);
    const explicitLocator = stringValue(item, ["locator", "section"]);
    const pageLocator = normalizePageLocator(firstValue(item, ["page", "evidence_page_num"]));
    return [{
      sourceId: identifier(sourceId, `source-${index}`),
      ...(explicitLocator || pageLocator ? { locator: explicitLocator || pageLocator } : {}),
      ...(stringValue(item, ["quote", "text", "evidence", "evidence_text"]) ? { quote: stringValue(item, ["quote", "text", "evidence", "evidence_text"]) } : {}),
    }];
  });
}

function normalizePageLocator(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const page = Number(value);
  if (!Number.isInteger(page) || page < 0) return "";
  return page > 0 ? `page:${page}` : "node:page-0";
}

function finQaCitations(value: unknown, preTextCount: number): BenchmarkCitation[] {
  if (!isRecord(value)) return citationsFrom(value);
  return Object.entries(value).flatMap(([key, quote]) => {
    const table = /^table_(\d+)$/i.exec(key);
    if (table) {
      return [{
        sourceId: "table",
        locator: `node:table-row-${table[1]}`,
        ...(typeof quote === "string" ? { quote } : {}),
      }];
    }
    const text = /^text_(\d+)$/i.exec(key);
    if (text) {
      const ordinal = Number(text[1]);
      const sourceId = ordinal < preTextCount
        ? `pre_text_${ordinal}`
        : `post_text_${ordinal - preTextCount}`;
      return [{
        sourceId,
        locator: `node:${sourceId}`,
        ...(typeof quote === "string" ? { quote } : {}),
      }];
    }
    return citationsFrom({ [key]: quote });
  });
}

function tatQaCitations(
  question: Record<string, unknown>,
  paragraphs: unknown[],
  tableId: string,
): BenchmarkCitation[] {
  const citations: BenchmarkCitation[] = [];
  const mappings = firstValue(question, ["mappings"]);
  if (Array.isArray(mappings)) {
    for (const mapping of mappings) {
      if (!isRecord(mapping)) continue;
      const table = mapping.table;
      if (Array.isArray(table) && Number.isInteger(Number(table[0]))) {
        citations.push({ sourceId: tableId, locator: `node:${tableId}-row-${Number(table[0])}` });
      }
    }
  }
  const paragraphByOrder = new Map(paragraphs.flatMap((paragraph) => {
    if (!isRecord(paragraph)) return [];
    const order = String(paragraph.order ?? "").trim();
    const uid = stringValue(paragraph, ["uid", "id"]);
    return order && uid ? [[order, uid] as const] : [];
  }));
  for (const order of stringArray(firstValue(question, ["rel_paragraphs"]))) {
    const sourceId = paragraphByOrder.get(order);
    if (sourceId) citations.push({ sourceId, locator: `node:${sourceId}` });
  }
  return [...new Map(citations.map((citation) => [
    `${citation.sourceId}\u0000${citation.locator ?? ""}`,
    citation,
  ])).values()];
}

function buildCase(
  context: BenchmarkAdapterContext,
  input: Omit<NormalizedBenchmarkCase, "schemaVersion" | "datasetId" | "datasetVersion" | "split" | "locale" | "capabilities" | "provenance"> & {
    locale?: string;
    capabilities?: NormalizedBenchmarkCase["capabilities"];
  },
): NormalizedBenchmarkCase {
  return NormalizedBenchmarkCaseSchema.parse({
    schemaVersion: 1,
    datasetId: context.descriptor.id,
    datasetVersion: context.datasetVersion,
    split: context.split,
    locale: input.locale ?? context.descriptor.defaultLocale,
    capabilities: input.capabilities ?? context.descriptor.capabilities,
    provenance: {
      sourceSha256: context.sourceSha256,
      sourceRecordIndex: context.sourceRecordIndex,
      homepage: context.descriptor.homepage,
      upstreamRef: context.descriptor.upstreamRef,
      licenseStatus: context.descriptor.license.status,
    },
    ...input,
  });
}

export const FinQaAdapter: BenchmarkAdapter = {
  format: "finqa",
  adapt(record, context) {
    const qa = asRecord(firstValue(record, ["qa"]));
    const caseId = upstreamId(record, context);
    const prompt = stringValue(qa, ["question"], stringValue(record, ["question"]));
    const answers = stringArray(firstValue(qa, ["answer"]) ?? firstValue(record, ["answer"]));
    const pre = Array.isArray(firstValue(record, ["pre_text"])) ? (firstValue(record, ["pre_text"]) as unknown[]) : [];
    const post = Array.isArray(firstValue(record, ["post_text"])) ? (firstValue(record, ["post_text"]) as unknown[]) : [];
    return [buildCase(context, {
      id: normalizedId(context, caseId),
      upstreamCaseId: caseId,
      taskKind: context.descriptor.taskKind,
      prompt,
      context: {
        textBlocks: [...textBlocks(pre, "pre_text"), ...textBlocks(post, "post_text")],
        tables: tableFrom(firstValue(record, ["table"])),
        conversation: [],
        files: [],
      },
      expected: {
        answers,
        numericAnswers: numericAnswers(answers),
        programs: stringArray(firstValue(qa, ["program"]) ?? firstValue(record, ["program"])),
        citations: finQaCitations(firstValue(qa, ["gold_inds", "goldInds"]), pre.length),
        assertions: [],
        deterministicChecks: [],
      },
      tags: ["public", "financial-reasoning", "table"],
    })];
  },
};

export const TatQaAdapter: BenchmarkAdapter = {
  format: "tatqa",
  adapt(record, context) {
    const questions = firstValue(record, ["questions"]);
    const questionList = Array.isArray(questions) ? questions : [asRecord(record)];
    const paragraphs = Array.isArray(firstValue(record, ["paragraphs"])) ? (firstValue(record, ["paragraphs"]) as unknown[]) : [];
    const tableId = stringValue(asRecord(firstValue(record, ["table"])), ["uid", "id"], "table");
    const tables = tableFrom(firstValue(record, ["table"]), tableId);
    return questionList.map((question, index) => {
      const q = asRecord(question);
      const caseId = upstreamId(record, context, stringValue(q, ["uid", "id"], String(index)));
      const answers = stringArray(firstValue(q, ["answer", "answers"]));
      return buildCase(context, {
        id: normalizedId(context, caseId),
        upstreamCaseId: caseId,
        taskKind: context.descriptor.taskKind,
        prompt: stringValue(q, ["question", "prompt"]),
        context: { textBlocks: textBlocks(paragraphs, "paragraph"), tables, conversation: [], files: [] },
        expected: {
          answers,
          numericAnswers: numericAnswers(answers),
          programs: stringArray(firstValue(q, ["derivation", "program"])),
          citations: tatQaCitations(q, paragraphs, tableId),
          assertions: [],
          deterministicChecks: [],
        },
        tags: ["public", "financial-reasoning", stringValue(q, ["answer_type"], "qa")],
      });
    });
  },
};

export const ConvFinQaAdapter: BenchmarkAdapter = {
  format: "convfinqa",
  adapt(record, context) {
    const qa = asRecord(firstValue(record, ["qa", "dialogue"]));
    const questions = stringArray(firstValue(qa, ["question", "questions"]));
    const answers = stringArray(firstValue(qa, ["answer", "answers"]));
    const programs = stringArray(firstValue(qa, ["program", "programs"]));
    const pre = Array.isArray(firstValue(record, ["pre_text"])) ? (firstValue(record, ["pre_text"]) as unknown[]) : [];
    const post = Array.isArray(firstValue(record, ["post_text"])) ? (firstValue(record, ["post_text"]) as unknown[]) : [];
    const count = Math.max(questions.length, answers.length);
    return Array.from({ length: count }, (_, index) => {
      const caseId = upstreamId(record, context, `turn-${index + 1}`);
      const conversation = questions.slice(0, index).flatMap((question, previous) => [
        { role: "user" as const, text: question },
        ...(answers[previous] ? [{ role: "assistant" as const, text: answers[previous] }] : []),
      ]);
      const expectedAnswers = answers[index] ? [answers[index]] : [];
      return buildCase(context, {
        id: normalizedId(context, caseId),
        upstreamCaseId: caseId,
        taskKind: context.descriptor.taskKind,
        prompt: questions[index] ?? questions.at(-1) ?? "Continue the financial reasoning conversation.",
        context: {
          textBlocks: [...textBlocks(pre, "pre_text"), ...textBlocks(post, "post_text")],
          tables: tableFrom(firstValue(record, ["table"])),
          conversation,
          files: [],
        },
        expected: {
          answers: expectedAnswers,
          numericAnswers: numericAnswers(expectedAnswers),
          programs: programs[index] ? [programs[index]] : [],
          citations: [],
          assertions: [],
          deterministicChecks: [],
        },
        tags: ["public", "multi-turn", "financial-reasoning"],
      });
    });
  },
};

function evidenceBlocks(record: unknown) {
  const evidence = firstValue(record, ["evidence", "contexts", "documents", "passages"]);
  if (Array.isArray(evidence)) return textBlocks(evidence, "evidence");
  if (typeof evidence === "string") return textBlocks([evidence], "evidence");
  return [];
}

function ragCase(record: unknown, context: BenchmarkAdapterContext): NormalizedBenchmarkCase {
  const caseId = upstreamId(record, context);
  const answers = stringArray(firstValue(record, ["answer", "answers", "gold_answer", "expected_answer"]));
  const rawEvidence = firstValue(record, ["evidence", "contexts", "documents", "passages"]);
  const evidence = evidenceBlocks(record);
  const explicitCitations = citationsFrom(firstValue(record, ["citations", "gold_citations", "evidence_ids"]));
  const evidenceCitations = citationsFrom(rawEvidence);
  const citations = explicitCitations.length > 0
    ? explicitCitations
    : evidenceCitations.length > 0
      ? evidenceCitations
      : evidence.map((item) => ({ sourceId: item.id, quote: item.text }));
  return buildCase(context, {
    id: normalizedId(context, caseId),
    upstreamCaseId: caseId,
    taskKind: context.descriptor.taskKind,
    prompt: stringValue(record, ["question", "prompt", "query"]),
    context: { textBlocks: evidence, tables: tableFrom(firstValue(record, ["table"])), conversation: [], files: [] },
    expected: { answers, numericAnswers: numericAnswers(answers), programs: [], citations, assertions: [], deterministicChecks: [] },
    tags: ["public", "retrieval", "citation"],
  });
}

export const FinanceBenchAdapter: BenchmarkAdapter = {
  format: "financebench",
  adapt(record, context) {
    return [ragCase(record, context)];
  },
};

export const FinderAdapter: BenchmarkAdapter = {
  format: "finder",
  adapt(record, context) {
    return [ragCase(record, context)];
  },
};

export const GenericQaAdapter: BenchmarkAdapter = {
  format: "generic_qa",
  adapt(record, context) {
    const caseId = upstreamId(record, context);
    const options = firstValue(record, ["options", "choices"]);
    const optionText = Array.isArray(options)
      ? options.map((option, index) => `${String.fromCharCode(65 + index)}. ${typeof option === "string" ? option : stringValue(option, ["text", "label"])}`).join("\n")
      : "";
    const basePrompt = stringValue(record, ["question", "prompt", "query", "instruction"]);
    const answers = stringArray(firstValue(record, ["answer", "answers", "label", "target", "expected_answer"]));
    return [buildCase(context, {
      id: normalizedId(context, caseId),
      upstreamCaseId: caseId,
      taskKind: context.descriptor.taskKind,
      prompt: optionText ? `${basePrompt}\n${optionText}` : basePrompt,
      context: { textBlocks: evidenceBlocks(record), tables: tableFrom(firstValue(record, ["table"])), conversation: [], files: [] },
      expected: { answers, numericAnswers: numericAnswers(answers), programs: [], citations: citationsFrom(firstValue(record, ["citations"])), assertions: [], deterministicChecks: [] },
      tags: ["public", "financial-knowledge", ...(optionText ? ["multiple-choice"] : [])],
    })];
  },
};

export const SpreadsheetBenchAdapter: BenchmarkAdapter = {
  format: "spreadsheetbench",
  adapt(record, context) {
    const caseId = upstreamId(record, context);
    const inputNames = stringArray(firstValue(record, [
      "input_files",
      "input_file",
      "files",
      "workbook",
      "spreadsheet_path",
    ]));
    const explicitOutputPath = stringValue(record, [
      "output_file",
      "output_name",
      "expected_file",
    ]);
    // The golden workbook path is private Oracle material, not the requested
    // deliverable name. SpreadsheetBench v2 tasks conventionally produce a
    // completed copy of the input workbook.
    const logicalName = explicitOutputPath
      ? explicitOutputPath.split(/[\\/]/).at(-1) || `${caseId}_completed.xlsx`
      : `${caseId}_completed.xlsx`;
    const assertions = stringArray(firstValue(record, ["assertions", "checks", "expected", "validation"]));
    const goldenUpstreamUri = stringValue(record, ["golden_response_path"]);
    const answerRange = stringValue(record, ["answer_position"]);
    return [buildCase(context, {
      id: normalizedId(context, caseId),
      upstreamCaseId: caseId,
      taskKind: "spreadsheet",
      prompt: stringValue(record, ["instruction", "prompt", "question", "task"]),
      context: {
        textBlocks: [],
        tables: [],
        conversation: [],
        files: inputNames.map((name) => ({ logicalName: name.split("/").at(-1) || name, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upstreamUri: name })),
      },
      expected: {
        answers: [],
        numericAnswers: [],
        programs: [],
        citations: [],
        assertions: assertions.length > 0 ? assertions : ["output workbook passes the dataset validator"],
        deterministicChecks: [],
        artifact: {
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          logicalName,
          // This is the production deliverable validator that opens, recalculates,
          // scans formula errors and re-hashes the immutable XLSX candidate.
          validatorIds: [
            "xlsx_generic",
            ...(goldenUpstreamUri && answerRange ? ["spreadsheetbench_v2_cells"] : []),
          ],
          ...(goldenUpstreamUri && answerRange ? {
            oracle: { goldenUpstreamUri, answerRange },
          } : {}),
        },
      },
      tags: ["public", "spreadsheet", "artifact-required"],
    })];
  },
};

export const AgentBenchAdapter: BenchmarkAdapter = {
  format: "agentbench",
  adapt(record, context) {
    const caseId = upstreamId(record, context);
    const answers = stringArray(firstValue(record, ["expected_answer", "answer", "answers", "target"]));
    const assertions = stringArray(firstValue(record, ["assertions", "checks", "success_criteria", "expected_trace"]));
    return [buildCase(context, {
      id: normalizedId(context, caseId),
      upstreamCaseId: caseId,
      taskKind: "agent",
      prompt: stringValue(record, ["task", "instruction", "prompt", "question"]),
      context: { textBlocks: evidenceBlocks(record), tables: tableFrom(firstValue(record, ["table"])), conversation: [], files: [] },
      expected: {
        answers,
        numericAnswers: numericAnswers(answers),
        programs: stringArray(firstValue(record, ["program", "programs"])),
        citations: citationsFrom(firstValue(record, ["citations"])),
        assertions: assertions.length > 0 ? assertions : ["agent satisfies the task contract"],
        deterministicChecks: [],
      },
      tags: ["public", "financial-agent", "tool-use"],
    })];
  },
};

export const GeneralAgentPilotAdapter: BenchmarkAdapter = {
  format: "general_agent_pilot",
  adapt(record, context) {
    const caseId = upstreamId(record, context);
    const checkIds = stringArray(firstValue(record, ["deterministic_checks"]));
    const faultDomain = stringValue(record, ["fault_domain"], "capability");
    const capabilities = stringArray(firstValue(record, ["capabilities"]));
    const tags = stringArray(firstValue(record, ["tags"]));
    const documents = textBlocks(
      Array.isArray(firstValue(record, ["documents"])) ? firstValue(record, ["documents"]) as unknown[] : [],
      "document",
    );
    const conversation = Array.isArray(firstValue(record, ["conversation"]))
      ? (firstValue(record, ["conversation"]) as unknown[]).flatMap((turn) => {
          if (!isRecord(turn)) return [];
          const role = stringValue(turn, ["role"]);
          const text = stringValue(turn, ["text", "content"]);
          return (role === "user" || role === "assistant") && text
            ? [{ role: role as "user" | "assistant", text }]
            : [];
        })
      : [];
    const expectedAnswers = stringArray(firstValue(record, ["expected_answers", "expected_answer"]));
    const assertions = stringArray(firstValue(record, ["business_assertions", "assertions"]));
    const fileRecords = Array.isArray(firstValue(record, ["files"]))
      ? firstValue(record, ["files"]) as unknown[]
      : [];
    const files = fileRecords.flatMap((file) => {
      if (!isRecord(file)) return [];
      const logicalName = stringValue(file, ["logical_name", "logicalName"]);
      const mediaType = stringValue(file, ["media_type", "mediaType"]);
      const upstreamUri = stringValue(file, ["upstream_uri", "upstreamUri"]);
      return logicalName && mediaType && upstreamUri ? [{ logicalName, mediaType, upstreamUri }] : [];
    });
    const artifactRecord = firstValue(record, ["artifact"]);
    const artifact = isRecord(artifactRecord)
      ? {
          mediaType: stringValue(artifactRecord, ["media_type", "mediaType"]),
          logicalName: stringValue(artifactRecord, ["logical_name", "logicalName"]),
          validatorIds: stringArray(firstValue(artifactRecord, ["validator_ids", "validatorIds"])),
        }
      : undefined;
    const expectedArtifact = artifact?.mediaType && artifact.logicalName && artifact.validatorIds.length > 0
      ? artifact
      : undefined;
    const expectsCitations = capabilities.includes("citation");
    return [buildCase(context, {
      id: normalizedId(context, caseId),
      upstreamCaseId: caseId,
      taskKind: "agent",
      prompt: stringValue(record, ["prompt", "task", "instruction"]),
      context: {
        textBlocks: documents,
        tables: [],
        conversation,
        files,
      },
      expected: {
        answers: expectedAnswers,
        numericAnswers: numericAnswers(expectedAnswers),
        programs: [],
        citations: expectsCitations
          ? documents.map((document) => ({
              sourceId: document.id,
              locator: document.locator ?? `node:${document.id}`,
            }))
          : [],
        assertions,
        deterministicChecks: checkIds.map((id) => ({
          id: identifier(id, "pilot-check"),
          faultDomain: ["model", "capability", "dependency", "validator", "policy", "resource", "evaluator"].includes(faultDomain)
            ? faultDomain as "model" | "capability" | "dependency" | "validator" | "policy" | "resource" | "evaluator"
            : "capability",
        })),
        ...(expectedArtifact ? { artifact: expectedArtifact } : {}),
      },
      capabilities: capabilities.length > 0
        ? capabilities as NormalizedBenchmarkCase["capabilities"]
        : context.descriptor.capabilities,
      tags: [
        "bundled",
        context.descriptor.id === "general_agent_pilot" ? "general-agent-pilot" : "finance-agent-professional",
        ...tags,
      ],
    })];
  },
};

export const BUILT_IN_BENCHMARK_ADAPTERS: readonly BenchmarkAdapter[] = Object.freeze([
  FinQaAdapter,
  TatQaAdapter,
  ConvFinQaAdapter,
  FinanceBenchAdapter,
  FinderAdapter,
  GenericQaAdapter,
  SpreadsheetBenchAdapter,
  AgentBenchAdapter,
  GeneralAgentPilotAdapter,
]);
