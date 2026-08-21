# Knowledge retrieval evaluation

This local evaluation measures the retriever independently from the chat model.
It reports Recall@K, MRR, NDCG@K, expected-quote recall, no-answer accuracy, and
latency. Cases point to stable `knowledge_documents.id` values; the runner
resolves the current immutable Retrieval v2 artifact version before searching.

Create a JSONL file from reviewed finance questions:

```json
{"id":"travel-limit-paraphrase","query":"出差住酒店最多能报多少钱？","shouldFind":true,"relevantKnowledgeDocumentIds":[12],"expectedQuotes":["住宿费每晚不超过500元"],"topK":5}
{"id":"unsupported-policy","query":"公司是否允许使用加密货币支付工资？","shouldFind":false,"relevantKnowledgeDocumentIds":[],"expectedQuotes":[],"topK":5}
```

Then run:

```bash
pnpm eval:knowledge-retrieval -- --cases /absolute/path/cases.jsonl --out .finwork-test/knowledge-retrieval/report.json
```

Positive cases pass only when every relevant document and every expected quote
is present in the top-K citations. No-answer cases require zero hits and verify
the conservative evidence gate: when no BM25 term matches, retrieval returns no
citation rather than passing an unrelated document to the answer model.
