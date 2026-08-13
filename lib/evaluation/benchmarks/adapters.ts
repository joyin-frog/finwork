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
      const text = stringValue(value, ["text", "content", "paragraph"]);
      if (!text) return [];
      return [{
        id: identifier(stringValue(value, ["uid", "id"], `${prefix}_${index}`), `${prefix}-${index}`),
        text,
        ...(stringValue(value, ["title"]) ? { title: stringValue(value, ["title"]) } : {}),
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
    const sourceId = stringValue(item, ["source_id", "sourceId", "uid", "id", "doc_name"], `source-${index}`);
    return [{
      sourceId: identifier(sourceId, `source-${index}`),
      ...(stringValue(item, ["locator", "page", "section"]) ? { locator: stringValue(item, ["locator", "page", "section"]) } : {}),
      ...(stringValue(item, ["quote", "text", "evidence"]) ? { quote: stringValue(item, ["quote", "text", "evidence"]) } : {}),
    }];
  });
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
        citations: citationsFrom(firstValue(qa, ["gold_inds", "goldInds"])),
        assertions: [],
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
    const tables = tableFrom(firstValue(record, ["table"]), stringValue(record, ["table.uid"], "table"));
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
          citations: citationsFrom(firstValue(q, ["rel_paragraphs", "evidence", "citations"])),
          assertions: [],
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
  const evidence = evidenceBlocks(record);
  const explicitCitations = citationsFrom(firstValue(record, ["citations", "gold_citations", "evidence_ids"]));
  const citations = explicitCitations.length > 0
    ? explicitCitations
    : evidence.map((item) => ({ sourceId: item.id, quote: item.text }));
  return buildCase(context, {
    id: normalizedId(context, caseId),
    upstreamCaseId: caseId,
    taskKind: context.descriptor.taskKind,
    prompt: stringValue(record, ["question", "prompt", "query"]),
    context: { textBlocks: evidence, tables: tableFrom(firstValue(record, ["table"])), conversation: [], files: [] },
    expected: { answers, numericAnswers: numericAnswers(answers), programs: [], citations, assertions: [] },
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
      expected: { answers, numericAnswers: numericAnswers(answers), programs: [], citations: citationsFrom(firstValue(record, ["citations"])), assertions: [] },
      tags: ["public", "financial-knowledge", ...(optionText ? ["multiple-choice"] : [])],
    })];
  },
};

export const SpreadsheetBenchAdapter: BenchmarkAdapter = {
  format: "spreadsheetbench",
  adapt(record, context) {
    const caseId = upstreamId(record, context);
    const inputNames = stringArray(firstValue(record, ["input_files", "input_file", "files", "workbook"]));
    const logicalName = stringValue(record, ["output_file", "output_name", "expected_file"], `${caseId}-output.xlsx`);
    const assertions = stringArray(firstValue(record, ["assertions", "checks", "expected", "validation"]));
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
        artifact: {
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          logicalName,
          validatorIds: ["benchmark.spreadsheet.deterministic"],
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
      },
      tags: ["public", "financial-agent", "tool-use"],
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
]);
