// 假绿灯防护(2026-07-08)：本文件曾用 `void (async…)()` 火忘式 IIFE——任一 testPromise
// 拒绝只变成 unhandledRejection，node:test 的 TAP 计数照报 fail 0、进程退出 0（T1a2
// 断言真实失败却全绿实锤过）。现在：拒绝必须落到 .catch 置非零退出码；再挂
// unhandledRejection 兜底，防止未来有人把某个 await 漏出主链。
process.on("unhandledRejection", (err) => {
  console.error("[all.test] unhandledRejection:", err);
  process.exitCode = 1;
});

(async () => {
  const { smokeTestPromise } = await import("./smoke.test.ts");
  await smokeTestPromise;

  const { knowledgeStorageTestPromise } = await import("./knowledge-storage.test.ts");
  await knowledgeStorageTestPromise;

  const { observabilityTestPromise } = await import("./observability.test.ts");
  await observabilityTestPromise;

  const { usageQuotaTestPromise } = await import("./usage-quota.test.ts");
  await usageQuotaTestPromise;

  const { usageStoreTestPromise } = await import("./usage-store.test.ts");
  await usageStoreTestPromise;

  const { userIdentitySettingsTestPromise } = await import("./user-identity-settings.test.ts");
  await userIdentitySettingsTestPromise;

  const { appVersionTestPromise } = await import("./app-version.test.ts");
  await appVersionTestPromise;

  const { skillTokenTestPromise } = await import("./skill-token.test.ts");
  await skillTokenTestPromise;

  const { designComplianceTestPromise } = await import("./design-compliance.test.ts");
  await designComplianceTestPromise;

  await import("./feature-flags.test.ts");
  await import("./chat-features.test.ts");
  await import("./code-language.test.ts");
  await import("./chat-panel-state.test.ts");
  await import("./chat-preview-selection.test.ts");
  await import("./composer-tips.test.ts");
  await import("./file-preview.test.ts");

  const { excelPreviewEnhanceTestPromise } = await import("./excel-preview-enhance.test.ts");
  await excelPreviewEnhanceTestPromise;

  const { spreadsheetRowmapTestPromise } = await import("./spreadsheet-rowmap.test.ts");
  await spreadsheetRowmapTestPromise;

  const { pdfPagemapTestPromise } = await import("./pdf-pagemap.test.ts");
  await pdfPagemapTestPromise;

  const { xlsxSanitizeTestPromise } = await import("./xlsx-sanitize.test.ts");
  await xlsxSanitizeTestPromise;

  const { provenanceTestPromise } = await import("./provenance.test.ts");
  await provenanceTestPromise;

  const { payrollScriptTestPromise } = await import("./payroll-script.test.ts");
  await payrollScriptTestPromise;

  const { reimbursementScriptTestPromise } = await import("./reimbursement-script.test.ts");
  await reimbursementScriptTestPromise;

  const { reconciliationScriptTestPromise } = await import("./reconciliation-script.test.ts");
  await reconciliationScriptTestPromise;

  const { taxCalcScriptTestPromise } = await import("./tax-calc-script.test.ts");
  await taxCalcScriptTestPromise;

  const { kingdeeTestPromise } = await import("./kingdee.test.ts");
  await kingdeeTestPromise;

  const { taxRatesTestPromise } = await import("./tax-rates.test.ts");
  await taxRatesTestPromise;

  const { payrollStoreTestPromise } = await import("./payroll-store.test.ts");
  await payrollStoreTestPromise;

  const { reimbursementLedgerTestPromise } = await import("./reimbursement-ledger.test.ts");
  await reimbursementLedgerTestPromise;

  const { expensePolicyConfigTestPromise } = await import("./expense-policy-config.test.ts");
  await expensePolicyConfigTestPromise;

  const { reconciliationTestPromise } = await import("./reconciliation.test.ts");
  await reconciliationTestPromise;

  const { ciWorkflowTestPromise } = await import("./ci-workflow.test.ts");
  await ciWorkflowTestPromise;

  const { tauriUpdaterConfigTestPromise } = await import("./tauri-updater-config.test.ts");
  await tauriUpdaterConfigTestPromise;

  const { excelRoundtripTestPromise } = await import("./excel-roundtrip.test.ts");
  await excelRoundtripTestPromise;

  const { pythonEnvTestPromise } = await import("./python-env.test.ts");
  await pythonEnvTestPromise;

  const { pythonWorkerTestPromise } = await import("./python-worker.test.ts");
  await pythonWorkerTestPromise;

  const { knowledgeSearchTitleTestPromise } = await import("./knowledge-search-title.test.ts");
  await knowledgeSearchTitleTestPromise;

  const { sandboxCommandsTestPromise } = await import("./sandbox-commands.test.ts");
  await sandboxCommandsTestPromise;

  const { pythonInstallerTestPromise } = await import("./python-installer.test.ts");
  await pythonInstallerTestPromise;

  const { taxCalendarTestPromise } = await import("./tax-calendar.test.ts");
  await taxCalendarTestPromise;

  const { toolRegistryTestPromise } = await import("./tool-registry.test.ts");
  await toolRegistryTestPromise;

  const { goldenToolNamesTestPromise } = await import("./golden-tool-names.test.ts");
  await goldenToolNamesTestPromise;

  const { dbHardeningTestPromise } = await import("./db-hardening.test.ts");
  await dbHardeningTestPromise;

  const { cockpitTodayCountsTestPromise } = await import("./cockpit-today-counts.test.ts");
  await cockpitTodayCountsTestPromise;

  const { cockpitTodosTestPromise } = await import("./cockpit-todos.test.ts");
  await cockpitTodosTestPromise;

  const { financeSummaryTestPromise } = await import("./finance-summary.test.ts");
  await financeSummaryTestPromise;

  const { payrollToolTestPromise } = await import("./payroll-tool.test.ts");
  await payrollToolTestPromise;

  const { observabilityMetricsTestPromise, observabilityQueryFunctionsTestPromise } = await import("./observability-metrics.test.ts");
  await observabilityMetricsTestPromise;
  await observabilityQueryFunctionsTestPromise;

  const { cockpitPageTestPromise } = await import("./cockpit-page.test.ts");
  await cockpitPageTestPromise;

  const { knowledgeQueryTestPromise } = await import("./knowledge-query.test.ts");
  await knowledgeQueryTestPromise;

  const { knowledgeToolWrapTestPromise } = await import("./knowledge-tool-wrap.test.ts");
  await knowledgeToolWrapTestPromise;

  const { knowledgeLifecycleTestPromise } = await import("./knowledge-lifecycle.test.ts");
  await knowledgeLifecycleTestPromise;

  const { knowledgeUiTestPromise } = await import("./knowledge-ui.test.ts");
  await knowledgeUiTestPromise;

  const { agentConfirmFlowTestPromise } = await import("./agent-confirm-flow.test.ts");
  await agentConfirmFlowTestPromise;

  const { agentEventStreamTestPromise } = await import("./agent-event-stream.test.ts");
  await agentEventStreamTestPromise;

  const { generatedFilesTestPromise } = await import("./generated-files.test.ts");
  await generatedFilesTestPromise;

  const { chatStreamStoreTestPromise } = await import("./chat-stream-store.test.ts");
  await chatStreamStoreTestPromise;

  const { stripFileLinksTestPromise } = await import("./strip-file-links.test.ts");
  await stripFileLinksTestPromise;

  const { systemPromptFileRefTestPromise } = await import("./system-prompt-file-ref.test.ts");
  await systemPromptFileRefTestPromise;

  const { sandboxFileLinkTestPromise } = await import("./sandbox-file-link.test.ts");
  await sandboxFileLinkTestPromise;

  const { pythonPathEnvTestPromise } = await import("./python-path-env.test.ts");
  await pythonPathEnvTestPromise;

  const { normalizeFileLinksTestPromise } = await import("./normalize-file-links.test.ts");
  await normalizeFileLinksTestPromise;

  const { serverLogTestPromise } = await import("./server-log.test.ts");
  await serverLogTestPromise;

  const { loggerTestPromise } = await import("./logger.test.ts");
  await loggerTestPromise;

  await import("./tool-renderers.test.ts");

  const { payrollCardTestPromise } = await import("./payroll-card.test.ts");
  await payrollCardTestPromise;

  const { numericCheckTestPromise } = await import("./numeric-check.test.ts");
  await numericCheckTestPromise;

  const { financialRatiosTestPromise } = await import("./financial-ratios.test.ts");
  await financialRatiosTestPromise;

  const { conversationTitleTestPromise } = await import("./conversation-title.test.ts");
  await conversationTitleTestPromise;

  const { persistHygieneTestPromise } = await import("./persist-hygiene.test.ts");
  await persistHygieneTestPromise;

  const { agentAbortRetryTestPromise } = await import("./agent-abort-retry.test.ts");
  await agentAbortRetryTestPromise;

  await import("./chat-quick-prompts.test.ts");

  await import("./router-direct.test.ts");

  const { agentPipelineTestPromise } = await import("./agent-pipeline.test.ts");
  await agentPipelineTestPromise;

  await import("./hooks-guard.test.ts");

  await import("./injection-defense.test.ts");

  await import("./identity-filter.test.ts");

  const { turnSegmentsTestPromise } = await import("./turn-segments.test.ts");
  await turnSegmentsTestPromise;

  const { usageAccumulateTestPromise } = await import("./usage-accumulate.test.ts");
  await usageAccumulateTestPromise;

  const { financeCardsTestPromise } = await import("./finance-cards.test.ts");
  await financeCardsTestPromise;

  const { memoryStoreTestPromise } = await import("./memory-store.test.ts");
  await memoryStoreTestPromise;

  const { profileStoreTestPromise } = await import("./profile-store.test.ts");
  await profileStoreTestPromise;

  const { businessMetricsTestPromise } = await import("./business-metrics.test.ts");
  await businessMetricsTestPromise;

  const { moneyTestPromise } = await import("./money.test.ts");
  await moneyTestPromise;

  const { voucherReconcileTestPromise } = await import("./voucher-reconcile.test.ts");
  await voucherReconcileTestPromise;

  const { accountMappingTestPromise } = await import("./account-mapping.test.ts");
  await accountMappingTestPromise;

  const { askUserMultiTestPromise } = await import("./ask-user-multi.test.ts");
  await askUserMultiTestPromise;

  const { voucherSummaryTestPromise } = await import("./voucher-summary.test.ts");
  await voucherSummaryTestPromise;

  const { askUserMultiStateTestPromise } = await import("./ask-user-multi-state.test.ts");
  await askUserMultiStateTestPromise;

  const { voucherToolsTestPromise } = await import("./voucher-tools.test.ts");
  await voucherToolsTestPromise;

  const { voucherBuildTestPromise } = await import("./voucher-build.test.ts");
  await voucherBuildTestPromise;

  const { pdfOcrFallbackTestPromise } = await import("./pdf-ocr-fallback.test.ts");
  await pdfOcrFallbackTestPromise;

  const { folderIngestTestPromise } = await import("./folder-ingest.test.ts");
  await folderIngestTestPromise;

  const { voucherSheetTestPromise } = await import("./voucher-sheet.test.ts");
  await voucherSheetTestPromise;

  const { readDocumentTestPromise } = await import("./read-document.test.ts");
  await readDocumentTestPromise;

  const { voucherBatchTestPromise } = await import("./voucher-batch.test.ts");
  await voucherBatchTestPromise;

  const { slipGroupingTestPromise } = await import("./slip-grouping.test.ts");
  await slipGroupingTestPromise;

  const { scanSlipFolderTestPromise } = await import("./scan-slip-folder.test.ts");
  await scanSlipFolderTestPromise;

  const { knowledgeResultShapeTestPromise } = await import("./knowledge-result-shape.test.ts");
  await knowledgeResultShapeTestPromise;

  const { receiptTestPromise } = await import("./receipt.test.ts");
  await receiptTestPromise;

  const { taxCumulativeF2TestPromise } = await import("./tax-cumulative-f2.test.ts");
  await taxCumulativeF2TestPromise;

  const { reconciliationReceiptTestPromise } = await import("./reconciliation-receipt.test.ts");
  await reconciliationReceiptTestPromise;

  const { reimbursementReceiptTestPromise } = await import("./reimbursement-receipt.test.ts");
  await reimbursementReceiptTestPromise;

  const { financeToolsF3TestPromise } = await import("./finance-tools-f3.test.ts");
  await financeToolsF3TestPromise;

  const { cashObligationsTestPromise } = await import("./cash-obligations.test.ts");
  await cashObligationsTestPromise;

  const { businessAnalysisScriptTestPromise } = await import("./business-analysis-script.test.ts");
  await businessAnalysisScriptTestPromise;

  await import("./shortcuts.test.ts");
  await import("./shortcuts-wiring.test.ts");

  const { skillsCategoryTestPromise } = await import("./skills-category.test.ts");
  await skillsCategoryTestPromise;

  const { agentContextTestPromise } = await import("./agent-context.test.ts");
  await agentContextTestPromise;

  const { systemPromptTemplateTestPromise } = await import("./system-prompt-template.test.ts");
  await systemPromptTemplateTestPromise;

  const { mockAgentTestPromise } = await import("./mock-agent.test.ts");
  await mockAgentTestPromise;

  const { chatFeedbackTestPromise } = await import("./chat-feedback.test.ts");
  await chatFeedbackTestPromise;

  const { agentTraceWriteTestPromise } = await import("./agent-trace-write.test.ts");
  await agentTraceWriteTestPromise;

  const { apiBoundariesTestPromise } = await import("./api-boundaries.test.ts");
  await apiBoundariesTestPromise;

  const { localRequestTestPromise } = await import("./local-request.test.ts");
  await localRequestTestPromise;

  const { secretStoreTestPromise } = await import("./secret-store.test.ts");
  await secretStoreTestPromise;

  const { safetyRedactionTestPromise } = await import("./safety-redaction.test.ts");
  await safetyRedactionTestPromise;

  const { dataSafetyTestPromise } = await import("./data-safety.test.ts");
  await dataSafetyTestPromise;

  const { unifiedFileLibraryTestPromise } = await import("./unified-file-library.test.ts");
  await unifiedFileLibraryTestPromise;

  const { filesPromoteTestPromise } = await import("./files-promote.test.ts");
  await filesPromoteTestPromise;

  const { dedupCleanupTestPromise } = await import("./dedup-cleanup.test.ts");
  await dedupCleanupTestPromise;

  const { skillXlsxTestPromise } = await import("./skill-xlsx.test.ts");
  await skillXlsxTestPromise;

  const { skillPdfTestPromise } = await import("./skill-pdf.test.ts");
  await skillPdfTestPromise;

  const { skillDocxTestPromise } = await import("./skill-docx.test.ts");
  await skillDocxTestPromise;

  const { skillPptxTestPromise } = await import("./skill-pptx.test.ts");
  await skillPptxTestPromise;

  const { skillPluginTestPromise } = await import("./skill-plugin.test.ts");
  await skillPluginTestPromise;

  const { skillsStoreTestPromise } = await import("./skills-store.test.ts");
  await skillsStoreTestPromise;

  const { settingsRefactorTestPromise } = await import("./settings-refactor.test.ts");
  await settingsRefactorTestPromise;

  const { settingsSkillsRedesignTestPromise } = await import("./settings-skills-redesign.test.ts");
  await settingsSkillsRedesignTestPromise;

  const { overlayScrimTestPromise } = await import("./overlay-scrim.test.ts");
  await overlayScrimTestPromise;

  const { agentQueryHelpersTestPromise } = await import("./agent-query-helpers.test.ts");
  await agentQueryHelpersTestPromise;

  const { skillsFileTreeTestPromise } = await import("./skills-file-tree.test.ts");
  await skillsFileTreeTestPromise;

  const { telemetryInstallIdTestPromise } = await import("./telemetry-install-id.test.ts");
  await telemetryInstallIdTestPromise;

  const { telemetryProjectionTestPromise } = await import("./telemetry-projection.test.ts");
  await telemetryProjectionTestPromise;

  const { telemetryAppErrorsTestPromise } = await import("./telemetry-app-errors.test.ts");
  await telemetryAppErrorsTestPromise;

  const { financialRatiosV2TestPromise } = await import("./financial-ratios-v2.test.ts");
  await financialRatiosV2TestPromise;

  const { businessAnalysisV2TestPromise } = await import("./business-analysis-v2.test.ts");
  await businessAnalysisV2TestPromise;

  const { ocrImageTestPromise } = await import("./ocr-image.test.ts");
  await ocrImageTestPromise;

  await import("./content-format.test.ts");

  const { findMatchesTestPromise } = await import("./find-matches.test.ts");
  await findMatchesTestPromise;

  const { searchQueriesTestPromise } = await import("./search-queries.test.ts");
  await searchQueriesTestPromise;

  const { workerUtf8StdioTestPromise } = await import("./worker-utf8-stdio.test.ts");
  await workerUtf8StdioTestPromise;

  const { semaphoreTestPromise } = await import("./semaphore.test.ts");
  await semaphoreTestPromise;

  const { idempotencyTestPromise } = await import("./idempotency.test.ts");
  await idempotencyTestPromise;

  const { withApiErrorTestPromise } = await import("./with-api-error.test.ts");
  await withApiErrorTestPromise;

  const { accountingAdapterTestPromise } = await import("./accounting-adapter.test.ts");
  await accountingAdapterTestPromise;

  const { cleanupTestPromise } = await import("./cleanup.test.ts");
  await cleanupTestPromise;

  const { instrumentationWiringTestPromise } = await import("./instrumentation-wiring.test.ts");
  await instrumentationWiringTestPromise;

  const { retentionTestPromise } = await import("./retention.test.ts");
  await retentionTestPromise;

  const { retentionNewTablesTestPromise } = await import("./retention-new-tables.test.ts");
  await retentionNewTablesTestPromise;

  const { migrationV17TestPromise } = await import("./migration-v17.test.ts");
  await migrationV17TestPromise;

  const { attachmentGuardTestPromise } = await import("./attachment-guard.test.ts");
  await attachmentGuardTestPromise;

  const { localGuardTestPromise } = await import("./local-guard.test.ts");
  await localGuardTestPromise;

  const { diagnosticsExportTestPromise } = await import("./diagnostics-export.test.ts");
  await diagnosticsExportTestPromise;

  const { financeFileLinksTestPromise } = await import("./finance-file-links.test.ts");
  await financeFileLinksTestPromise;

  const { telemetryFeatureTestPromise } = await import("./telemetry-feature.test.ts");
  await telemetryFeatureTestPromise;

  const { smallUtilsTestPromise } = await import("./small-utils.test.ts");
  await smallUtilsTestPromise;

  const { mcpToolHandlersTestPromise } = await import("./mcp-tool-handlers.test.ts");
  await mcpToolHandlersTestPromise;

  const { runPythonToolTestPromise } = await import("./run-python-tool.test.ts");
  await runPythonToolTestPromise;

  const { subagentRunnerTestPromise } = await import("./subagent-runner.test.ts");
  await subagentRunnerTestPromise;

  const { trustTierTestPromise } = await import("./trust-tier.test.ts");
  await trustTierTestPromise;

  const { cockpitTokensTestPromise } = await import("./cockpit-tokens.test.ts");
  await cockpitTokensTestPromise;

  const { roleRegistryTestPromise } = await import("./role-registry.test.ts");
  await roleRegistryTestPromise;

  const { attentionTestPromise } = await import("./attention.test.ts");
  await attentionTestPromise;

  const { cockpitAttentionUiTestPromise } = await import("./cockpit-attention-ui.test.ts");
  await cockpitAttentionUiTestPromise;

  const { subagentDispatchesTestPromise } = await import("./subagent-dispatches.test.ts");
  await subagentDispatchesTestPromise;

  const { cockpitRecentWorkTestPromise } = await import("./cockpit-recent-work.test.ts");
  await cockpitRecentWorkTestPromise;

  const { businessMetricsSourceTestPromise } = await import("./business-metrics-source.test.ts");
  await businessMetricsSourceTestPromise;

  const { teamPanelTestPromise } = await import("./team-panel.test.ts");
  await teamPanelTestPromise;

  const { cockpitV3SlimTestPromise } = await import("./cockpit-v3-slim.test.ts");
  await cockpitV3SlimTestPromise;

  const { navV3TestPromise } = await import("./nav-v3.test.ts");
  await navV3TestPromise;

  const { agentsSpaceTestPromise } = await import("./agents-space.test.ts");
  await agentsSpaceTestPromise;

  const { agentRoleToggleTestPromise } = await import("./agent-role-toggle.test.ts");
  await agentRoleToggleTestPromise;

  const { cockpitTeamExpandTestPromise } = await import("./cockpit-team-expand.test.ts");
  await cockpitTeamExpandTestPromise;

  const { chatFloatTestPromise } = await import("./chat-float.test.ts");
  await chatFloatTestPromise;

  const { cockpitTickerTestPromise } = await import("./cockpit-ticker.test.ts");
  await cockpitTickerTestPromise;

  const { attachmentCardTestPromise } = await import("./attachment-card.test.ts");
  await attachmentCardTestPromise;

  const { voucherBuildIncomeTestPromise } = await import("./voucher-build-income.test.ts");
  await voucherBuildIncomeTestPromise;

  const { voucherDimensionValidateTestPromise } = await import("./voucher-dimension-validate.test.ts");
  await voucherDimensionValidateTestPromise;

  const { exportVoucherListTestPromise } = await import("./export-voucher-list.test.ts");
  await exportVoucherListTestPromise;

  const { knowledgeMcpFixesTestPromise } = await import("./knowledge-mcp-fixes.test.ts");
  await knowledgeMcpFixesTestPromise;

  const { docCacheTestPromise } = await import("./doc-cache.test.ts");
  await docCacheTestPromise;

  const { routerContinuationTestPromise } = await import("./router-continuation.test.ts");
  await routerContinuationTestPromise;

  const { rendererVoucherFixesTestPromise } = await import("./renderer-voucher-fixes.test.ts");
  await rendererVoucherFixesTestPromise;

  const { flagsDbOverrideTestPromise } = await import("./flags-db-override.test.ts");
  await flagsDbOverrideTestPromise;

  const { chatProcessRenderersTestPromise } = await import("./chat-process-renderers.test.ts");
  await chatProcessRenderersTestPromise;

  const { errorDetailTestPromise } = await import("./error-detail.test.ts");
  await errorDetailTestPromise;

  const { stepAggregateTestPromise, summarizeToolSegmentTestPromise } = await import("./step-aggregate.test.ts");
  await stepAggregateTestPromise;
  await summarizeToolSegmentTestPromise;

  const { toolCallStepUiTestPromise } = await import("./tool-call-step-ui.test.ts");
  await toolCallStepUiTestPromise;

  const { chatProcessPolishTestPromise } = await import("./chat-process-polish.test.ts");
  await chatProcessPolishTestPromise;

  const { confirmGateTestPromise } = await import("./confirm-gate.test.ts");
  await confirmGateTestPromise;

  const { subagentTransparencyTestPromise } = await import("./subagent-transparency.test.ts");
  await subagentTransparencyTestPromise;

  const { confirmGateFixTestPromise } = await import("./confirm-gate-fix.test.ts");
  await confirmGateFixTestPromise;

  const { payrollDiffTestPromise } = await import("./payroll-diff.test.ts");
  await payrollDiffTestPromise;

  const { payslipExportTestPromise } = await import("./payslip-export.test.ts");
  await payslipExportTestPromise;

  const { subagentResultShapeTestPromise } = await import("./subagent-result-shape.test.ts");
  await subagentResultShapeTestPromise;

  const { agentBoardTestPromise } = await import("./agent-board.test.ts");
  await agentBoardTestPromise;

  const { resizablePreviewPanelTestPromise } = await import("./resizable-preview-panel.test.ts");
  await resizablePreviewPanelTestPromise;

  const { dbMigrationDisciplineTestPromise } = await import("./db-migration-discipline.test.ts");
  await dbMigrationDisciplineTestPromise;

  const { dbFactsMigrationTestPromise } = await import("./db-facts-migration.test.ts");
  await dbFactsMigrationTestPromise;

  const { surfaceVariantsTestPromise } = await import("./ui/surface-variants.test.ts");
  await surfaceVariantsTestPromise;

  const { eslintAppearanceGuardTestPromise } = await import("./ui/eslint-appearance-guard.test.ts");
  await eslintAppearanceGuardTestPromise;

  const { policyRulesTestPromise } = await import("./policy-rules.test.ts");
  await policyRulesTestPromise;

  const { agentAttachmentsJsonTestPromise } = await import("./agent-attachments-json.test.ts");
  await agentAttachmentsJsonTestPromise;

  const { attentionPrecheckTestPromise } = await import("./attention-precheck.test.ts");
  await attentionPrecheckTestPromise;

  const { windowsHardeningTestPromise } = await import("./windows-hardening.test.ts");
  await windowsHardeningTestPromise;

  const { obligationsLiveTestPromise } = await import("./obligations-live.test.ts");
  await obligationsLiveTestPromise;

  const { confirmContractChainTestPromise } = await import("./confirm-contract-chain.test.ts");
  await confirmContractChainTestPromise;

  const { invoiceWritePathTestPromise } = await import("./invoice-write-path.test.ts");
  await invoiceWritePathTestPromise;

  const { receivablesLiveTestPromise } = await import("./receivables-live.test.ts");
  await receivablesLiveTestPromise;

  const { parseCorpusTestPromise } = await import("./parse-corpus.test.ts");
  await parseCorpusTestPromise;

  const { queryStagesTestPromise } = await import("./query-stages.test.ts");
  await queryStagesTestPromise;

  const { artifactChecklistTestPromise } = await import("./artifact-checklist.test.ts");
  await artifactChecklistTestPromise;

  const { taskTemplatesTestPromise } = await import("./task-templates.test.ts");
  await taskTemplatesTestPromise;

  const { taskBoardTestPromise } = await import("./task-board.test.ts");
  await taskBoardTestPromise;

  const { filingPrecheckBatchTestPromise } = await import("./filing-precheck-batch.test.ts");
  await filingPrecheckBatchTestPromise;

  const { bankReconBatchTestPromise } = await import("./bank-recon-batch.test.ts");
  await bankReconBatchTestPromise;
  const { semanticSearchTestPromise } = await import("./semantic-search.test.ts");
  await semanticSearchTestPromise;

  const { auditUndoTestPromise } = await import("./audit-undo.test.ts");
  await auditUndoTestPromise;

  const { salesInvoicesTestPromise } = await import("./sales-invoices.test.ts");
  await salesInvoicesTestPromise;

  const { receiptStoreTestPromise } = await import("./receipt-store.test.ts");
  await receiptStoreTestPromise;

  const { relativeTimeTestPromise } = await import("./relative-time.test.ts");
  await relativeTimeTestPromise;

  const { suppressLockTestPromise } = await import("./ui/suppress-lock.test.ts");
  await suppressLockTestPromise;

})().catch((err) => {
  console.error("[all.test] 测试链失败:", err);
  process.exitCode = 1;
});
