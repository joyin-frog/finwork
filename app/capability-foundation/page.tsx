import { getDb } from "@/lib/db/sqlite";
import { getFoundationManagementSnapshot } from "@/lib/observability/foundation-read-model";
import { FoundationManagementView } from "./foundation-management-view";

export const dynamic = "force-dynamic";

export default function CapabilityFoundationPage() {
  return <FoundationManagementView snapshot={getFoundationManagementSnapshot(getDb())} />;
}
