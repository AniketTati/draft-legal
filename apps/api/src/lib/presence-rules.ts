/**
 * What runs once a version's analysis is stamped (lib/analysis-trigger.ts
 * finishAnalysis). docs/41 P0.3 adds the presence check here.
 */
export async function afterAnalysis(_contractId: string, _versionId: string): Promise<void> {}
